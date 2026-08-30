import {
  CLAUDE_EFFORT_DESCRIPTION,
  type ClaudeEffort,
  isClaudeEffort,
} from '../claude/effort.ts'
import type { SystemBlock } from '../claude/wire.ts'
import { buildClaudeSystem } from '../claude/wire.ts'
import type { ServerConfig } from '../config.ts'
import {
  BadRequestError,
  type ChatCompletion,
  type ChatCompletionRequest,
  type ChatCompletionUsage,
  type ChatMessage,
  type ChatToolCall,
} from './types.ts'

// ---------------------------------------------------------------------------
// Anthropic-side shapes (loose — only what we construct/consume)

export type AnthropicTextBlock = {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral'; ttl: '1h' }
}

export type AnthropicImageBlock = {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

export type AnthropicThinkingBlock = {
  type: 'thinking'
  thinking: string
  signature?: string
}

export type AnthropicToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export type AnthropicToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

export type AnthropicMessage = {
  role: 'user' | 'assistant' | 'system'
  content: AnthropicContentBlock[]
}

export type AnthropicUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens_details?: { thinking_tokens?: number }
}

export const DEFAULT_MAX_TOKENS = 64000

const mapFinishReason = (stopReason: string | null): string => {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
      return 'length'
    default:
      return 'stop'
  }
}

// ---------------------------------------------------------------------------
// OpenAI → Anthropic

type TranslateContext = {
  config: Pick<ServerConfig, 'modelAllowlist' | 'ccVersion' | 'effort'>
  deviceId: string
  accountUuid: string
  sessionId: string
}

function textOf(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n\n')
  }
  return ''
}

function userContentBlocks(message: ChatMessage): AnthropicContentBlock[] {
  if (typeof message.content === 'string') {
    return [{ type: 'text', text: message.content }]
  }
  if (!Array.isArray(message.content)) {
    return [{ type: 'text', text: '' }]
  }
  return message.content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text } as AnthropicContentBlock
    }
    // Only data: URLs are supported — fetching remote images would leak
    // request context to arbitrary hosts.
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url.url)
    if (!match) {
      throw new BadRequestError(
        'image_url parts must be base64 data: URLs (remote image fetching is not supported)',
      )
    }
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: match[1],
        data: match[2],
      },
    } as AnthropicImageBlock
  })
}

function toolCallToToolUse(call: ChatToolCall): AnthropicToolUseBlock {
  let input: unknown
  try {
    input = JSON.parse(call.function.arguments || '{}')
  } catch {
    throw new BadRequestError(
      `tool call ${call.id} has invalid JSON arguments for ${call.function.name}`,
    )
  }
  return {
    type: 'tool_use',
    id: call.id,
    name: call.function.name,
    input,
  }
}

