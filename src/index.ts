import { createHash } from 'node:crypto'
import type { Plugin } from '@opencode-ai/plugin'
import { authorize, exchange } from './auth.ts'
import { resolveClaudeCodeVersion } from './config.ts'
import { CLAUDE_CODE_VERSION, CLIENT_ID, TOKEN_URL } from './constants.ts'
import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

type AuthState = {
  type: string
  access?: string
  refresh?: string
  expires?: number
}

type OAuthCredential = {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
}

type TokenResponse = {
  refresh_token: string
  access_token: string
  expires_in: number
}

type RotationState = {
  readonly inFlight: Map<string, Promise<OAuthCredential>>
  readonly cache: Map<string, Promise<OAuthCredential>>
  readonly cacheTimers: Map<string, ReturnType<typeof setTimeout>>
  readonly blockedTokens: Map<string, number>
  readonly blockedFilter: Uint8Array
}

type ClientRefreshState = {
  readonly cache: Map<string, Promise<OAuthCredential>>
  readonly cacheTimers: Map<string, ReturnType<typeof setTimeout>>
}

const REFRESH_CACHE_GRACE_MS = 30_000
const MAX_REFRESH_TOKEN_BYTES = 8 * 1024
const MAX_REFRESH_IN_FLIGHT = 256
const MAX_REFRESH_CACHE_ENTRIES = 256
const MAX_BLOCKED_REFRESH_TOKENS = 1024
const BLOCKED_REFRESH_FILTER_BYTES = 8 * 1024
const BLOCKED_REFRESH_FILTER_HASHES = 4
const TOKEN_TIMEOUT_MS = 30_000
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024

// Rotation is process-global because the same single-use refresh token can be
// observed through multiple plugin clients. Persistence remains client-scoped:
// every credential store awaiting a shared rotation saves the rotated result.
const rotationState: RotationState = {
  inFlight: new Map(),
  cache: new Map(),
  cacheTimers: new Map(),
  blockedTokens: new Map(),
  // If exact blocked-token tracking fills up, retain identities in a bounded
  // fail-closed filter rather than forgetting a token that may have been used.
  blockedFilter: new Uint8Array(BLOCKED_REFRESH_FILTER_BYTES),
}
const clientRefreshStates = new WeakMap<object, ClientRefreshState>()

function clientRefreshStateFor(client: unknown): ClientRefreshState {
  if (
    (typeof client !== 'object' || client === null) &&
    typeof client !== 'function'
  ) {
    throw new Error('OpenCode plugin client is unavailable')
  }
  const identity = client as object
  const existing = clientRefreshStates.get(identity)
  if (existing) return existing
  const created: ClientRefreshState = {
    cache: new Map(),
    cacheTimers: new Map(),
  }
  clientRefreshStates.set(identity, created)
  return created
}

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

function isBoundedToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REFRESH_TOKEN_BYTES &&
    isWellFormedUtf16(value) &&
    new TextEncoder().encode(value).byteLength <= MAX_REFRESH_TOKEN_BYTES
  )
}

function refreshTokenKey(refreshToken: string): string | undefined {
  if (!isBoundedToken(refreshToken)) return undefined
  return createHash('sha256')
    .update(new TextEncoder().encode(refreshToken))
    .digest('base64url')
}

function blockedRefreshFilterIndexes(key: string): number[] {
  const digest = createHash('sha256').update(`blocked:${key}`).digest()
  const bits = BLOCKED_REFRESH_FILTER_BYTES * 8
  return Array.from(
    { length: BLOCKED_REFRESH_FILTER_HASHES },
    (_, index) => digest.readUInt32BE(index * 4) % bits,
  )
}

function addBlockedRefreshToFilter(state: RotationState, key: string): void {
  for (const index of blockedRefreshFilterIndexes(key)) {
    const byteIndex = index >> 3
    state.blockedFilter[byteIndex] =
      (state.blockedFilter[byteIndex] ?? 0) | (1 << (index & 7))
  }
}

