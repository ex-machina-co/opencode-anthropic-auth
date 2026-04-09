import type { Plugin } from '@opencode-ai/plugin'
import { authorize, exchange } from './auth'
import { CLIENT_ID, TOKEN_URL } from './constants'
import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform'

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

          // Shared inflight refresh promise — prevents concurrent token refreshes
          // from racing against each other (and causing 401 cascades with token rotation)
          let refreshPromise: Promise<string> | null = null

          return {
            apiKey: '',
            async fetch(input: string | URL | Request, init?: RequestInit) {
              const auth = await getAuth()
              if (auth.type !== 'oauth') return fetch(input, init)
              if (!auth.access || !auth.expires || auth.expires < Date.now()) {
                if (!refreshPromise) {
                  refreshPromise = (async () => {
                    const maxRetries = 2
                    const baseDelayMs = 500

                    for (let attempt = 0; attempt <= maxRetries; attempt++) {
                      try {
                        if (attempt > 0) {
                          const delay = baseDelayMs * 2 ** (attempt - 1)
                          await new Promise((resolve) =>
                            setTimeout(resolve, delay),
                          )
                        }

                        const response = await fetch(TOKEN_URL, {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            Accept: 'application/json, text/plain, */*',
                            'User-Agent': 'axios/1.13.6',
                          },
                          body: JSON.stringify({
                            grant_type: 'refresh_token',
                            refresh_token: auth.refresh,
                            client_id: CLIENT_ID,
                          }),
                        })

                        if (!response.ok) {
                          if (response.status >= 500 && attempt < maxRetries) {
                            await response.body?.cancel()
                            continue
                          }

                          const body = await response.text().catch(() => '')
                          throw new Error(
                            `Token refresh failed: ${response.status} — ${body}`,
                          )
                        }

                        const json = (await response.json()) as {
                          refresh_token: string
                          access_token: string
                          expires_in: number
                        }

                        // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
                        await (client as any).auth.set({
                          path: {
                            id: 'anthropic',
                          },
                          body: {
                            type: 'oauth',
                            refresh: json.refresh_token,
                            access: json.access_token,
                            expires: Date.now() + json.expires_in * 1000,
                          },
                        })

                        return json.access_token
                      } catch (error) {
                        const isNetworkError =
                          error instanceof Error &&
                          (error.message.includes('fetch failed') ||
                            ('code' in error &&
                              (error.code === 'ECONNRESET' ||
                                error.code === 'ECONNREFUSED' ||
                                error.code === 'ETIMEDOUT' ||
                                error.code === 'UND_ERR_CONNECT_TIMEOUT')))

                        if (attempt < maxRetries && isNetworkError) {
                          continue
                        }

                        throw error
                      }
                    }
                    // Unreachable — each iteration either returns or throws.
                    // Kept as a TypeScript exhaustiveness guard.
                    throw new Error('Token refresh exhausted all retries')
                  })().finally(() => {
                    refreshPromise = null
                  })
                }
                auth.access = await refreshPromise
              }

              const requestHeaders = mergeHeaders(input, init)
              // biome-ignore lint/style/noNonNullAssertion: access is guaranteed set above
              setOAuthHeaders(requestHeaders, auth.access!)

              let body = init?.body
              if (body && typeof body === 'string') {
                body = rewriteRequestBody(body)
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
