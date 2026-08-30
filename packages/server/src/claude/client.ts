import { buildClaudeHeaders } from './wire.ts'

export type ClaudeCallOptions = {
  body: Record<string, unknown>
  accessToken: string
  sessionId: string
  baseUrl: string
  retryCount?: number
  signal?: AbortSignal
}

/**
 * POST the (already-translated) body to Anthropic's /v1/messages and return
 * the raw upstream Response — streaming SSE passes straight through to the
 * OpenAI-side translator.
 */
export async function callClaude(opts: ClaudeCallOptions): Promise<Response> {
  return fetch(`${opts.baseUrl}/v1/messages?beta=true`, {
    method: 'POST',
    headers: buildClaudeHeaders(
      opts.accessToken,
      opts.sessionId,
      opts.retryCount ?? 0,
    ),
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  })
}
