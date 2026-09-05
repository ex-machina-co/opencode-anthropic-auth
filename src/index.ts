import { createHash, createHmac, type Hmac, randomBytes } from 'node:crypto'
import { type Credential, Plugin } from '@opencode-ai/plugin'
import { authorize, exchange, refreshToken } from './auth.ts'
import { BodyLimitError, contentLength, readBoundedText } from './bounded.ts'
import { resolveClaudeCodeVersion } from './config.ts'
import { CLAUDE_CODE_VERSION, REQUIRED_BETAS } from './constants.ts'
import {
  createConnectionLabel,
  describeConnection,
  enhanceRateLimitResponse,
} from './rate-limit.ts'
import {
  createStrippedStream,
  headersAfterBodyTransform,
  isInsecure,
  isTrustedAnthropicUrl,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
  ToolNameAliasTable,
} from './transform.ts'

const PLUGIN_ID = 'ex-machina.anthropic-auth'
const INTEGRATION_ID = 'anthropic'
const REFRESH_CACHE_GRACE_MS = 30_000
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024
const MAX_ACTIVE_ALIAS_REQUESTS = 256
const MAX_REQUEST_ALIAS_ENTRIES = 256
const MAX_REQUEST_ALIAS_BYTES = 16 * 1024
const ALIAS_REQUEST_TTL_MS = 5 * 60_000
const MAX_BLOCKED_REFRESH_TOKENS = 1024
const BLOCKED_REFRESH_FILTER_BYTES = 8 * 1024
const BLOCKED_REFRESH_FILTER_HASHES = 4
const MAX_REFRESH_TOKEN_BYTES = 8 * 1024
const MAX_REFRESH_IN_FLIGHT = 256
const MAX_REFRESH_CACHE_ENTRIES = 256
const MAX_TRACKED_CONNECTIONS = 256
const CONNECTION_TRACKING_TTL_MS = 5 * 60_000
const MAX_ACTIVE_RESPONSE_TRANSFORMS = 256
const MAX_RECONSTRUCTED_ALIAS_LOOKUPS = 32
const MAX_TRACKED_REQUEST_URL_BYTES = 8 * 1024
const UNKNOWN_CONNECTION = 'Unknown OAuth connection'
const AMBIGUOUS_CONNECTION = 'Ambiguous OAuth connection'

// setup() is location-scoped while the credential store is process-global.
// Share only active rotations; settled credentials remain location-local.
const refreshInFlight = new Map<string, Promise<Credential.OAuth>>()
const blockedRefreshTokens = new Map<string, number>()
// Overflow identities intentionally never expire, rotate, or lose bits:
// forgetting one could replay a refresh token whose prior outcome was
// ambiguous. The fixed-size filter bounds memory and fails closed; its
// false-positive probability therefore grows over the process lifetime.
const blockedRefreshTokenFilter = new Uint8Array(BLOCKED_REFRESH_FILTER_BYTES)
let activeResponseTransforms = 0

function acquireResponseTransform(): () => void {
  if (activeResponseTransforms >= MAX_ACTIVE_RESPONSE_TRANSFORMS) {
    throw new Error('Too many active Anthropic response transforms')
  }
  activeResponseTransforms += 1
  let active = true
  return () => {
    if (!active) return
    active = false
    activeResponseTransforms -= 1
  }
}

function refreshTokenKey(refreshToken: string): string | undefined {
  if (
    refreshToken.length === 0 ||
    refreshToken.length > MAX_REFRESH_TOKEN_BYTES
  ) {
    return undefined
  }
  const bytes = new TextEncoder().encode(refreshToken)
  if (bytes.byteLength > MAX_REFRESH_TOKEN_BYTES) return undefined
  return createHash('sha256').update(bytes).digest('base64url')
}

function isAmbiguousRefreshFailure(status: number): boolean {
  return status === 0 || status >= 500 || (status >= 200 && status < 300)
}

function blockedRefreshFilterIndexes(key: string): number[] {
  const digest = createHash('sha256').update(`blocked:${key}`).digest()
  const bits = BLOCKED_REFRESH_FILTER_BYTES * 8
  return Array.from(
    { length: BLOCKED_REFRESH_FILTER_HASHES },
    (_, index) => digest.readUInt32BE(index * 4) % bits,
  )
}

