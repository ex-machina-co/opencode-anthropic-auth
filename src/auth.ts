import {
  BodyLimitError,
  contentLength,
  InvalidUtf8Error,
  readBoundedText,
} from './bounded.ts'
import {
  AUTHORIZE_URLS,
  CLIENT_ID,
  CODE_CALLBACK_URL,
  OAUTH_SCOPES,
  TOKEN_URL,
} from './constants.ts'
import { generatePKCE } from './pkce.ts'

type CallbackParams = {
  code: string
  state: string
}

type TokenResponse = {
  refresh_token: string
  access_token: string
  expires_in: number
}

const TOKEN_TIMEOUT_MS = 30_000
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
const MAX_TOKEN_LENGTH = 8 * 1024
const MAX_CALLBACK_INPUT_BYTES = 16 * 1024
const MAX_VERIFIER_BYTES = 1024
const MAX_REDIRECT_URI_BYTES = 2 * 1024

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

function isBoundedUtf8(value: string, maxBytes: number): boolean {
  if (
    value.length === 0 ||
    value.length > maxBytes ||
    !isWellFormedUtf16(value)
  ) {
    return false
  }
  return new TextEncoder().encode(value).byteLength <= maxBytes
}

function isTokenResponse(value: unknown): value is TokenResponse {
  if (typeof value !== 'object' || value === null) return false
  if (!('refresh_token' in value) || !('access_token' in value)) return false
  if (!('expires_in' in value)) return false
  return (
    typeof value.refresh_token === 'string' &&
    isBoundedUtf8(value.refresh_token, MAX_TOKEN_LENGTH) &&
    typeof value.access_token === 'string' &&
    isBoundedUtf8(value.access_token, MAX_TOKEN_LENGTH) &&
    typeof value.expires_in === 'number' &&
    Number.isSafeInteger(value.expires_in) &&
    value.expires_in > 0
  )
}

async function parseTokenResponse(response: Response) {
  const declaredLength = contentLength(response.headers)
  if (
    declaredLength !== undefined &&
    declaredLength > MAX_TOKEN_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => {})
    return undefined
  }

  try {
    const text = await readBoundedText(
      response.body,
      MAX_TOKEN_RESPONSE_BYTES,
      'Anthropic token response',
    )
    const value: unknown = JSON.parse(text)
    if (!isTokenResponse(value)) return undefined
    const expires = Date.now() + value.expires_in * 1000
    if (!Number.isSafeInteger(expires)) return undefined
    return {
      refresh: value.refresh_token,
      access: value.access_token,
      expires,
    }
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      error instanceof BodyLimitError ||
      error instanceof InvalidUtf8Error
    ) {
      return undefined
    }
    throw error
  }
}

function isTransientNetworkError(error: unknown): boolean {
  const seen = new WeakSet<object>()
  let current: unknown = error

  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== 'object' || current === null) return false
    if (seen.has(current)) return false
    seen.add(current)

    if (
      'name' in current &&
      (current.name === 'TimeoutError' || current.name === 'AbortError')
    ) {
      return true
    }

    if ('code' in current) {
      const code = current.code
      if (
        code === 'ECONNRESET' ||
        code === 'ECONNREFUSED' ||
        code === 'ETIMEDOUT' ||
        code === 'EPIPE' ||
        code === 'ENETUNREACH' ||
        code === 'EAI_AGAIN' ||
        code === 'UND_ERR_CONNECT_TIMEOUT' ||
        code === 'UND_ERR_SOCKET'
      ) {
        return true
      }
    }

    const message =
      current instanceof Error ? current.message.toLowerCase() : ''
    if (
      message === 'fetch failed' ||
      message === 'terminated' ||
      message === 'network error' ||
      message.includes('socket hang up') ||
      message.includes('other side closed')
    ) {
      return true
    }

    if (!('cause' in current)) return false
    current = current.cause
  }

  return false
}

export type AuthorizationResult = {
  url: string
  redirectUri: string
  state: string
  verifier: string
}

function generateState() {
  return crypto.randomUUID().replace(/-/g, '')
}

