import type { Plugin } from '@opencode-ai/plugin'
import { AccountStore, computeCooldownUntil } from './accounts.ts'
import { authorize, exchange } from './auth.ts'
import { debugLog, inspectStream, isFailoverStatus } from './failover.ts'
import { fetchAccountProfile } from './profile.ts'
import { refreshAccessToken } from './refresh.ts'
import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

/**
 * Add a freshly-authenticated login to the plugin's account store so it joins
 * automatic failover. The account is labeled by its email: taken from the token
 * response when present, otherwise resolved from the OAuth profile endpoint.
 * Best-effort — a store/profile failure must never block a successful login.
 *
 * The previously-active account is preserved separately: the request path
 * persists whatever credential occupies OpenCode's slot into the pool (see
 * `addIfAbsent` in the loader) before this login can overwrite it. The one
 * residual gap is a pre-existing credential that was never used for a single
 * request before this login — the SDK exposes no way to read OpenCode's current
 * credential here, so such an unused account can't be captured at login time.
 */
async function storeLoginAccount(credentials: {
  refresh: string
  access: string
  expires: number
  email?: string
}): Promise<void> {
  try {
    let email = credentials.email
    if (!email) {
      const profile = await fetchAccountProfile(credentials.access)
      email = profile?.email
    }
    const store = new AccountStore()
    store.add({
      refresh: credentials.refresh,
      access: credentials.access,
      expires: credentials.expires,
      email,
    })
    // OpenCode makes this login its active credential, so mark it primary.
    store.setPrimaryByRefresh(credentials.refresh)
  } catch {
    // Never block login on store/profile issues.
  }
}

