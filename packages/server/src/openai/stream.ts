import type { AnthropicUsage } from './translate.ts'
import {
  blocksToChatCompletion,
  mapFinishReason,
  mapUsage,
} from './translate.ts'
import type {
  ChatCompletion,
  ChatCompletionChunk,
  OpenAIError,
} from './types.ts'

// ---------------------------------------------------------------------------
// Anthropic SSE event shapes (loose — only what we consume)

export type AnthropicEvent =
  | {
      type: 'message_start'
      message: { id: string; model: string; usage?: AnthropicUsage }
    }
  | {
      type: 'content_block_start'
      index: number
      content_block: {
        type: 'text' | 'thinking' | 'tool_use'
        id?: string
        name?: string
      }
    }
  | {
      type: 'content_block_delta'
      index: number
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'signature_delta'; signature: string }
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta'
      delta: { stop_reason: string | null }
      usage?: AnthropicUsage
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } }

// ---------------------------------------------------------------------------
// SSE parsing

async function* bodyLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const cancelReader = () => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  if (signal?.aborted) cancelReader()
  else signal?.addEventListener('abort', cancelReader, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        yield buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
    }
    if (buffer) yield buffer
  } finally {
    signal?.removeEventListener('abort', cancelReader)
    reader.releaseLock()
  }
}

/**
 * Parse Anthropic SSE into events. Tolerates both `event:`/`data:` framing
 * and bare JSON lines; ignores comments and blank lines. Malformed JSON
 * data lines are skipped (upstream occasionally emits keep-alive noise).
 */
export async function* parseAnthropicSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<AnthropicEvent> {
  let data = ''
  for await (const rawLine of bodyLines(body, signal)) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.trim()) {
      if (data) {
        const parsed = parseEventData(data)
        if (parsed) yield parsed
        data = ''
      }
      continue
    }
    if (line.startsWith(':') || line.startsWith('event:')) continue
    if (line.startsWith('data:')) {
      data += (data ? '\n' : '') + line.slice(5).trimStart()
      continue
    }
    // JSON-only line without SSE framing
    const parsed = parseEventData(line)
    if (parsed) yield parsed
  }
  if (data) {
    const parsed = parseEventData(data)
    if (parsed) yield parsed
  }
}

function parseEventData(data: string): AnthropicEvent | null {
  try {
    return JSON.parse(data) as AnthropicEvent
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Event → OpenAI chunk translation

export class StreamState {
  id = 'chatcmpl-unknown'
  model = 'claude'
  /** Anthropic content-block index → OpenAI tool_calls array index */
  private toolIndexByBlock = new Map<number, number>()
  private toolCount = 0

  toolIndex(blockIndex: number): number {
    let idx = this.toolIndexByBlock.get(blockIndex)
    if (idx === undefined) {
      idx = this.toolCount++
      this.toolIndexByBlock.set(blockIndex, idx)
    }
    return idx
  }
}

function chunk(
  state: StreamState,
  delta: ChatCompletionChunk['choices'][number]['delta'],
  finishReason: string | null = null,
  usage?: ChatCompletionChunk['usage'],
): ChatCompletionChunk {
  return {
    id: state.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage && { usage }),
  }
}

export function eventToChunk(
  event: AnthropicEvent,
  state: StreamState,
): ChatCompletionChunk | null {
  switch (event.type) {
    case 'message_start':
      state.id = event.message.id
      state.model = event.message.model
      return chunk(state, { role: 'assistant' })

    case 'content_block_start':
      if (event.content_block.type === 'tool_use') {
        const index = state.toolIndex(event.index)
        return chunk(state, {
          tool_calls: [
            {
              index,
              id: event.content_block.id,
              type: 'function',
              function: { name: event.content_block.name, arguments: '' },
            },
          ],
        })
      }
      return null

    case 'content_block_delta': {
      const delta = event.delta
      if (delta.type === 'text_delta') {
        return delta.text ? chunk(state, { content: delta.text }) : null
      }
      if (delta.type === 'thinking_delta') {
        return delta.thinking
          ? chunk(state, { reasoning_content: delta.thinking })
          : null
      }
      if (delta.type === 'input_json_delta') {
        return chunk(state, {
          tool_calls: [
            {
              index: state.toolIndex(event.index),
              function: { arguments: delta.partial_json },
            },
          ],
        })
      }
      // signature_delta and unknown deltas are ignored
      return null
    }

    case 'message_delta':
      return chunk(
        state,
        {},
        mapFinishReason(event.delta.stop_reason),
        event.usage ? mapUsage(event.usage) : undefined,
      )

    default:
      // content_block_stop, message_stop, ping → no OpenAI equivalent
      return null
  }
}

// ---------------------------------------------------------------------------
// Accumulating collector (non-stream OpenAI responses)

type AccumulatedBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; arguments: string }

