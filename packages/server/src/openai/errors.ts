import type { OpenAIError } from './types.ts'

export const SUBSCRIPTION_GATE_ERROR_MESSAGE =
  'Anthropic returned an opaque subscription 429 ("Error"). The Claude ' +
  'subscription system-prompt gate likely rejected the request; verify that ' +
  'the upstream system prompt contains a well-formed ' +
  'x-anthropic-billing-header block or the exact Claude Agent SDK identity.'

type UpstreamErrorEnvelope = {
  error?: {
    message?: unknown
    type?: unknown
  }
}

export function translateUpstreamError(
  status: number,
  text: string,
): OpenAIError {
  let message = text || `upstream returned ${status}`
  let type = 'upstream_error'

  try {
    const parsed = JSON.parse(text) as UpstreamErrorEnvelope
    if (typeof parsed.error?.message === 'string') {
      message = parsed.error.message
    }
    if (typeof parsed.error?.type === 'string') {
      type = parsed.error.type
    }
  } catch {
    // Keep the raw body and generic upstream type.
  }

  if (status === 429 && type === 'rate_limit_error' && message === 'Error') {
    message = SUBSCRIPTION_GATE_ERROR_MESSAGE
  }

  return { error: { message, type, code: type } }
}