function blockedRefreshFilterHas(state: RotationState, key: string): boolean {
  return blockedRefreshFilterIndexes(key).every(
    (index) =>
      ((state.blockedFilter[index >> 3] ?? 0) & (1 << (index & 7))) !== 0,
  )
}

function blockRefreshToken(
  state: RotationState,
  key: string,
  status: number,
): void {
  if (state.blockedTokens.has(key) || blockedRefreshFilterHas(state, key))
    return
  if (state.blockedTokens.size >= MAX_BLOCKED_REFRESH_TOKENS) {
    addBlockedRefreshToFilter(state, key)
    return
  }
  state.blockedTokens.set(key, status)
}

function reconnectError(message: string): Error {
  return new Error(
    `${message}; run /connect and reconnect Claude Pro/Max before retrying`,
  )
}

function blockedRefreshError(
  state: RotationState,
  key: string,
): Error | undefined {
  const status = state.blockedTokens.get(key)
  if (status !== undefined) {
    if (status === 200) {
      return reconnectError(
        'Anthropic OAuth refresh token was already consumed and its cached result expired',
      )
    }
    return reconnectError(
      `Anthropic token refresh is blocked after an ambiguous failure (${status})`,
    )
  }
  if (blockedRefreshFilterHas(state, key)) {
    return reconnectError(
      'Anthropic token refresh is blocked after an ambiguous failure',
    )
  }
  return undefined
}

function parseRotatedCredential(value: unknown): OAuthCredential | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<TokenResponse>
  const expiresIn = candidate.expires_in
  if (
    !isBoundedToken(candidate.refresh_token) ||
    !isBoundedToken(candidate.access_token) ||
    typeof expiresIn !== 'number' ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0
  ) {
    return undefined
  }
  const expires = Date.now() + expiresIn * 1000
  if (!Number.isSafeInteger(expires)) return undefined
  return {
    type: 'oauth',
    refresh: candidate.refresh_token,
    access: candidate.access_token,
    expires,
  }
}

async function readBoundedTokenResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const declared = Number(contentLength)
    if (
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > MAX_TOKEN_RESPONSE_BYTES
    ) {
      await response.body?.cancel().catch(() => {})
      return undefined
    }
  }

  if (!response.body) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_TOKEN_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        return undefined
      }
      chunks.push(value)
    }
  } catch {
    await reader.cancel().catch(() => {})
    return undefined
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}

async function requestRotatedCredential(
  state: RotationState,
  refreshToken: string,
  key: string,
): Promise<OAuthCredential> {
  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
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
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    })
  } catch {
    blockRefreshToken(state, key, 0)
    throw reconnectError(
      'Anthropic token refresh had an unknown network outcome and will not be replayed',
    )
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status >= 500) {
      blockRefreshToken(state, key, response.status)
      throw reconnectError(
        `Anthropic token refresh had an unknown HTTP ${response.status} outcome and will not be replayed`,
      )
    }
    if (response.status === 400 || response.status === 401) {
      blockRefreshToken(state, key, response.status)
      throw reconnectError(
        'Anthropic OAuth session expired or its refresh token was already used',
      )
    }
    throw new Error(`Token refresh failed: ${response.status}`)
  }

  const value = await readBoundedTokenResponse(response)
  if (value === undefined) {
    blockRefreshToken(state, key, response.status)
    throw reconnectError(
      'Anthropic token refresh returned an unreadable success response and will not be replayed',
    )
  }
  const rotated = parseRotatedCredential(value)
  if (!rotated) {
    blockRefreshToken(state, key, response.status)
    throw reconnectError(
      'Anthropic token refresh returned an invalid success response and will not be replayed',
    )
  }

  // The old token has now been consumed. The short-lived result cache serves
  // delayed callers; once it expires, fail closed instead of replaying it.
  blockRefreshToken(state, key, response.status)
  return rotated
}

async function persistRotatedCredential(
  client: unknown,
  rotated: OAuthCredential,
): Promise<OAuthCredential> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
    await (client as any).auth.set({
      path: { id: 'anthropic' },
      body: rotated,
    })
  } catch {
    throw reconnectError(
      'Anthropic rotated the OAuth credential but OpenCode could not persist it',
    )
  }
  return rotated
}

