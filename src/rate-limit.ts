import { createHash, randomBytes } from 'node:crypto'
import { contentLength } from './bounded.ts'
import { headersAfterBodyTransform } from './transform.ts'

const MAX_RATE_LIMIT_BODY_BYTES = 64 * 1024
const MAX_RATE_LIMIT_BODY_CHUNKS = 1024
const DEFAULT_RATE_LIMIT_PROBE_TIMEOUT_MS = 1000
const MAX_RATE_LIMIT_PROBE_TIMEOUT_MS = 5000
const SAFE_GENERATED_LABEL = /^Claude OAuth • [A-F0-9]{8}$/
const SAFE_GENERIC_LABEL = /^Anthropic(?: [1-9][0-9]{0,5})?$/
const SAFE_REQUEST_ID = /^req_[a-z0-9][a-z0-9_-]{0,91}$/i
const SAFE_ERROR_TYPES = new Set(['rate_limit_error'])

export type RateLimitCategory =
  | 'subscription-usage'
  | 'transient-rate-limit'
  | 'unknown-rate-limit'

export type RateLimitEnhancement = {
  readonly response: Response
  readonly category: RateLimitCategory
}

type ConnectionInfo = {
  readonly type: string
  readonly id?: string
  readonly label?: string
}

type RateLimitOptions = {
  readonly probeTimeoutMs?: number
}

type ByteReadResult =
  | { readonly done: true; readonly value?: undefined }
  | { readonly done: false; readonly value: Uint8Array }

type ByteReader = {
  readonly read: () => Promise<ByteReadResult>
  readonly cancel: (reason?: unknown) => Promise<void>
  readonly releaseLock: () => void
}

type ByteReadOutcome =
  | { readonly ok: true; readonly result: ByteReadResult }
  | { readonly ok: false; readonly error: unknown }

class ProbeTimeoutError extends Error {}

function guardedRead(reader: ByteReader): Promise<ByteReadOutcome> {
  return reader.read().then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error }),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function classifyRateLimit(message: string): RateLimitCategory {
  if (
    /\b(?:usage|weekly|monthly(?: spend)?|session|subscription|plan) limit\b/i.test(
      message,
    ) ||
    /\bquota exhausted\b/i.test(message) ||
    /\bextra usage (?:is )?required\b/i.test(message)
  ) {
    return 'subscription-usage'
  }
  if (
    /\b(?:rate[- ]?limit(?:ed| exceeded| reached)?|too many requests|requests? per minute|tokens? per minute|acceleration limit|temporarily limiting requests)\b/i.test(
      message,
    )
  ) {
    return 'transient-rate-limit'
  }
  return 'unknown-rate-limit'
}

function canonicalMessage(category: RateLimitCategory): string {
  switch (category) {
    case 'subscription-usage':
      return 'Anthropic reports that this account has reached a subscription or usage limit.'
    case 'transient-rate-limit':
      return 'Anthropic reports a transient request rate limit.'
    default:
      return 'Anthropic returned an unclassified HTTP 429 response.'
  }
}

function probeTimeout(options: RateLimitOptions): number {
  const requested = options.probeTimeoutMs
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_RATE_LIMIT_PROBE_TIMEOUT_MS
  }
  return Math.min(
    MAX_RATE_LIMIT_PROBE_TIMEOUT_MS,
    Math.max(1, Math.floor(requested)),
  )
}

