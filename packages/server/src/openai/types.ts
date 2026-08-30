// Hand-rolled OpenAI chat-completions types (no runtime dependency).
// Only the fields this server reads/emit are modeled.

import type { ClaudeEffort } from '../claude/effort.ts'

export type ChatMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ChatToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | ChatMessageContentPart[] | null
  name?: string
  tool_call_id?: string
  tool_calls?: ChatToolCall[]
  /** non-standard extension, forwarded as tool_result is_error */
  is_error?: boolean
}

export type ChatTool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export type ChatToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function?: { name?: string } }

export type ChatCompletionRequest = {
  model: string
  messages: ChatMessage[]
  tools?: ChatTool[]
  tool_choice?: ChatToolChoice
  parallel_tool_calls?: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string | string[]
  /** OpenAI-compatible per-request override for Anthropic output_config.effort. */
  reasoning_effort?: ClaudeEffort | null
  stream?: boolean
  user?: string
}

export type ChatCompletionUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export type ChatCompletionMessage = {
  role: 'assistant'
  content: string | null
  reasoning_content?: string
  tool_calls?: ChatToolCall[]
}

export type ChatCompletion = {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: {
    index: number
    message: ChatCompletionMessage
    finish_reason: string | null
  }[]
  usage: ChatCompletionUsage
}

export type ChatCompletionChunk = {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: {
    index: number
    delta: {
      role?: 'assistant'
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: {
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason: string | null
  }[]
  usage?: ChatCompletionUsage
}

export type OpenAIError = {
  error: {
    message: string
    type: string
    code?: string
  }
}

export type OpenAIModel = {
  id: string
  object: 'model'
  created: number
  owned_by: 'anthropic'
}

export type OpenAIModelList = {
  object: 'list'
  data: OpenAIModel[]
}

export class BadRequestError extends Error {}