function parseCallbackInput(input: string) {
  const trimmed = input.trim()

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code && state) {
      return { code, state }
    }
  } catch {
    // Fall through to legacy/manual formats.
  }

  const hashSplits = trimmed.split('#')
  if (hashSplits.length === 2 && hashSplits[0] && hashSplits[1]) {
    return { code: hashSplits[0], state: hashSplits[1] }
  }

  const params = new URLSearchParams(trimmed)
  const code = params.get('code')
  const state = params.get('state')
  if (code && state) {
    return { code, state }
  }

  return null
}

async function exchangeCode(
  callback: CallbackParams,
  verifier: string,
  redirectUri: string,
): Promise<ExchangeResult> {
  let result: Response
  try {
    result = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'axios/1.13.6',
      },
      body: JSON.stringify({
        code: callback.code,
        state: callback.state,
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    })
  } catch (error) {
    if (isTransientNetworkError(error)) return { type: 'failed' }
    throw error
  }

  if (!result.ok) {
    await result.body?.cancel().catch(() => {})
    return {
      type: 'failed',
    }
  }

  const tokens = await parseTokenResponse(result)
  if (!tokens) return { type: 'failed' }

  return {
    type: 'success',
    ...tokens,
  }
}

export async function authorize(
  mode: 'max' | 'console',
): Promise<AuthorizationResult> {
  const pkce = await generatePKCE()
  const state = generateState()

  const url = new URL(AUTHORIZE_URLS[mode], import.meta.url)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', CODE_CALLBACK_URL)
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '))
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)

  return {
    url: url.toString(),
    redirectUri: CODE_CALLBACK_URL,
    state,
    verifier: pkce.verifier,
  }
}

export type ExchangeResult =
  | { type: 'success'; refresh: string; access: string; expires: number }
  | { type: 'failed' }

export async function exchange(
  input: string,
  verifier: string,
  redirectUri: string,
  expectedState?: string,
): Promise<ExchangeResult> {
  if (
    !isBoundedUtf8(input, MAX_CALLBACK_INPUT_BYTES) ||
    !isBoundedUtf8(verifier, MAX_VERIFIER_BYTES) ||
    !isBoundedUtf8(redirectUri, MAX_REDIRECT_URI_BYTES) ||
    (expectedState !== undefined &&
      !isBoundedUtf8(expectedState, MAX_TOKEN_LENGTH))
  ) {
    return { type: 'failed' }
  }

  const callback = parseCallbackInput(input)
  if (!callback) {
    return {
      type: 'failed',
    }
  }

  if (expectedState && callback.state !== expectedState) {
    return {
      type: 'failed',
    }
  }

  if (
    !isBoundedUtf8(callback.code, MAX_TOKEN_LENGTH) ||
    !isBoundedUtf8(callback.state, MAX_TOKEN_LENGTH)
  ) {
    return { type: 'failed' }
  }

  return exchangeCode(callback, verifier, redirectUri)
}

export type RefreshResult =
  | { type: 'success'; refresh: string; access: string; expires: number }
  | { type: 'failed'; status: number }

/**
 * Exchange a refresh token for a new access/refresh token pair.
 * Refresh tokens may rotate after a request reaches the provider. Retrying an
 * ambiguous 5xx, timeout, network failure, or response-body failure can replay
 * an already consumed token, so each call makes exactly one token request.
 */
export async function refreshToken(
  refreshTokenValue: string,
): Promise<RefreshResult> {
  if (!isBoundedUtf8(refreshTokenValue, MAX_TOKEN_LENGTH)) {
    return { type: 'failed', status: 400 }
  }

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'axios/1.13.6',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
        client_id: CLIENT_ID,
      }),
    })

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return { type: 'failed', status: response.status }
    }

    const tokens = await parseTokenResponse(response)
    if (!tokens) return { type: 'failed', status: response.status }

    return {
      type: 'success',
      ...tokens,
    }
  } catch (error) {
    if (isTransientNetworkError(error)) return { type: 'failed', status: 0 }
    throw error
  }
}