async function readBeforeTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function replayResponse(
  response: Response,
  reader: ByteReader,
  prefix: readonly Uint8Array[],
  pending: Promise<ByteReadOutcome> | undefined,
  sourceDone: boolean,
  terminalError?: unknown,
): Response {
  let index = 0
  let next = pending
  let done = sourceDone
  let released = false
  const release = () => {
    if (released) return
    released = true
    reader.releaseLock()
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < prefix.length) {
        const chunk = prefix[index]
        index += 1
        if (chunk) controller.enqueue(chunk)
        return
      }
      if (terminalError !== undefined) {
        release()
        controller.error(terminalError)
        return
      }
      if (done) {
        release()
        controller.close()
        return
      }
      try {
        const outcome = next ? await next : await guardedRead(reader)
        next = undefined
        if (!outcome.ok) throw outcome.error
        const result = outcome.result
        if (result.done) {
          done = true
          release()
          controller.close()
          return
        }
        controller.enqueue(result.value)
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        release()
      }
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

type BodyProbe =
  | {
      readonly type: 'complete'
      readonly text: string
      readonly passthrough: () => Response
      readonly dispose: () => void
    }
  | { readonly type: 'passthrough'; readonly response: Response }

async function probeBody(
  response: Response,
  timeoutMs: number,
): Promise<BodyProbe> {
  if (!response.body) return { type: 'passthrough', response }
  const reader: ByteReader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: Uint8Array[] = []
  const parts: string[] = []
  const deadline = Date.now() + timeoutMs
  let chunkCount = 0
  let total = 0

  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return {
        type: 'passthrough',
        response: replayResponse(response, reader, chunks, undefined, false),
      }
    }
    const operation = guardedRead(reader)
    let outcome: ByteReadOutcome
    try {
      outcome = await readBeforeTimeout(operation, remaining)
    } catch (error) {
      if (error instanceof ProbeTimeoutError) {
        return {
          type: 'passthrough',
          response: replayResponse(response, reader, chunks, operation, false),
        }
      }
      return {
        type: 'passthrough',
        response: replayResponse(
          response,
          reader,
          chunks,
          undefined,
          false,
          error,
        ),
      }
    }
    if (!outcome.ok) {
      return {
        type: 'passthrough',
        response: replayResponse(
          response,
          reader,
          chunks,
          undefined,
          false,
          outcome.error,
        ),
      }
    }
    const result = outcome.result

    if (result.done) {
      try {
        parts.push(decoder.decode())
      } catch {
        return {
          type: 'passthrough',
          response: replayResponse(response, reader, chunks, undefined, true),
        }
      }
      return {
        type: 'complete',
        text: parts.join(''),
        passthrough: () =>
          replayResponse(response, reader, chunks, undefined, true),
        dispose: () => reader.releaseLock(),
      }
    }

    chunkCount += 1
    const chunk = result.value
    if (chunk.byteLength === 0) {
      if (chunkCount > MAX_RATE_LIMIT_BODY_CHUNKS) {
        return {
          type: 'passthrough',
          response: replayResponse(response, reader, chunks, undefined, false),
        }
      }
      continue
    }
    chunks.push(chunk)
    if (chunkCount > MAX_RATE_LIMIT_BODY_CHUNKS) {
      return {
        type: 'passthrough',
        response: replayResponse(response, reader, chunks, undefined, false),
      }
    }
    total += chunk.byteLength
    if (total > MAX_RATE_LIMIT_BODY_BYTES) {
      return {
        type: 'passthrough',
        response: replayResponse(response, reader, chunks, undefined, false),
      }
    }
    try {
      parts.push(decoder.decode(chunk, { stream: true }))
    } catch {
      return {
        type: 'passthrough',
        response: replayResponse(response, reader, chunks, undefined, false),
      }
    }
  }
}

function safeRequestID(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value)
    ? value
    : undefined
}

function retryAfterDiagnostic(headers: Headers): string | undefined {
  const value = headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 24 * 60 * 60) {
    return `${seconds}s`
  }
  const timestamp = Date.parse(value)
  if (!Number.isNaN(timestamp)) return new Date(timestamp).toUTCString()
  return undefined
}

function jsonMediaType(headers: Headers): boolean {
  const mediaType = headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase()
  return (
    mediaType === 'application/json' || mediaType?.endsWith('+json') === true
  )
}