function addBlockedRefreshToFilter(key: string): void {
  for (const index of blockedRefreshFilterIndexes(key)) {
    const byteIndex = index >> 3
    blockedRefreshTokenFilter[byteIndex] =
      (blockedRefreshTokenFilter[byteIndex] ?? 0) | (1 << (index & 7))
  }
}

function blockedRefreshFilterHas(key: string): boolean {
  return blockedRefreshFilterIndexes(key).every(
    (index) =>
      ((blockedRefreshTokenFilter[index >> 3] ?? 0) & (1 << (index & 7))) !== 0,
  )
}

function blockRefreshToken(key: string, status: number): void {
  if (blockedRefreshTokens.has(key) || blockedRefreshFilterHas(key)) return
  if (blockedRefreshTokens.size >= MAX_BLOCKED_REFRESH_TOKENS) {
    addBlockedRefreshToFilter(key)
    return
  }
  blockedRefreshTokens.set(key, status)
}

function blockedRefreshError(key: string): Error | undefined {
  const status = blockedRefreshTokens.get(key)
  if (status !== undefined) {
    return new Error(
      `Anthropic token refresh blocked after ambiguous failure: ${status}`,
    )
  }
  if (blockedRefreshFilterHas(key)) {
    return new Error(
      'Anthropic token refresh blocked after an ambiguous failure',
    )
  }
  return undefined
}

// `methodID` is a branded `Integration.MethodID` at the type level (a
// compile-time-only tag — there's no runtime representation), so a plain
// string literal needs a cast to satisfy the branded field.
const METHOD_ID = 'claude-max' as Credential.OAuth['methodID']

function toCredential(exchanged: {
  refresh: string
  access: string
  expires: number
}): Credential.OAuth {
  return {
    type: 'oauth',
    methodID: METHOD_ID,
    refresh: exchanged.refresh,
    access: exchanged.access,
    expires: exchanged.expires,
  }
}

async function resolveActiveOAuth(ctx: Plugin.Context): Promise<
  | {
      readonly connection: {
        readonly type: string
        readonly id?: string
        readonly label?: string
      }
      readonly credential: Credential.OAuth
    }
  | undefined
> {
  const connection = await ctx.integration.connection.active(INTEGRATION_ID)
  if (!connection) return undefined

  const credential = await ctx.integration.connection.resolve(connection)
  if (credential?.type === 'oauth' && credential.methodID === METHOD_ID) {
    return { connection, credential }
  }

  return undefined
}

function hasTransformedOAuthShape(request: Request): boolean {
  const url = new URL(request.url)
  const betas = new Set(
    (request.headers.get('anthropic-beta') ?? '')
      .split(',')
      .map((beta) => beta.trim()),
  )
  return (
    request.method === 'POST' &&
    isTrustedAnthropicUrl(url) &&
    request.headers.get('authorization')?.startsWith('Bearer ') === true &&
    REQUIRED_BETAS.every((beta) => betas.has(beta)) &&
    url.pathname === '/v1/messages'
  )
}

const ownershipEncoder = new TextEncoder()

function updateFramed(hmac: Hmac, bytes: Uint8Array): void {
  const length = new Uint8Array(8)
  new DataView(length.buffer).setBigUint64(0, BigInt(bytes.byteLength))
  hmac.update(length)
  hmac.update(bytes)
}

function requestLeaseKey(
  ownershipKey: Uint8Array,
  request: Request,
  body: string,
): string | undefined {
  const authorizationKey = requestAuthorizationKey(request)
  if (!authorizationKey) return undefined
  const urlBytes = ownershipEncoder.encode(request.url)
  if (urlBytes.byteLength > MAX_TRACKED_REQUEST_URL_BYTES) return undefined
  const bodyBytes = ownershipEncoder.encode(body)
  const hmac = createHmac('sha256', ownershipKey)
  hmac.update('opencode-anthropic-auth/request-ownership/v1')
  updateFramed(hmac, ownershipEncoder.encode(request.method))
  updateFramed(hmac, urlBytes)
  updateFramed(hmac, ownershipEncoder.encode(authorizationKey))
  updateFramed(hmac, bodyBytes)
  return `${bodyBytes.byteLength}:${hmac.digest('base64url')}`
}

