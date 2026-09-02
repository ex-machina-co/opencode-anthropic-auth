/**
 * Failover detection helpers.
 *
 * Anthropic signals that a Claude account is rate-limited / usage-limited in
 * more than one way, and NOT always via a clean HTTP status:
 *
 *  1. HTTP 429 / 401 / 403 / 529 with a JSON error body (non-streaming).
 *  2. HTTP 200 with a Server-Sent-Events (SSE) stream whose FIRST event is an
 *     `error` event, e.g.
 *       event: error
 *       data: {"type":"error","error":{"type":"rate_limit_error","message":"..."}}
 *  3. A plain JSON error body `{ "type":"error", "error":{ "type":"..." } }`.
 *
 * The account loader must fail over for all of these, so we can't rely on the
 * HTTP status alone — we also have to peek at the response body.
 */

/** Anthropic error `type` values that mean "this account is exhausted". */
const FAILOVER_ERROR_TYPES = new Set([
  'rate_limit_error',
  'overloaded_error',
  'authentication_error',
  'permission_error',
  'billing_error',
])

/**
 * Substrings that appear in Claude Pro/Max usage-limit / restriction messages
 * (which sometimes come back with a generic `api_error` / `invalid_request_error`
 * type rather than `rate_limit_error`). Matched case-insensitively.
 */
const FAILOVER_MESSAGE_HINTS = [
  'rate limit',
  'usage limit',
  'exceeded',
  'quota',
  'overloaded',
  'temporarily unavailable',
  'reached your',
  'try again later',
  'upgrade',
]

export const DEBUG_ENV = 'ANTHROPIC_FAILOVER_DEBUG'

export function isDebugEnabled(): boolean {
  const raw = process.env[DEBUG_ENV]?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

export function debugLog(...args: unknown[]): void {
  if (isDebugEnabled()) {
    // eslint-disable-next-line no-console
    console.error('[anthropic-failover]', ...args)
  }
}

/**
 * HTTP statuses that unambiguously indicate the account is exhausted / rejected.
 * (Body inspection handles the 200-with-error-event case separately.)
 */
export function isFailoverStatus(status: number): boolean {
  return status === 429 || status === 401 || status === 403 || status === 529
}

/**
 * Given a decoded chunk of text (JSON body or the first SSE frames), decide
 * whether it represents a rate-limit / usage-limit / auth error that should
 * trigger failover to another account.
 */
export function textIndicatesFailover(text: string): boolean {
  if (!text) return false

  // Fast path: SSE error event.
  // The stream begins with `event: error` for hard errors.
  const lowered = text.toLowerCase()

  // Try to extract and parse any JSON object(s) present (SSE `data:` payloads
  // or a bare JSON error body).
  const jsonCandidates: string[] = []
  const dataLineRe = /(?:^|\n)\s*data:\s*(\{.*)$/gm
  for (const m of text.matchAll(dataLineRe)) {
    if (m[1]) jsonCandidates.push(m[1])
  }
  // Also consider the whole text as a possible bare JSON body.
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) jsonCandidates.push(trimmed)

  for (const candidate of jsonCandidates) {
    const errorType = extractErrorType(candidate)
    if (errorType && FAILOVER_ERROR_TYPES.has(errorType)) return true

    const message = extractErrorMessage(candidate)
    if (message && messageHintsFailover(message)) return true
  }

  // Fallback: an explicit SSE error event whose payload we couldn't parse but
  // that clearly mentions a limit.
  if (lowered.includes('event: error') && messageHintsFailover(lowered)) {
    return true
  }

  return false
}

function extractErrorType(candidate: string): string | undefined {
  try {
    const parsed = JSON.parse(candidate) as {
      type?: string
      error?: { type?: string }
    }
    return parsed.error?.type
  } catch {
    // Not complete JSON (truncated first chunk). Fall back to a regex probe.
    const m = candidate.match(/"type"\s*:\s*"([a-z_]+_error)"/)
    return m?.[1]
  }
}

function extractErrorMessage(candidate: string): string | undefined {
  try {
    const parsed = JSON.parse(candidate) as {
      type?: string
      error?: { message?: string }
    }
    // Only the nested `error.message` is a human-readable error string.
    // A top-level `message` field belongs to `message_start`/`message_delta`
    // events (an object), so we deliberately ignore it.
    const msg = parsed.error?.message
    return typeof msg === 'string' ? msg : undefined
  } catch {
    const m = candidate.match(/"message"\s*:\s*"([^"]+)"/)
    return m?.[1]
  }
}

function messageHintsFailover(message: unknown): boolean {
  if (typeof message !== 'string') return false
  const lowered = message.toLowerCase()
  return FAILOVER_MESSAGE_HINTS.some((hint) => lowered.includes(hint))
}

/**
 * Does the buffered text contain a real content event? Once actual assistant
 * content has started streaming, we've "committed" to this account and can no
 * longer fail over (retrying would duplicate content). `message_start` alone
 * does NOT count — a rate-limit `error` event can still follow it.
 */
export function textIndicatesContent(text: string): boolean {
  if (!text) return false
  return (
    text.includes('content_block_start') ||
    text.includes('content_block_delta') ||
    text.includes('"type":"content_block') ||
    text.includes('"type": "content_block')
  )
}

/**
 * Inspect the start of a streaming response to classify it as an error or a
 * genuine (content-bearing) response WITHOUT discarding data.
 *
 * It keeps reading past the first SSE event until it sees EITHER a failover
 * error OR the first real content event (or hits `maxBytes`). This catches
 * rate-limit / usage-limit `error` events that arrive a few events into the
 * stream (e.g. after `message_start` and `ping`), which is the common
 * "restricted mid-response" case.
 *
 * Returns:
 *  - `isError`: true if a rate-limit / usage-limit / auth error was detected
 *  - `prefixText`: the decoded text inspected (for logging)
 *  - `stream`: a fresh stream replaying everything read plus the remainder, so a
 *    good response is delivered to the caller unchanged.
 */
export async function inspectStream(
  // biome-ignore lint/suspicious/noExplicitAny: bridge DOM vs node:stream/web reader types
  body: any,
  maxBytes = 65536,
): Promise<{
  isError: boolean
  prefixText: string
  stream: ReadableStream<Uint8Array>
}> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const chunks: Uint8Array[] = []
  let total = 0
  let text = ''
  let isError = false

  while (total < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
      text += decoder.decode(value, { stream: true })
      if (textIndicatesFailover(text)) {
        isError = true
        break
      }
      // Once real content has begun, stop inspecting and commit to this stream.
      if (textIndicatesContent(text)) break
    }
  }
  text += decoder.decode()

  const prefixBytes = concatChunks(chunks, total)

  let prefixSent = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true
        if (prefixBytes.byteLength > 0) {
          controller.enqueue(prefixBytes)
          return
        }
      }
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  return { isError, prefixText: text, stream }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