export function createConnectionLabel(
  entropy: Uint8Array = randomBytes(4),
): string {
  const suffix = Array.from(entropy.slice(0, 4), (byte) =>
    byte.toString(16).padStart(2, '0'),
  )
    .join('')
    .toUpperCase()
  if (suffix.length !== 8)
    throw new Error('Connection label entropy is too short')
  return `Claude OAuth • ${suffix}`
}

export function describeConnection(connection: ConnectionInfo): string {
  if (connection.type !== 'credential' || !connection.id) {
    return 'Non-credential Anthropic connection'
  }
  const fingerprint = createHash('sha256')
    .update(connection.id, 'utf8')
    .digest('hex')
    .slice(0, 10)
  const label =
    typeof connection.label === 'string' &&
    (SAFE_GENERIC_LABEL.test(connection.label) ||
      SAFE_GENERATED_LABEL.test(connection.label))
      ? connection.label
      : 'Custom label hidden'
  return `${label} [connection ${fingerprint}]`
}

export function isSubscriptionUsageDiagnostic(message: string): boolean {
  return message.startsWith('[anthropic-auth category=subscription-usage;')
}

export async function enhanceRateLimitResponse(
  response: Response,
  connection: string,
  options: RateLimitOptions = {},
): Promise<RateLimitEnhancement> {
  const unknown = {
    response,
    category: 'unknown-rate-limit' as const,
  }
  if (
    response.status !== 429 ||
    !response.body ||
    !jsonMediaType(response.headers)
  ) {
    return unknown
  }
  const declaredLength = contentLength(response.headers)
  if (
    declaredLength !== undefined &&
    declaredLength > MAX_RATE_LIMIT_BODY_BYTES
  ) {
    return unknown
  }

  const probe = await probeBody(response, probeTimeout(options))
  if (probe.type === 'passthrough') {
    return { response: probe.response, category: 'unknown-rate-limit' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(probe.text)
  } catch {
    return { response: probe.passthrough(), category: 'unknown-rate-limit' }
  }
  if (!isRecord(parsed)) {
    return { response: probe.passthrough(), category: 'unknown-rate-limit' }
  }
  const root = parsed
  const error = root.error
  if (!isRecord(error)) {
    return { response: probe.passthrough(), category: 'unknown-rate-limit' }
  }
  if (typeof error.message !== 'string' || error.message.trim().length === 0) {
    return { response: probe.passthrough(), category: 'unknown-rate-limit' }
  }

  const category = classifyRateLimit(error.message)
  const headers = headersAfterBodyTransform(response.headers)
  headers.set('content-type', 'application/json')
  if (category === 'subscription-usage') headers.set('x-should-retry', 'false')

  for (const name of ['request-id', 'x-request-id']) {
    const value = headers.get(name)
    if (value && !safeRequestID(value)) headers.delete(name)
  }
  const retryAfter = retryAfterDiagnostic(headers)
  if (headers.has('retry-after') && !retryAfter) headers.delete('retry-after')
  const requestID =
    safeRequestID(headers.get('request-id')) ??
    safeRequestID(headers.get('x-request-id')) ??
    safeRequestID(root.request_id)
  const errorType =
    typeof error.type === 'string' && SAFE_ERROR_TYPES.has(error.type)
      ? error.type
      : 'rate_limit_error'
  const details = [
    `category=${category}`,
    `active=${connection}`,
    ...(retryAfter ? [`retry-after=${retryAfter}`] : []),
    ...(requestID ? [`request-id=${requestID}`] : []),
  ]
  const action =
    category === 'subscription-usage'
      ? ' Verify or explicitly switch the active Anthropic connection; no automatic account fallback was attempted.'
      : ''
  const message = `[anthropic-auth ${details.join('; ')}] ${canonicalMessage(category)}${action}`
  const body = JSON.stringify({
    type: 'error',
    error: { type: errorType, message },
    ...(requestID ? { request_id: requestID } : {}),
  })
  probe.dispose()

  return {
    category,
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  }
}