export class CompletionCollector {
  private blocks = new Map<number, AccumulatedBlock>()
  private state = new StreamState()
  private usage: AnthropicUsage | undefined
  private stopReason: string | null = null

  add(event: AnthropicEvent): void {
    switch (event.type) {
      case 'message_start':
        this.state.id = event.message.id
        this.state.model = event.message.model
        break
      case 'content_block_start': {
        const cb = event.content_block
        if (cb.type === 'tool_use') {
          this.blocks.set(event.index, {
            kind: 'tool_use',
            id: cb.id ?? '',
            name: cb.name ?? '',
            arguments: '',
          })
          this.state.toolIndex(event.index)
        } else {
          this.blocks.set(event.index, {
            kind: cb.type === 'thinking' ? 'thinking' : 'text',
            text: '',
          })
        }
        break
      }
      case 'content_block_delta': {
        const block = this.blocks.get(event.index)
        const delta = event.delta
        if (!block) break
        if (block.kind === 'text' && delta.type === 'text_delta') {
          block.text += delta.text
        } else if (
          block.kind === 'thinking' &&
          delta.type === 'thinking_delta'
        ) {
          block.text += delta.thinking
        } else if (
          block.kind === 'tool_use' &&
          delta.type === 'input_json_delta'
        ) {
          block.arguments += delta.partial_json
        }
        break
      }
      case 'message_delta':
        this.stopReason = event.delta.stop_reason
        if (event.usage) this.usage = event.usage
        break
    }
  }

  toChatCompletion(): ChatCompletion {
    const blocks = [...this.blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]) => {
        if (block.kind === 'tool_use') {
          let input: unknown = {}
          try {
            input = JSON.parse(block.arguments || '{}')
          } catch {
            // leave {} if upstream sent malformed fragments
          }
          return {
            type: 'tool_use' as const,
            id: block.id,
            name: block.name,
            input,
          }
        }
        if (block.kind === 'thinking') {
          return { type: 'thinking' as const, thinking: block.text }
        }
        return { type: 'text' as const, text: block.text }
      })

    return blocksToChatCompletion(blocks, {
      id: this.state.id,
      model: this.state.model,
      usage: this.usage,
      stopReason: this.stopReason,
    })
  }
}

// ---------------------------------------------------------------------------
// Pipelines

function toOpenAIError(error: { type: string; message: string }): OpenAIError {
  return {
    error: {
      message: error.message,
      type: error.type,
      code: error.type,
    },
  }
}

/** Stream mode: Anthropic SSE body → OpenAI SSE chunk stream. */
export function translateToOpenAISSE(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const abortController = new AbortController()
  const events = parseAnthropicSSE(upstream, abortController.signal)
  const state = new StreamState()
  let cancelled = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: string) => {
        if (!cancelled) controller.enqueue(encoder.encode(value))
      }
      try {
        for await (const event of events) {
          if (event.type === 'error') {
            send(`data: ${JSON.stringify(toOpenAIError(event.error))}\n\n`)
            break
          }
          const out = eventToChunk(event, state)
          if (out) send(`data: ${JSON.stringify(out)}\n\n`)
        }
        send('data: [DONE]\n\n')
      } catch (error) {
        if (!cancelled) {
          send(
            `data: ${JSON.stringify({
              error: {
                message: error instanceof Error ? error.message : String(error),
                type: 'server_error',
              },
            })}\n\n`,
          )
        }
      } finally {
        if (!cancelled) controller.close()
      }
    },
    cancel(reason) {
      cancelled = true
      abortController.abort(reason)
    },
  })
}

/** Non-stream mode: Anthropic SSE body → accumulated chat.completion. */
export async function collectChatCompletion(
  upstream: ReadableStream<Uint8Array>,
): Promise<ChatCompletion | OpenAIError> {
  const collector = new CompletionCollector()
  for await (const event of parseAnthropicSSE(upstream)) {
    if (event.type === 'error') return toOpenAIError(event.error)
    collector.add(event)
  }
  return collector.toChatCompletion()
}
