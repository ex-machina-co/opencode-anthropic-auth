import { createHash, randomBytes } from 'node:crypto'
import {
  CCH_POSITIONS,
  CCH_SALT,
  CLAUDE_CODE_IDENTITY,
  CLAUDE_CODE_VERSION,
  OPENCODE_IDENTITY,
  REQUIRED_BETAS,
  TOOL_PREFIX, USER_AGENT,
} from './constants'

export type FetchInput = string | URL | Request

/**
 * Merge headers from a Request object and/or a RequestInit headers value
 * into a single Headers instance.
 */
export function mergeHeaders(input: FetchInput, init?: RequestInit): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  const initHeaders = init?.headers
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers.set(key, value)
      })
    } else if (Array.isArray(initHeaders)) {
      for (const entry of initHeaders) {
        const [key, value] = entry as [string, string]
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    }
  }

  return headers
}

/**
 * Merge incoming beta headers with the required OAuth betas, deduplicating.
 */
export function mergeBetaHeaders(headers: Headers): string {
  const incomingBeta = headers.get('anthropic-beta') || ''
  const incomingBetasList = incomingBeta
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)

  return [...new Set([...REQUIRED_BETAS, ...incomingBetasList])].join(',')
}

/**
 * Set OAuth-required headers on the request: authorization, beta, user-agent.
 * Removes x-api-key since we're using OAuth.
 */
export function setOAuthHeaders(
  headers: Headers,
  accessToken: string,
): Headers {
  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('anthropic-beta', mergeBetaHeaders(headers))
  headers.set('user-agent', USER_AGENT)
  headers.delete('x-api-key')
  return headers
}

/**
 * Add TOOL_PREFIX to tool names in the request body.
 * Prefixes both tool definitions and tool_use blocks in messages.
 */
export function prefixToolNames(body: string): string {
  try {
    const parsed = JSON.parse(body)

    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map(
        (tool: { name?: string; [k: string]: unknown }) => ({
          ...tool,
          name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
        }),
      )
    }

    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map(
        (msg: {
          content?: Array<{
            type: string
            name?: string
            [k: string]: unknown
          }>
          [k: string]: unknown
        }) => {
          if (msg.content && Array.isArray(msg.content)) {
            msg.content = msg.content.map((block) => {
              if (block.type === 'tool_use' && block.name) {
                return {
                  ...block,
                  name: `${TOOL_PREFIX}${block.name}`,
                }
              }
              return block
            })
          }
          return msg
        },
      )
    }

    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

/**
 * Strip TOOL_PREFIX from tool names in streaming response text.
 */
export function stripToolPrefix(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
}

/**
 * Check if TLS verification should be skipped for custom API endpoints.
 * Only effective when ANTHROPIC_BASE_URL is also set.
 */
export function isInsecure(): boolean {
  if (!process.env.ANTHROPIC_BASE_URL?.trim()) return false
  const raw = process.env.ANTHROPIC_INSECURE?.trim()
  return raw === '1' || raw === 'true'
}

/**
 * Parse ANTHROPIC_BASE_URL from the environment.
 * Returns a valid HTTP(S) URL or null if unset/invalid.
 */
function resolveBaseUrl(): URL | null {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim()
  if (!raw) return null
  try {
    const baseUrl = new URL(raw)
    if (
      (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
      baseUrl.username ||
      baseUrl.password
    ) {
      return null
    }
    return baseUrl
  } catch {
    return null
  }
}

/**
 * Rewrite the request URL to add ?beta=true for /v1/messages requests.
 * When ANTHROPIC_BASE_URL is set, overrides the origin (protocol + host)
 * for all API requests flowing through the fetch wrapper.
 * Returns the modified input and URL (if applicable).
 */
export function rewriteUrl(input: FetchInput): {
  input: FetchInput
  url: URL | null
} {
  let requestUrl: URL | null = null
  try {
    if (typeof input === 'string' || input instanceof URL) {
      requestUrl = new URL(input.toString())
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url)
    }
  } catch {
    requestUrl = null
  }

  if (!requestUrl) return { input, url: null }

  const originalHref = requestUrl.href

  const baseUrl = resolveBaseUrl()
  if (baseUrl) {
    requestUrl.protocol = baseUrl.protocol
    requestUrl.host = baseUrl.host
  }

  if (
    requestUrl.pathname === '/v1/messages' &&
    !requestUrl.searchParams.has('beta')
  ) {
    requestUrl.searchParams.set('beta', 'true')
  }

  if (requestUrl.href === originalHref) {
    return { input, url: requestUrl }
  }

  const newInput =
    input instanceof Request
      ? new Request(requestUrl.toString(), input)
      : requestUrl
  return { input: newInput, url: requestUrl }
}

/**
 * Compute a 3-character content-binding hash (CCH) from the first user message.
 * Algorithm reverse-engineered from Claude Code CLI.
 */