function translateMessages(messages: ChatMessage[]): {
  systemPrompt: string | undefined
  messages: AnthropicMessage[]
} {
  const systemParts: string[] = []
  const out: AnthropicMessage[] = []

  let seenNonSystem = false
  let midSystemSectionOpen = false
  let pendingToolResults: AnthropicToolResultBlock[] | null = null

  const flushToolResults = () => {
    if (pendingToolResults) {
      out.push({ role: 'user', content: pendingToolResults })
      pendingToolResults = null
    }
  }

  for (const message of messages) {
    const role: unknown = (message as { role?: unknown } | null)?.role
    if (!['system', 'user', 'assistant', 'tool'].includes(String(role))) {
      throw new BadRequestError(`unsupported message role: ${String(role)}`)
    }

    if (role === 'system') {
      flushToolResults()
      const text = textOf(message)
      if (!seenNonSystem) {
        systemParts.push(text)
      } else {
        if (!midSystemSectionOpen && out.at(-1)?.role !== 'user') {
          throw new BadRequestError(
            'mid-conversation system messages must immediately follow a user turn',
          )
        }
        // Mid-conversation system messages ride the
        // mid-conversation-system-2026-04-07 beta (observed in the trace).
        out.push({
          role: 'system',
          content: [
            {
              type: 'text',
              text,
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
        })
        midSystemSectionOpen = true
      }
      continue
    }

    seenNonSystem = true

    if (midSystemSectionOpen) {
      if (role !== 'assistant') {
        throw new BadRequestError(
          'mid-conversation system messages must be final or immediately followed by an assistant turn',
        )
      }
      midSystemSectionOpen = false
    }

    if (role === 'tool') {
      if (!message.tool_call_id) {
        throw new BadRequestError('tool messages must include tool_call_id')
      }
      pendingToolResults ??= []
      const block: AnthropicToolResultBlock = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content:
          typeof message.content === 'string'
            ? message.content
            : textOf(message),
      }
      if (message.is_error !== undefined) block.is_error = message.is_error
      pendingToolResults.push(block)
      continue
    }

    flushToolResults()

    if (role === 'user') {
      out.push({ role: 'user', content: userContentBlocks(message) })
      continue
    }

    // assistant
    const blocks: AnthropicContentBlock[] = []
    const text = textOf(message)
    if (text) blocks.push({ type: 'text', text })
    for (const call of message.tool_calls ?? []) {
      blocks.push(toolCallToToolUse(call))
    }
    if (blocks.length === 0) {
      blocks.push({ type: 'text', text: '' })
    }
    out.push({ role: 'assistant', content: blocks })
  }

  flushToolResults()

  return {
    systemPrompt: systemParts.length ? systemParts.join('\n\n') : undefined,
    messages: out,
  }
}

export type ClaudeRequestBody = {
  model: string
  system: SystemBlock[]
  messages: AnthropicMessage[]
  tools?: { name: string; description?: string; input_schema?: unknown }[]
  tool_choice?: { type: 'auto' | 'none' | 'any' | 'tool'; name?: string }
  disable_parallel_tool_use?: boolean
  temperature?: number
  top_p?: number
  max_tokens: number
  stop_sequences?: string[]
  thinking: { type: 'adaptive'; display: 'omitted' }
  output_config: { effort: ClaudeEffort }
  metadata: { user_id: string }
  stream: true
}

export function toAnthropicBody(
  req: ChatCompletionRequest,
  ctx: TranslateContext,
): ClaudeRequestBody {
  if (typeof req.model !== 'string' || !req.model.trim()) {
    throw new BadRequestError('model must be a non-empty string')
  }
  if (
    ctx.config.modelAllowlist !== null &&
    !ctx.config.modelAllowlist.includes(req.model)
  ) {
    throw new BadRequestError(
      `unknown model: ${req.model} (available: ${ctx.config.modelAllowlist.join(', ')})`,
    )
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new BadRequestError('messages must be a non-empty array')
  }
  const effort = req.reasoning_effort ?? ctx.config.effort
  if (!isClaudeEffort(effort)) {
    throw new BadRequestError(
      `reasoning_effort must be one of: ${CLAUDE_EFFORT_DESCRIPTION}`,
    )
  }

  const { systemPrompt, messages } = translateMessages(req.messages)

  const body: ClaudeRequestBody = {
    model: req.model,
    system: buildClaudeSystem(systemPrompt, ctx.config.ccVersion),
    messages,
    max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
    // Traced defaults (claude 2.1.236)
    thinking: { type: 'adaptive', display: 'omitted' },
    output_config: { effort },
    metadata: {
      user_id: JSON.stringify({
        device_id: ctx.deviceId,
        account_uuid: ctx.accountUuid,
        session_id: ctx.sessionId,
      }),
    },
    stream: true,
  }

  if (req.tools?.length) {
    body.tools = req.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters ?? { type: 'object' },
    }))
  }

  if (req.tool_choice !== undefined) {
    const choice = req.tool_choice
    if (typeof choice === 'string') {
      body.tool_choice = {
        none: { type: 'none' },
        auto: { type: 'auto' },
        required: { type: 'any' },
      }[choice] as ClaudeRequestBody['tool_choice']
    } else if (choice?.type === 'function') {
      body.tool_choice = { type: 'tool', name: choice.function?.name ?? '' }
    }
  }

  if (req.parallel_tool_calls === false) {
    body.disable_parallel_tool_use = true
  }

  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.top_p !== undefined) body.top_p = req.top_p
  if (req.stop !== undefined) {
    body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop]
  }

  return body
}

// ---------------------------------------------------------------------------
// Anthropic blocks → OpenAI (non-stream accumulation / shared helpers)

export function mapUsage(
  usage: AnthropicUsage | undefined,
): ChatCompletionUsage {
  const uncachedInputTokens = usage?.input_tokens ?? 0
  const cacheCreationTokens = usage?.cache_creation_input_tokens ?? 0
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0
  const promptTokens =
    uncachedInputTokens + cacheCreationTokens + cacheReadTokens
  const completionTokens = usage?.output_tokens ?? 0

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: cacheReadTokens,
    },
    completion_tokens_details: {
      reasoning_tokens: usage?.output_tokens_details?.thinking_tokens ?? 0,
    },
  }
}

export { mapFinishReason }

export function blocksToChatCompletion(
  blocks: AnthropicContentBlock[],
  opts: {
    id: string
    model: string
    usage?: AnthropicUsage
    stopReason: string | null
  },
): ChatCompletion {
  let content = ''
  let reasoning = ''
  const toolCalls: ChatToolCall[] = []

  for (const block of blocks) {
    if (block.type === 'text') content += block.text
    else if (block.type === 'thinking') reasoning += block.thinking
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      })
    }
  }

  const message: ChatCompletion['choices'][number]['message'] = {
    role: 'assistant',
    content: content || null,
  }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls

  return {
    id: opts.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishReason(opts.stopReason),
      },
    ],
    usage: mapUsage(opts.usage),
  }
}
