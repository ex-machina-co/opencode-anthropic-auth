import {
  BILLING_CCH,
  BILLING_SAMPLE_INDICES,
  CLAUDE_CODE_BILLING_SALT,
  CLAUDE_CODE_USER_AGENT,
  CLAUDE_CODE_VERSION,
  REQUIRED_BETAS,
  TOOL_PREFIX,
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
  headers.set('user-agent', CLAUDE_CODE_USER_AGENT)
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

    // Rewrite "OpenCode" -> "Claude Code" in system prompt blocks
    if (parsed.system && Array.isArray(parsed.system)) {
      parsed.system = parsed.system.map(
        (item: { type?: string; text?: string; [k: string]: unknown }) => {
          if (
            item &&
            typeof item === 'object' &&
            item.type === 'text' &&
            typeof item.text === 'string'
          ) {
            return {
              ...item,
              text: item.text
                .replace(/OpenCode/g, 'Claude Code')
                .replace(/opencode/gi, 'Claude'),
            }
          }
          return item
        },
      )
    }

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
 * Rewrite the request URL to add ?beta=true for /v1/messages requests.
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

  if (
    requestUrl &&
    requestUrl.pathname === '/v1/messages' &&
    !requestUrl.searchParams.has('beta')
  ) {
    requestUrl.searchParams.set('beta', 'true')
    const newInput =
      input instanceof Request
        ? new Request(requestUrl.toString(), input)
        : requestUrl
    return { input: newInput, url: requestUrl }
  }

  return { input, url: requestUrl }
}

/**
 * Compute the billing header string from the request body.
 * This is injected as the first system prompt text block, not as an HTTP header.
 *
 * Algorithm (from clewdr reverse-engineering):
 * 1. Find the first user message's first text content
 * 2. Sample UTF-16 code units at indices [4, 7, 20] (out-of-bounds -> '0')
 * 3. SHA-256(salt + sampled_chars + version), take first 3 hex chars
 * 4. Format: "x-anthropic-billing-header: cc_version=<ver>.<hash>; cc_entrypoint=cli; cch=00000;"
 */
export async function computeBillingHeader(body: string): Promise<string> {
  try {
    const parsed = JSON.parse(body)
    let firstUserText = ''

    if (parsed.messages && Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        if (msg.role === 'user') {
          if (typeof msg.content === 'string') {
            firstUserText = msg.content
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                firstUserText = block.text
                break
              }
            }
          }
          break
        }
      }
    }

    const sampled = BILLING_SAMPLE_INDICES.map((i) =>
      i < firstUserText.length ? firstUserText.charAt(i) : '0',
    ).join('')

    const hashInput = `${CLAUDE_CODE_BILLING_SALT}${sampled}${CLAUDE_CODE_VERSION}`
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(hashInput),
    )
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const hashPrefix = hashHex.slice(0, 3)

    return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${hashPrefix}; cc_entrypoint=cli; cch=${BILLING_CCH};`
  } catch {
    return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.000; cc_entrypoint=cli; cch=${BILLING_CCH};`
  }
}

/**
 * Inject the billing header as the first system text block in the request body.
 */
export async function injectBillingHeader(body: string): Promise<string> {
  try {
    const parsed = JSON.parse(body)
    const billingHeader = await computeBillingHeader(body)

    if (typeof parsed.system === 'string') {
      parsed.system = [
        { type: 'text', text: billingHeader },
        { type: 'text', text: parsed.system },
      ]
    } else if (Array.isArray(parsed.system)) {
      parsed.system.unshift({ type: 'text', text: billingHeader })
    } else {
      parsed.system = [{ type: 'text', text: billingHeader }]
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