function removeRotationCacheEntry(
  key: string,
  expected?: Promise<OAuthCredential>,
): void {
  if (expected && rotationState.cache.get(key) !== expected) return
  rotationState.cache.delete(key)
  const timer = rotationState.cacheTimers.get(key)
  if (timer) clearTimeout(timer)
  rotationState.cacheTimers.delete(key)
}

async function rotateCredential(
  refreshToken: string,
  key: string,
): Promise<OAuthCredential> {
  const cached = rotationState.cache.get(key)
  if (cached) return cached

  const shared = rotationState.inFlight.get(key)
  if (!shared) {
    const blocked = blockedRefreshError(rotationState, key)
    if (blocked) throw blocked
  }
  if (!shared && rotationState.inFlight.size >= MAX_REFRESH_IN_FLIGHT) {
    throw new Error('Too many active Anthropic token refreshes')
  }
  if (!shared && rotationState.cache.size >= MAX_REFRESH_CACHE_ENTRIES) {
    throw reconnectError(
      'Anthropic token refresh is blocked until the consumed-token cache expires',
    )
  }

  const pending =
    shared ?? requestRotatedCredential(rotationState, refreshToken, key)
  rotationState.cache.set(key, pending)
  if (!shared) rotationState.inFlight.set(key, pending)

  try {
    const rotated = await pending
    if (
      rotationState.cache.get(key) === pending &&
      !rotationState.cacheTimers.has(key)
    ) {
      const timer = setTimeout(
        () => removeRotationCacheEntry(key, pending),
        REFRESH_CACHE_GRACE_MS,
      )
      timer.unref?.()
      rotationState.cacheTimers.set(key, timer)
    }
    return rotated
  } catch (error) {
    removeRotationCacheEntry(key, pending)
    throw error
  } finally {
    if (!shared && rotationState.inFlight.get(key) === pending) {
      rotationState.inFlight.delete(key)
    }
  }
}

/**
 * Report a problem with the version override to the server log.
 *
 * Best-effort: a misconfigured override either degrades to the bundled version
 * or is honoured as set, so a logging failure must not take the plugin down
 * with it.
 */
async function logVersionOverrideIssue(
  client: unknown,
  level: 'warn' | 'error',
  message: string,
): Promise<void> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose app.log
    await (client as any)?.app?.log({
      body: {
        service: 'anthropic-auth',
        level,
        message,
      },
    })
  } catch {
    /* Logging is best-effort; the resolved version still applies. */
  }
}

