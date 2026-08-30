import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  CompletionCollector,
  collectChatCompletion,
  eventToChunk,
  parseAnthropicSSE,
  StreamState,
  translateToOpenAISSE,
} from '../src/openai/stream.ts'
import type { ChatCompletionChunk } from '../src/openai/types.ts'

const TEXT_FIXTURE = new URL('./fixtures/text-res.sse', import.meta.url)
const TOOL_FIXTURE = new URL('./fixtures/tool-use-res.sse', import.meta.url)

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>
}

function bodyOf(path: URL): ReadableStream<Uint8Array> {
  return streamOf(readFileSync(path, 'utf8'))
}

function parseChunks(sse: string): (ChatCompletionChunk | { error: object })[] {
  return sse
    .split('\n')
    .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map((l) => JSON.parse(l.slice(6)))
}

const EXPECTED_TEXT =
  'The first heading is:\n\n```\n# OpenCode Anthropic Auth Plugin\n```' +
  '\n\nOne note: you asked for the Read tool, but this session has a standing' +
  ' directive to route file reads through Bash where it can do the job, so I' +
  ' used `head -20` instead. Same content either way.'

const EXPECTED_TOOL_ARGS = {
  command:
    'head -20 /Users/REDACTED/experiments/opencode-anthropic-auth/README.md',
  description: 'Show first lines of README.md',
}

describe('parseAnthropicSSE', () => {
  test('parses framed events from the text fixture', async () => {
    const events = []
    for await (const event of parseAnthropicSSE(bodyOf(TEXT_FIXTURE))) {
      events.push(event)
    }
    expect(events[0]!.type).toBe('message_start')
    expect(events.some((e) => e.type === 'ping')).toBe(true)
    expect(events.at(-1)?.type).toBe('message_stop')
  })
})

describe('text stream (trace-05)', () => {
  test('produces role → content deltas → stop chunk with usage', async () => {
    const chunks: ChatCompletionChunk[] = []
    const state = new StreamState()
    for await (const event of parseAnthropicSSE(bodyOf(TEXT_FIXTURE))) {
      const out = eventToChunk(event, state)
      if (out) chunks.push(out)
    }

    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: 'assistant' })
    expect(chunks[0]!.id).toBe('msg_REDACTED')

    const content = chunks
      .map((c) => c.choices[0]!.delta.content ?? '')
      .join('')
    expect(content).toBe(EXPECTED_TEXT)

    const final = chunks.at(-1)
    expect(final?.choices[0]?.finish_reason).toBe('stop')
    expect(final?.usage).toEqual({
      prompt_tokens: 154827,
      completion_tokens: 87,
      total_tokens: 154914,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    })
  })

  test('downstream cancellation cancels the upstream reader', async () => {
    const encoder = new TextEncoder()
    let cancelledWith: unknown
    let resolveCancelled: (() => void) | undefined
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve
    })
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: message_start\n' +
              'data: {"type":"message_start","message":{"id":"msg_cancel","model":"claude-opus-5"}}\n\n',
          ),
        )
      },
      cancel(reason) {
        cancelledWith = reason
        resolveCancelled?.()
      },
    })

    const reader = translateToOpenAISSE(upstream).getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    await reader.cancel('client disconnected')
    await Promise.race([
      cancelled,
      Bun.sleep(250).then(() => {
        throw new Error('upstream cancellation timed out')
      }),
    ])
    expect(cancelledWith).toBe('client disconnected')
  })

  test('translateToOpenAISSE emits a well-formed SSE stream ending in [DONE]', async () => {
    const text = await new Response(
      translateToOpenAISSE(bodyOf(TEXT_FIXTURE)) as ReadableStream,
    ).text()
    const chunks = parseChunks(text)
    expect(chunks.at(-1)).toMatchObject({
      object: 'chat.completion.chunk',
      choices: [{ finish_reason: 'stop' }],
    })
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        expect(() => JSON.parse(line.slice(6))).not.toThrow()
      }
    }
  })

  test('collector assembles a non-stream chat.completion', async () => {
    const result = await collectChatCompletion(bodyOf(TEXT_FIXTURE))
    expect(result).toMatchObject({
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: EXPECTED_TEXT },
          finish_reason: 'stop',
        },
      ],
    })
    expect('error' in result && result).toBeFalsy()
  })
})

describe('tool-use stream (trace-04)', () => {
  test('thinking → reasoning_content, tool fragments → tool_calls, stop_reason tool_calls', async () => {
    const chunks: ChatCompletionChunk[] = []
    const state = new StreamState()
    for await (const event of parseAnthropicSSE(bodyOf(TOOL_FIXTURE))) {
      const out = eventToChunk(event, state)
      if (out) chunks.push(out)
    }

    const reasoning = chunks
      .map((c) => c.choices[0]!.delta.reasoning_content ?? '')
      .join('')
    expect(reasoning).toBe('I will read the README.')

    const toolChunks = chunks.filter((c) => c.choices[0]!.delta.tool_calls)
    expect(toolChunks[0]!.choices[0]!.delta.tool_calls).toEqual([
      {
        index: 0,
        id: 'toolu_REDACTED',
        type: 'function',
        function: { name: 'Bash', arguments: '' },
      },
    ])
    const arguments_ = toolChunks
      .slice(1)
      .map(
        (c) => c.choices[0]!.delta.tool_calls?.[0]?.function?.arguments ?? '',
      )
      .join('')
    expect(JSON.parse(arguments_)).toEqual(EXPECTED_TOOL_ARGS)

    const final = chunks.at(-1)
    expect(final?.choices[0]?.finish_reason).toBe('tool_calls')
    expect(final?.usage?.completion_tokens).toBe(567)
  })

  test('collector assembles tool_calls from fragments', async () => {
    const result = await collectChatCompletion(bodyOf(TOOL_FIXTURE))
    if ('error' in result) throw new Error('unexpected error result')
    expect(result.choices[0]!.finish_reason).toBe('tool_calls')
    expect(result.choices[0]!.message.content).toBeNull()
    expect(result.choices[0]!.message.reasoning_content).toBe(
      'I will read the README.',
    )
    expect(result.choices[0]!.message.tool_calls).toEqual([
      {
        id: 'toolu_REDACTED',
        type: 'function',
        function: {
          name: 'Bash',
          arguments: JSON.stringify(EXPECTED_TOOL_ARGS),
        },
      },
    ])
  })

  test('empty thinking and signature deltas emit no chunks', async () => {
    const collector = new CompletionCollector()
    for await (const event of parseAnthropicSSE(bodyOf(TOOL_FIXTURE))) {
      collector.add(event)
    }
    const result = collector.toChatCompletion()
    // reasoning comes only from the non-empty thinking delta
    expect(result.choices[0]!.message.reasoning_content).toBe(
      'I will read the README.',
    )
  })
})

describe('error events', () => {
  test('upstream error event becomes an OpenAI error', async () => {
    const sse =
      'event: error\n' +
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
    const result = await collectChatCompletion(streamOf(sse))
    expect(result).toEqual({
      error: {
        message: 'Overloaded',
        type: 'overloaded_error',
        code: 'overloaded_error',
      },
    })
  })

  test('stream mode emits error JSON then [DONE]', async () => {
    const sse =
      'event: error\n' +
      'data: {"type":"error","error":{"type":"permission_error","message":"Nope"}}\n\n'
    const text = await new Response(
      translateToOpenAISSE(streamOf(sse)) as ReadableStream,
    ).text()
    expect(text).toContain('"error"')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })
})