function requestAuthorizationKey(request: Request): string | undefined {
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return undefined
  const token = authorization.slice('Bearer '.length)
  if (token.length === 0 || token.length > MAX_REFRESH_TOKEN_BYTES) {
    return undefined
  }
  const bytes = new TextEncoder().encode(token)
  if (bytes.byteLength > MAX_REFRESH_TOKEN_BYTES) return undefined
  return createHash('sha256').update(bytes).digest('base64url')
}

type AliasLease = {
  readonly key: string
  readonly aliases: ToolNameAliasTable
  references: number
  activeResponses: number
  active: boolean
  retired: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

function warnIfInsecureUnsupported() {
  if (!isInsecure()) return
  console.warn(
    '[ex-machina.anthropic-auth] ANTHROPIC_INSECURE is set, but OpenCode v2 ' +
      'plugin request hooks cannot disable TLS verification for a custom ' +
      'ANTHROPIC_BASE_URL endpoint. TLS verification remains enabled — ' +
      'requests to an untrusted/self-signed endpoint will fail.',
  )
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup: async (ctx) => {
    warnIfInsecureUnsupported()
    // Resolve once so user-agent and billing metadata agree for every request
    // handled by this plugin generation.
    const versionResolution = resolveClaudeCodeVersion()
    if (versionResolution.type === 'invalid') {
      console.error(`[ex-machina.anthropic-auth] ${versionResolution.error}`)
    } else if (versionResolution.type === 'outdated') {
      console.warn(`[ex-machina.anthropic-auth] ${versionResolution.warning}`)
    }
    const claudeCodeVersion =
      versionResolution.type === 'invalid'
        ? CLAUDE_CODE_VERSION
        : versionResolution.version

    const aliasesByRequest = new WeakMap<Request, AliasLease>()
    const aliasesByFingerprint = new Map<string, AliasLease>()
    const transformedRequests = new WeakSet<Request>()
    const ownershipKey = randomBytes(32)
    let reconstructedAliasLookups = 0
    let setupActive = true
    const connectionByRequest = new WeakMap<Request, string>()
    const connectionByAuthorization = new Map<
      string,
      {
        readonly description: string
        readonly timer: ReturnType<typeof setTimeout>
      }
    >()

    const rememberConnection = (
      request: Request,
      description: string,
    ): void => {
      connectionByRequest.set(request, description)
      const key = requestAuthorizationKey(request)
      if (!key) return

      const existing = connectionByAuthorization.get(key)
      if (
        !existing &&
        connectionByAuthorization.size >= MAX_TRACKED_CONNECTIONS
      ) {
        return
      }
      if (existing) clearTimeout(existing.timer)

      const retainedDescription =
        !existing || existing.description === description
          ? description
          : AMBIGUOUS_CONNECTION
      let entry!: {
        readonly description: string
        readonly timer: ReturnType<typeof setTimeout>
      }
      const timer = setTimeout(() => {
        if (connectionByAuthorization.get(key) === entry) {
          connectionByAuthorization.delete(key)
        }
      }, CONNECTION_TRACKING_TTL_MS)
      timer.unref?.()
      entry = { description: retainedDescription, timer }
      connectionByAuthorization.set(key, entry)
    }

    const connectionForRequest = (request: Request): string => {
      const direct = connectionByRequest.get(request)
      if (direct) return direct
      const key = requestAuthorizationKey(request)
      if (!key) return UNKNOWN_CONNECTION
      return (
        connectionByAuthorization.get(key)?.description ?? UNKNOWN_CONNECTION
      )
    }

    const clearAliasLeaseTimer = (lease: AliasLease): void => {
      if (lease.timer === undefined) return
      clearTimeout(lease.timer)
      lease.timer = undefined
    }

    const expireAliasLease = (lease: AliasLease): void => {
      if (!lease.active) return
      lease.active = false
      if (aliasesByFingerprint.get(lease.key) === lease) {
        aliasesByFingerprint.delete(lease.key)
      }
      clearAliasLeaseTimer(lease)
      lease.aliases.dispose()
    }

    const scheduleAliasLeaseExpiry = (lease: AliasLease): void => {
      if (!lease.active || lease.retired || lease.activeResponses > 0) return
      clearAliasLeaseTimer(lease)
      const timer = setTimeout(() => {
        if (lease.timer !== timer) return
        lease.timer = undefined
        if (lease.activeResponses === 0) expireAliasLease(lease)
      }, ALIAS_REQUEST_TTL_MS)
      timer.unref?.()
      lease.timer = timer
    }

    const beginAliasResponse = (lease: AliasLease): void => {
      if (!lease.active || lease.retired) return
      if (lease.references <= lease.activeResponses) lease.references += 1
      lease.activeResponses += 1
      clearAliasLeaseTimer(lease)
    }

    const retireAliasLease = (lease: AliasLease): void => {
      if (!lease.active || lease.retired) return
      lease.retired = true
      if (aliasesByFingerprint.get(lease.key) === lease) {
        aliasesByFingerprint.delete(lease.key)
      }
      clearAliasLeaseTimer(lease)
      if (lease.activeResponses === 0) {
        expireAliasLease(lease)
      } else {
        lease.references = lease.activeResponses
      }
    }

    const releaseAliasLease = (request: Request, lease: AliasLease): void => {
      aliasesByRequest.delete(request)
      if (!lease.active) return
      if (lease.activeResponses > 0) lease.activeResponses -= 1
      lease.references -= 1
      if (
        lease.references <= 0 ||
        (lease.retired && lease.activeResponses === 0)
      ) {
        expireAliasLease(lease)
      } else {
        scheduleAliasLeaseExpiry(lease)
      }
    }

    const registerAliasLease = (
      request: Request,
      body: string,
      aliases: ToolNameAliasTable,
    ): void => {
      const key = requestLeaseKey(ownershipKey, request, body)
      if (!key) {
        aliases.dispose()
        throw new Error('Unable to track transformed Anthropic request')
      }
      const existing = aliasesByFingerprint.get(key)
      if (existing?.active && !existing.retired) {
        aliases.dispose()
        existing.references += 1
        aliasesByRequest.set(request, existing)
        scheduleAliasLeaseExpiry(existing)
        return
      }
      if (aliasesByFingerprint.size >= MAX_ACTIVE_ALIAS_REQUESTS) {
        aliases.dispose()
        throw new Error('Too many active Anthropic tool-name alias mappings')
      }

      const lease: AliasLease = {
        key,
        aliases,
        references: 1,
        activeResponses: 0,
        active: true,
        retired: false,
        timer: undefined,
      }
      aliasesByFingerprint.set(key, lease)
      aliasesByRequest.set(request, lease)
      scheduleAliasLeaseExpiry(lease)
    }

    const resolveAliasLease = async (
      request: Request,
    ): Promise<AliasLease | undefined> => {
      const direct = aliasesByRequest.get(request)
      if (direct?.active && !direct.retired) {
        beginAliasResponse(direct)
        return direct
      }
      if (direct) aliasesByRequest.delete(request)
      if (!request.body) return undefined
      if (request.bodyUsed || request.body.locked) return undefined
      if (reconstructedAliasLookups >= MAX_RECONSTRUCTED_ALIAS_LOOKUPS) {
        return undefined
      }
      reconstructedAliasLookups += 1
      try {
        const declaredLength = contentLength(request.headers)
        if (
          declaredLength !== undefined &&
          declaredLength > MAX_REQUEST_BODY_BYTES
        ) {
          throw new BodyLimitError(
            'Anthropic request body',
            MAX_REQUEST_BODY_BYTES,
          )
        }
        const body = await readBoundedText(
          request.clone().body,
          MAX_REQUEST_BODY_BYTES,
          'Anthropic request body',
        )
        const key = requestLeaseKey(ownershipKey, request, body)
        if (!key) return undefined
        const lease = aliasesByFingerprint.get(key)
        if (!lease?.active) return undefined
        beginAliasResponse(lease)
        aliasesByRequest.set(request, lease)
        return lease
      } finally {
        reconstructedAliasLookups -= 1
      }
    }

    // Retain successful refreshes for this location so a host call
    // holding the rotated token cannot submit it again before persistence.
    const refreshCache = new Map<string, Promise<Credential.OAuth>>()
    const refreshCacheTimers = new Map<string, ReturnType<typeof setTimeout>>()

    const removeRefreshCacheEntry = (
      key: string,
      expected?: Promise<Credential.OAuth>,
    ): void => {
      if (expected && refreshCache.get(key) !== expected) return
      refreshCache.delete(key)
      const timer = refreshCacheTimers.get(key)
      if (timer) clearTimeout(timer)
      refreshCacheTimers.delete(key)
    }

    const makeRefreshCacheRoom = (): void => {
      if (refreshCache.size < MAX_REFRESH_CACHE_ENTRIES) return
      throw new Error(
        'Anthropic token refresh blocked until the consumed-token cache expires',
      )
    }

    const refreshCredential = async (credential: Credential.OAuth) => {
      const key = refreshTokenKey(credential.refresh)
      if (!key) throw new Error('Anthropic token refresh failed: 400')
      const existing = refreshCache.get(key)
      if (existing) return existing

      const shared = refreshInFlight.get(key)
      if (!shared) {
        const blocked = blockedRefreshError(key)
        if (blocked) throw blocked
      }
      if (!shared && refreshInFlight.size >= MAX_REFRESH_IN_FLIGHT) {
        throw new Error('Too many active Anthropic token refreshes')
      }
      makeRefreshCacheRoom()
      const pending =
        shared ??
        (async () => {
          let result: Awaited<ReturnType<typeof refreshToken>>
          try {
            result = await refreshToken(credential.refresh)
          } catch (error) {
            blockRefreshToken(key, 0)
            throw error
          }
          if (result.type === 'failed') {
            if (isAmbiguousRefreshFailure(result.status)) {
              blockRefreshToken(key, result.status)
            }
            throw new Error(`Anthropic token refresh failed: ${result.status}`)
          }
          return toCredential(result)
        })()

      refreshCache.set(key, pending)
      if (!shared) refreshInFlight.set(key, pending)

      try {
        const rotated = await pending
        if (refreshCache.get(key) === pending) {
          const timer = setTimeout(
            () => removeRefreshCacheEntry(key, pending),
            REFRESH_CACHE_GRACE_MS,
          )
          timer.unref?.()
          refreshCacheTimers.set(key, timer)
        }
        return rotated
      } catch (error) {
        removeRefreshCacheEntry(key, pending)
        throw error
      } finally {
        if (!shared && refreshInFlight.get(key) === pending) {
          refreshInFlight.delete(key)
        }
      }
    }

    await ctx.integration.transform((draft) => {
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_ID,
          type: 'oauth',
          label: 'Claude Pro/Max',
        },
        authorize: async () => {
          const result = await authorize('max')
          return {
            url: result.url,
            instructions: 'Paste the authorization code here:',
            mode: 'code',
            callback: async (code: string) => {
              const exchanged = await exchange(
                code,
                result.verifier,
                result.redirectUri,
                result.state,
              )
              if (exchanged.type === 'failed') {
                throw new Error(
                  'Failed to exchange the Claude Pro/Max authorization code. ' +
                    'Double-check that you pasted the full code and try again.',
                )
              }
              return toCredential(exchanged)
            },
          }
        },
        refresh: refreshCredential,
        label: () => createConnectionLabel(),
      })
    })

    await ctx.session.hook('http.request', async (event) => {
      if (!setupActive) return
      if (event.model.providerID !== INTEGRATION_ID) return
      const active = await resolveActiveOAuth(ctx)
      if (!setupActive || !active) return
      const { credential } = active
      const connectionDescription = describeConnection(active.connection)

      const request = event.request
      const rewritten = rewriteUrl(request)
      if (!rewritten.url || !isTrustedAnthropicUrl(rewritten.url)) {
        throw new Error(
          'Refusing to send Anthropic OAuth credentials to an untrusted origin',
        )
      }

      const pathname = rewritten.url.pathname
      const transformsBody =
        request.method === 'POST' &&
        (pathname === '/v1/messages' ||
          pathname === '/v1/messages/count_tokens')

      if (!transformsBody) {
        const headers = mergeHeaders(request)
        setOAuthHeaders(headers, credential.access, claudeCodeVersion)
        const routedRequest =
          rewritten.input instanceof Request
            ? rewritten.input
            : new Request(rewritten.url.toString(), request)
        event.request = new Request(routedRequest, {
          headers,
          signal: request.signal,
          redirect: 'error',
        })
        rememberConnection(event.request, connectionDescription)
        return
      }

      const hasBody = request.body !== null
      const declaredLength = contentLength(request.headers)
      if (
        hasBody &&
        declaredLength !== undefined &&
        declaredLength > MAX_REQUEST_BODY_BYTES
      ) {
        throw new BodyLimitError(
          'Anthropic request body',
          MAX_REQUEST_BODY_BYTES,
        )
      }
      const bodyText = hasBody
        ? await readBoundedText(
            request.clone().body,
            MAX_REQUEST_BODY_BYTES,
            'Anthropic request body',
          )
        : undefined
      if (!setupActive) return
      const aliases = new ToolNameAliasTable({
        maxEntries: MAX_REQUEST_ALIAS_ENTRIES,
        maxBytes: MAX_REQUEST_ALIAS_BYTES,
      })
      let rewrittenBody: string | undefined
      try {
        rewrittenBody =
          bodyText !== undefined
            ? rewriteRequestBody(bodyText, claudeCodeVersion, aliases)
            : undefined
      } catch (error) {
        aliases.dispose()
        throw error
      }

      const bodyChanged = bodyText !== undefined && rewrittenBody !== bodyText

      const headers = bodyChanged
        ? headersAfterBodyTransform(mergeHeaders(request))
        : mergeHeaders(request)
      setOAuthHeaders(headers, credential.access, claudeCodeVersion)

      const rewrittenRequest = new Request(rewritten.url.toString(), {
        method: request.method,
        headers,
        body: rewrittenBody,
        signal: request.signal,
        redirect: 'error',
      })

      event.request = rewrittenRequest
      if (pathname === '/v1/messages' && rewrittenBody !== undefined) {
        try {
          registerAliasLease(event.request, rewrittenBody, aliases)
        } catch (error) {
          event.request = request
          throw error
        }
      } else {
        aliases.dispose()
      }
      if (pathname === '/v1/messages') {
        transformedRequests.add(event.request)
      }
      rememberConnection(event.request, connectionDescription)
    })

    await ctx.session.hook('http.response', async (event) => {
      if (!setupActive) return
      if (event.model.providerID !== INTEGRATION_ID) return
      if (!hasTransformedOAuthShape(event.request)) return
      const ownedDirectly = transformedRequests.has(event.request)
      let lease: AliasLease | undefined
      try {
        lease = await resolveAliasLease(event.request)
      } catch {
        if (!ownedDirectly) return
        // A direct plugin-owned response survives a best-effort lease failure.
      }
      if (!ownedDirectly && !lease) return
      if (!event.response.ok) {
        if (lease) releaseAliasLease(event.request, lease)
        if (event.response.status === 429) {
          const enhanced = await enhanceRateLimitResponse(
            event.response,
            connectionForRequest(event.request),
          )
          event.response = enhanced.response
        }
        return
      }
      const aliases =
        lease?.aliases ?? new ToolNameAliasTable({ maxEntries: 0, maxBytes: 0 })
      const releaseAliases = () => {
        if (lease) releaseAliasLease(event.request, lease)
        else aliases.dispose()
      }
      let releaseTransform: (() => void) | undefined
      try {
        releaseTransform = acquireResponseTransform()
        event.response = createStrippedStream(event.response, aliases, () => {
          releaseAliases()
          releaseTransform?.()
        })
      } catch (error) {
        releaseTransform?.()
        releaseAliases()
        throw error
      }
    })

    return () => {
      setupActive = false
      for (const lease of aliasesByFingerprint.values()) retireAliasLease(lease)
      aliasesByFingerprint.clear()
      for (const entry of connectionByAuthorization.values()) {
        clearTimeout(entry.timer)
      }
      connectionByAuthorization.clear()
      for (const timer of refreshCacheTimers.values()) clearTimeout(timer)
      refreshCacheTimers.clear()
      refreshCache.clear()
    }
  },
})