export const AnthropicAuthPlugin: Plugin = async ({ client }) => {
  const clientRefreshState = clientRefreshStateFor(client)
  // Resolved once per plugin instance so every request reports the same
  // version in both the user-agent and the billing header.
  const resolution = resolveClaudeCodeVersion()
  if (resolution.type === 'invalid') {
    await logVersionOverrideIssue(client, 'error', resolution.error)
  } else if (resolution.type === 'outdated') {
    await logVersionOverrideIssue(client, 'warn', resolution.warning)
  }
  // Only a malformed override lacks a usable version; an outdated one was set
  // deliberately, so it is reported as configured.
  const claudeCodeVersion =
    resolution.type === 'invalid' ? CLAUDE_CODE_VERSION : resolution.version

  // Keep a short-lived result for a consumed refresh token. This closes the
  // gap where another request still holds an expired credential snapshot after
  // the first request has rotated and persisted the token.
  const removeClientCacheEntry = (
    key: string,
    expected?: Promise<OAuthCredential>,
  ) => {
    if (expected && clientRefreshState.cache.get(key) !== expected) return
    clientRefreshState.cache.delete(key)
    const timer = clientRefreshState.cacheTimers.get(key)
    if (timer) clearTimeout(timer)
    clientRefreshState.cacheTimers.delete(key)
  }

  const refreshAccess = async (
    getAuth: () => Promise<AuthState>,
  ): Promise<string> => {
    // The caller's auth snapshot can be stale. A different request may already
    // have persisted a valid rotated credential while this one was waiting.
    const freshAuth = await getAuth()
    if (freshAuth.type !== 'oauth') {
      throw reconnectError('Anthropic OAuth credentials are no longer active')
    }
    const expires = freshAuth.expires
    if (
      isBoundedToken(freshAuth.access) &&
      typeof expires === 'number' &&
      Number.isSafeInteger(expires) &&
      expires > Date.now()
    ) {
      return freshAuth.access
    }
    if (!isBoundedToken(freshAuth.refresh)) {
      throw reconnectError(
        'Anthropic OAuth refresh token is missing or invalid',
      )
    }

    const key = refreshTokenKey(freshAuth.refresh)
    if (!key) {
      throw reconnectError(
        'Anthropic OAuth refresh token is missing or invalid',
      )
    }
    const cached = clientRefreshState.cache.get(key)
    if (cached) return (await cached).access
    if (clientRefreshState.cache.size >= MAX_REFRESH_CACHE_ENTRIES) {
      throw reconnectError(
        'Anthropic token refresh is blocked until the persisted-token cache expires',
      )
    }

    const pending = rotateCredential(freshAuth.refresh, key).then((rotated) =>
      persistRotatedCredential(client, rotated),
    )
    clientRefreshState.cache.set(key, pending)

    try {
      const rotated = await pending
      if (
        clientRefreshState.cache.get(key) === pending &&
        !clientRefreshState.cacheTimers.has(key)
      ) {
        const timer = setTimeout(
          () => removeClientCacheEntry(key, pending),
          REFRESH_CACHE_GRACE_MS,
        )
        timer.unref?.()
        clientRefreshState.cacheTimers.set(key, timer)
      }
      return rotated.access
    } catch (error) {
      removeClientCacheEntry(key, pending)
      throw error
    }
  }

  return {
    auth: {
      provider: 'anthropic',
      async loader(
        getAuth: () => Promise<{
          type: string
          access?: string
          refresh?: string
          expires?: number
        }>,
        provider: { models: Record<string, { cost: unknown }> },
      ) {
        const auth = await getAuth()
        if (auth.type === 'oauth') {
          // zero out cost for max plan
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            }
          }

          return {
            apiKey: '',
            async fetch(input: string | URL | Request, init?: RequestInit) {
              const auth = await getAuth()
              if (auth.type !== 'oauth') return fetch(input, init)
              const accessExpires = auth.expires
              const hasUsableAccess =
                isBoundedToken(auth.access) &&
                typeof accessExpires === 'number' &&
                Number.isSafeInteger(accessExpires) &&
                accessExpires > Date.now()
              if (!hasUsableAccess) {
                auth.access = await refreshAccess(getAuth)
              }

              const requestHeaders = mergeHeaders(input, init)
              // biome-ignore lint/style/noNonNullAssertion: access is guaranteed set above
              setOAuthHeaders(requestHeaders, auth.access!, claudeCodeVersion)

              let body = init?.body
              if (body && typeof body === 'string') {
                body = rewriteRequestBody(body, claudeCodeVersion)
              }

              const rewritten = rewriteUrl(input)

              const response = await fetch(rewritten.input, {
                ...init,
                body,
                headers: requestHeaders,
                ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
              })

              return createStrippedStream(response)
            },
          }
        }

        return {}
      },
      methods: [
        {
          label: 'Claude Pro/Max',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('max')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                return exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
              },
            }
          },
        },
        {
          label: 'Create an API Key',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('console')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                const credentials = await exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
                if (credentials.type === 'failed') return credentials
                const apiKey = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((r) => r.json() as Promise<{ raw_key: string }>)
                return { type: 'success' as const, key: apiKey.raw_key }
              },
            }
          },
        },
        {
          provider: 'anthropic',
          label: 'Manually enter API Key',
          type: 'api',
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: Plugin type doesn't include undocumented auth/hooks
  } as any
}