export const AnthropicAuthPlugin: Plugin = async ({ client }) => {
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

          const store = new AccountStore()

          type Tokens = { access: string; refresh: string; expires: number }
          type Candidate = {
            id: string
            refresh: string
            access: string
            expires: number
            email?: string
          }

          // Per-account inflight refresh promises — prevents concurrent token
          // refreshes for the same account from racing (and causing 401
          // cascades under refresh-token rotation). Keyed by account id.
          const refreshPromises = new Map<string, Promise<Tokens>>()

          /**
           * The "primary" account is OpenCode's own `anthropic` credential.
           * We keep it as the first candidate for backward compatibility and
           * mirror any token rotation back to OpenCode via `client.auth.set`.
           */
          const PRIMARY_ID = '__opencode_primary__'

          /**
           * Persist rotated tokens: for the primary account write back to
           * OpenCode, otherwise update the plugin-owned account store. For the
           * primary we ALSO update its stored copy (matched by the pre-rotation
           * refresh token) so the account stays usable after it's demoted.
           */
          async function persistTokens(
            id: string,
            tokens: { refresh: string; access: string; expires: number },
            oldRefresh?: string,
          ) {
            if (id === PRIMARY_ID) {
              // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
              await (client as any).auth.set({
                path: { id: 'anthropic' },
                body: { type: 'oauth', ...tokens },
              })
              if (oldRefresh) store.updateTokensByRefresh(oldRefresh, tokens)
            } else {
              store.updateTokens(id, tokens)
            }
          }

          /**
           * Ensure a candidate has a valid (non-expired) token set, refreshing
           * if necessary. Deduplicates concurrent refreshes per id. Returns the
           * full token set so a working account can be promoted to primary.
           */
          async function ensureFreshTokens(candidate: {
            id: string
            refresh: string
            access: string
            expires: number
          }): Promise<Tokens> {
            if (
              candidate.access &&
              candidate.expires &&
              candidate.expires >= Date.now()
            ) {
              return {
                access: candidate.access,
                refresh: candidate.refresh,
                expires: candidate.expires,
              }
            }

            // Deduplicate by the REFRESH TOKEN, not the candidate id. The same
            // Claude account can appear both as the primary and as its store
            // twin (they share a refresh token); keying by token means those
            // concurrent refreshes share a single request instead of both
            // spending the same single-use token and one hitting invalid_grant.
            const key = candidate.refresh
            let inflight = refreshPromises.get(key)
            if (!inflight) {
              inflight = (async () => {
                const tokens = await refreshAccessToken(candidate.refresh)
                await persistTokens(candidate.id, tokens, candidate.refresh)
                return tokens
              })().finally(() => {
                refreshPromises.delete(key)
              })
              refreshPromises.set(key, inflight)
            }
            return inflight
          }

          /**
           * Promote a (non-primary) account into OpenCode's `anthropic` slot so
           * the next request starts from a healthy account. This self-heals a
           * dead primary (e.g. `invalid_grant`): after one failover, OpenCode's
           * own credential points at a working account instead of the dead one.
           *
           * The account being demoted here isn't lost: the request path already
           * persisted it into the pool (see `addIfAbsent` above), so it stays
           * available for future failover once any cooldown lapses.
           */
          async function promoteToPrimary(tokens: Tokens) {
            try {
              // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
              await (client as any).auth.set({
                path: { id: 'anthropic' },
                body: { type: 'oauth', ...tokens },
              })
              // Reflect the new primary in the store's `primary` flag.
              store.setPrimaryByRefresh(tokens.refresh)
            } catch {
              // Promotion is best-effort; never break the response over it.
            }
          }

          // Refresh tokens we've already tried to enrich with an email, so we
          // don't refetch the profile on every request. Keyed by refresh token
          // so it works for both store accounts and the primary slot.
          const enrichAttempted = new Set<string>()

          /**
           * Best-effort: resolve and store an email label for an account that
           * doesn't have one yet (e.g. accounts added before emails were
           * captured). Matched by refresh token so it also labels whichever
           * account currently occupies OpenCode's primary slot. Uses the
           * already-valid access token from the just-served request (no extra
           * refresh). Runs at most once per account per session; never throws.
           */
          async function enrichEmail(refresh: string, accessToken: string) {
            if (!refresh || !accessToken || enrichAttempted.has(refresh)) return
            enrichAttempted.add(refresh)
            // Only hit the profile endpoint if there's actually a store account
            // (without an email yet) that this would label.
            const target = store.list().find((a) => a.refresh === refresh)
            if (!target || target.email) return
            try {
              const profile = await fetchAccountProfile(accessToken)
              if (profile?.email) {
                store.setEmailByRefresh(refresh, profile.email)
                debugLog(`labeled account → ${profile.email}`)
              }
            } catch {
              // Ignore — labeling is cosmetic.
            }
          }

          /**
           * Build the ordered list of candidate accounts to try:
           *   1. the primary (OpenCode) account — UNLESS it is itself cooling
           *      down, in which case it is demoted to tier 3 so a healthy
           *      account is tried first instead of wasting a round-trip on the
           *      rate-limited slot,
           *   2. store accounts that are available (not cooling down),
           *   3. accounts that ARE cooling down (including the primary when it
           *      is cooling), as a LAST RESORT.
           *
           * Including cooling accounts (tier 3) is what prevents the session
           * from stalling: even if every account is on cooldown, we still try
           * them rather than surfacing an error and waiting for the user. A
           * cooldown may be stale (e.g. based on an over-long Retry-After), and
           * trying is strictly better than blocking.
           */
          function buildCandidates(current: {
            refresh?: string
            access?: string
            expires?: number
          }): Candidate[] {
            const candidates: Candidate[] = []
            const seen = new Set<string>()

            const now = Date.now()
            const all = store.list()

            // The primary's store twin (persisted up-front by the fetch handler)
            // carries the cooldown set by markFailover when the primary is
            // rate-limited. If it's cooling, skip tier 1: leaving `current.refresh`
            // out of `seen` lets the tier 3 loop surface the twin (by its store
            // id) as a last resort, after any healthy account — so the primary's
            // own cooldown is honored instead of being retried first every time.
            const primaryTwin = current.refresh
              ? all.find((a) => a.refresh === current.refresh)
              : undefined
            const primaryCooling =
              !!primaryTwin?.cooldownUntil && primaryTwin.cooldownUntil > now

            // Tier 1: the primary account (unless it is itself cooling down).
            if (current.refresh && !primaryCooling) {
              candidates.push({
                id: PRIMARY_ID,
                refresh: current.refresh,
                access: current.access ?? '',
                expires: current.expires ?? 0,
                // If the primary is also in the store, reuse its email.
                email: primaryTwin?.email,
              })
              seen.add(current.refresh)
            }

            // Tier 2: available store accounts.
            for (const account of all) {
              if (seen.has(account.refresh)) continue
              if (account.cooldownUntil && account.cooldownUntil > now) continue
              candidates.push({
                id: account.id,
                refresh: account.refresh,
                access: account.access,
                expires: account.expires,
                email: account.email,
              })
              seen.add(account.refresh)
            }

            // Tier 3: cooling store accounts (last resort). A cooling primary is
            // surfaced here via its twin, so a healthy tier-2 account wins over it.
            for (const account of all) {
              if (seen.has(account.refresh)) continue
              candidates.push({
                id: account.id,
                refresh: account.refresh,
                access: account.access,
                expires: account.expires,
                email: account.email,
              })
              seen.add(account.refresh)
            }

            return candidates
          }

          /**
           * Put a candidate on cooldown so it's skipped next time. For the
           * primary we cool its matching store entry (by refresh token) so that
           * once another account is promoted, the demoted-but-exhausted account
           * isn't immediately treated as available and retried.
           *
           * `refresh` MUST be the account's CURRENT refresh token. When the
           * primary was refreshed earlier this request, `ensureFreshTokens`
           * rotated its token and `updateTokensByRefresh` already moved the store
           * twin onto the new token — so the caller must pass `tokens.refresh`
           * (the post-rotation value), not the stale pre-rotation
           * `candidate.refresh`, or the lookup would miss and the cooldown would
           * be silently dropped.
           */
          function markFailover(
            candidate: { id: string; refresh: string },
            refresh: string,
            until: number,
            reason: string,
          ) {
            if (candidate.id === PRIMARY_ID) {
              store.markCooldownByRefresh(refresh, until, reason)
            } else {
              store.markCooldown(candidate.id, until, reason)
            }
          }

          return {
            apiKey: '',
            async fetch(input: string | URL | Request, init?: RequestInit) {
              const current = await getAuth()
              if (current.type !== 'oauth') return fetch(input, init)

              // Persist OpenCode's current credential into the pool the first
              // time we see it, THEN flag it primary. Persisting up-front is what
              // stops the "prior account lost on new login" case: a later login
              // overwrites OpenCode's slot, and a failover promotion demotes this
              // account — either way it survives in the pool and keeps taking
              // part in failover. Insert-only, so an already-stored account (and
              // its cooldown) is untouched; safe to call on every request.
              if (current.refresh) {
                store.addIfAbsent({
                  refresh: current.refresh,
                  access: current.access ?? '',
                  expires: current.expires ?? 0,
                })
                store.setPrimaryByRefresh(current.refresh)
              }

              const candidates = buildCandidates(current)
              debugLog(
                `request: ${candidates.length} candidate account(s)`,
                candidates.map((c) =>
                  c.id === PRIMARY_ID
                    ? 'primary'
                    : (c.email ?? c.id.slice(0, 8)),
                ),
              )

              let body = init?.body
              if (body && typeof body === 'string') {
                body = rewriteRequestBody(body)
              } else if (body != null) {
                // A non-string body (ReadableStream/Blob/BufferSource) can only
                // be consumed once. Buffer it up front so every failover
                // candidate re-sends the same bytes instead of the first fetch
                // draining it and retries sending an empty body.
                body = new Uint8Array(
                  // biome-ignore lint/suspicious/noExplicitAny: BodyInit is broad
                  await new Response(body as any).arrayBuffer(),
                )
              }
              const rewritten = rewriteUrl(input)

              let lastError: unknown

              for (let i = 0; i < candidates.length; i++) {
                const candidate = candidates[i]
                if (!candidate) continue
                const isLast = i === candidates.length - 1
                const isPrimary = candidate.id === PRIMARY_ID
                const tag = isPrimary
                  ? 'primary'
                  : (candidate.email ?? candidate.id.slice(0, 8))

                // 1) Ensure a valid token, refreshing if needed. A refresh
                // failure (e.g. invalid_grant) is NOT surfaced — we cool the
                // account down and move on to the next candidate.
                let tokens: Tokens
                try {
                  tokens = await ensureFreshTokens(candidate)
                } catch (error) {
                  lastError = error
                  const reason =
                    error instanceof Error ? error.message : String(error)
                  // A dead refresh token won't recover soon — cool it down for
                  // an hour rather than retrying it on every request. The refresh
                  // FAILED, so no rotation happened and `candidate.refresh` is
                  // still the token the store twin holds.
                  markFailover(
                    candidate,
                    candidate.refresh,
                    Date.now() + 60 * 60_000,
                    reason,
                  )
                  debugLog(
                    `account ${tag}: refresh failed → ${reason}`,
                    isLast ? '(last candidate)' : '→ next account',
                  )
                  continue
                }

                const requestHeaders = mergeHeaders(input, init)
                setOAuthHeaders(requestHeaders, tokens.access)

                // 2) Issue the request. A network error also fails over.
                let response: Response
                try {
                  response = await fetch(rewritten.input, {
                    ...init,
                    body,
                    headers: requestHeaders,
                    ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
                  })
                } catch (error) {
                  lastError = error
                  debugLog(
                    `account ${tag}: network error → ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  )
                  continue
                }

                // Mark this candidate successful: promote (self-heal) + label.
                const onSuccess = async () => {
                  if (!isPrimary) {
                    await promoteToPrimary(tokens)
                    debugLog(`account ${tag}: OK → promoted to primary`)
                  } else {
                    debugLog(`account ${tag}: OK`)
                  }
                  if (!candidate.email) {
                    // Match by the (possibly rotated) current refresh token.
                    void enrichEmail(tokens.refresh, tokens.access)
                  }
                }

                // 3a) Hard failover HTTP status (429/401/403/529). The last
                // candidate is returned directly (real status + body); earlier
                // ones are cooled down and we move on.
                if (isFailoverStatus(response.status)) {
                  markFailover(
                    candidate,
                    // Post-rotation token: the store twin was moved onto it if
                    // ensureFreshTokens refreshed the primary above.
                    tokens.refresh,
                    computeCooldownUntil(response.headers.get('retry-after')),
                    `HTTP ${response.status}`,
                  )
                  if (isLast) {
                    debugLog(
                      `account ${tag}: HTTP ${response.status} (no more accounts)`,
                    )
                    return createStrippedStream(response)
                  }
                  debugLog(
                    `account ${tag}: HTTP ${response.status} → next account`,
                  )
                  lastError = new Error(`HTTP ${response.status}`)
                  await response.body?.cancel().catch(() => {})
                  continue
                }

                // 3b) A streaming 2xx whose SSE stream carries an error event
                // before any content (Anthropic returns 200 + an SSE `error`
                // event for rate/usage limits, sometimes a few events in).
                // Inspect only when failover is possible (more than one
                // candidate) AND the response is actually an event stream — so
                // the single-account path and non-streaming JSON responses are
                // forwarded directly with no added latency or buffering.
                const isEventStream =
                  response.headers
                    .get('content-type')
                    ?.includes('text/event-stream') ?? false
                if (
                  response.ok &&
                  response.body &&
                  isEventStream &&
                  candidates.length > 1
                ) {
                  const { isError, prefixText, stream } = await inspectStream(
                    response.body,
                  )
                  const rebuilt = new Response(stream, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                  })

                  if (isError) {
                    markFailover(
                      candidate,
                      // Post-rotation token (see the HTTP-error path above).
                      tokens.refresh,
                      computeCooldownUntil(response.headers.get('retry-after')),
                      'stream error (rate/usage limit)',
                    )
                    if (isLast) {
                      // No more accounts — surface the error stream as-is so the
                      // caller sees the genuine rate-limit event.
                      debugLog(
                        `account ${tag}: stream error (no more accounts)`,
                        prefixText.slice(0, 200),
                      )
                      return createStrippedStream(rebuilt)
                    }
                    debugLog(
                      `account ${tag}: stream error → next account`,
                      prefixText.slice(0, 200),
                    )
                    lastError = new Error('rate/usage limit (stream error)')
                    await stream.cancel().catch(() => {})
                    continue
                  }

                  await onSuccess()
                  return createStrippedStream(rebuilt)
                }

                // Otherwise stream/return as-is: the single-account path, or a
                // non-failover non-2xx error. Promote + label only on an actual
                // success so a passthrough error isn't treated as healthy.
                if (response.ok) {
                  await onSuccess()
                } else {
                  debugLog(
                    `account ${tag}: HTTP ${response.status} (passthrough)`,
                  )
                }
                return createStrippedStream(response)
              }

              // Reached only when the LAST candidate failed via a refresh or
              // network exception (every HTTP response is returned inside the
              // loop). Surface that error rather than a stale/misleading body.
              if (lastError) {
                debugLog('all candidates exhausted → throwing last error')
                throw lastError
              }
              // No candidates at all (no refresh token) — plain pass-through.
              return fetch(rewritten.input, {
                ...init,
                body,
                ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
              })
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
                const credentials = await exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
                // Mirror the login into the plugin-owned account store so it
                // joins automatic failover. Run this method again and log in
                // with a DIFFERENT Claude account to add more — each login is
                // stored (deduped by refresh token, labeled by email) and
                // becomes the current primary account.
                if (credentials.type === 'success') {
                  await storeLoginAccount(credentials)
                }
                return credentials
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