export function computeCCH(
  firstUserMessageText: string,
  version: string,
): string {
  if (!firstUserMessageText) {
    return randomBytes(2).toString('hex').slice(0, 3)
  }
  const chars = CCH_POSITIONS.map((i) => firstUserMessageText[i] || '0').join(
    '',
  )
  return createHash('sha256')
    .update(`${CCH_SALT}${chars}${version}`)
    .digest('hex')
    .slice(0, 3)
}

/**
 * Extract text from the first user message in an API messages array.
 */
export function extractFirstUserMessage(messages: unknown[]): string {
  if (!Array.isArray(messages)) return ''
  const firstUser = messages.find(
    (m: any) => m && typeof m === 'object' && m.role === 'user',
  ) as { content?: unknown } | undefined
  if (!firstUser) return ''
  if (typeof firstUser.content === 'string') return firstUser.content
  if (Array.isArray(firstUser.content)) {
    const textBlock = firstUser.content.find(
      (b: any) => b && typeof b === 'object' && b.type === 'text',
    ) as { text?: string } | undefined
    if (textBlock?.text) return textBlock.text
  }
  return ''
}

/**
 * Remove the OpenCode identity section from system prompt text.
 * Finds the OpenCode identity marker, then removes everything up to
 * (but not including) the '# Code References' marker.
 */
export function sanitizeSystemText(
  text: string,
  onError?: (msg: string) => void,
): string {
  const startIdx = text.indexOf(OPENCODE_IDENTITY)
  if (startIdx === -1) return text
  const codeRefsMarker = '# Code References'
  const endIdx = text.indexOf(codeRefsMarker, startIdx)
  if (endIdx === -1) {
    onError?.(
      `sanitizeSystemText: could not find '# Code References' after OpenCode identity`,
    )
    return text
  }
  return text.slice(0, startIdx) + text.slice(endIdx)
}

type SystemBlock = { type: string; text: string; [k: string]: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Sanitize system prompt and prepend Claude Code identity.
 * Handles all Anthropic API system formats: undefined, string, or array of text blocks.
 */
export function prependClaudeCodeIdentity(
  system: unknown,
  onError?: (msg: string) => void,
): SystemBlock[] {
  const identityBlock: SystemBlock = { type: 'text', text: CLAUDE_CODE_IDENTITY }

  if (system == null) return [identityBlock]

  if (typeof system === 'string') {
    const sanitized = sanitizeSystemText(system, onError)
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock]
    return [identityBlock, { type: 'text', text: sanitized }]
  }

  if (isRecord(system)) {
    const type = typeof system.type === 'string' ? system.type : 'text'
    const text = typeof system.text === 'string' ? system.text : ''
    return [identityBlock, { ...system, type, text: sanitizeSystemText(text, onError) }]
  }

  if (!Array.isArray(system)) return [identityBlock]

  const sanitized: SystemBlock[] = system.map((item: unknown) => {
    if (typeof item === 'string') {
      return { type: 'text', text: sanitizeSystemText(item, onError) }
    }

    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
      return { ...item, type: 'text', text: sanitizeSystemText(item.text, onError) }
    }

    return { type: 'text', text: String(item) }
  })

  // Idempotency: don't double-prepend if first block already has the identity
  if (sanitized[0]?.text === CLAUDE_CODE_IDENTITY) {
    return sanitized
  }

  return [identityBlock, ...sanitized]
}

/**
 * Rewrite the full request body: sanitize system prompt, prefix tool names,
 * and inject CCH hash.
 */
export function rewriteRequestBody(
  body: string,
  onError?: (msg: string) => void,
): string {
  try {
    const parsed = JSON.parse(body)

    // Compute CCH from first user message
    const firstUserText = extractFirstUserMessage(parsed.messages)
    const cch = computeCCH(firstUserText, CLAUDE_CODE_VERSION)

    // Sanitize system prompt and prepend Claude Code identity
    parsed.system = prependClaudeCodeIdentity(parsed.system, onError)

    // Inject cc_version with CCH hash into the identity block
    if (Array.isArray(parsed.system) && parsed.system.length > 0) {
      const first = parsed.system[0]
      if (first?.type === 'text' && first.text === CLAUDE_CODE_IDENTITY) {
        first.text = `${CLAUDE_CODE_IDENTITY}\n\ncc_version=${CLAUDE_CODE_VERSION}.${cch}`
      }
    }

    // Prefix tool names
    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map(
        (tool: { name?: string; [k: string]: unknown }) => ({
          ...tool,
          name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
        }),
      )
    }

    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map(
        (msg: {
          content?: Array<{
            type: string
            name?: string
            [k: string]: unknown
          }>
          [k: string]: unknown
        }) => {
          if (msg.content && Array.isArray(msg.content)) {
            msg.content = msg.content.map((block) => {
              if (block.type === 'tool_use' && block.name) {
                return { ...block, name: `${TOOL_PREFIX}${block.name}` }
              }
              return block
            })
          }
          return msg
        },
      )
    }

    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

/**
 * Create a streaming response that strips the tool prefix from tool names.
 */
export function createStrippedStream(response: Response): Response {
  if (!response.body) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }

      let text = decoder.decode(value, { stream: true })
      text = stripToolPrefix(text)
      controller.enqueue(encoder.encode(text))
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
