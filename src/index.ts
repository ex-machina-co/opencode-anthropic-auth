import type { Plugin } from '@opencode-ai/plugin'
import { authorize, exchange } from './auth'
import { CLIENT_ID } from './constants'
import {
  createStrippedStream,
  mergeHeaders,
  prefixToolNames,
  rewriteUrl,
  setOAuthHeaders,
} from './transform'

export const AnthropicAuthPlugin: Plugin = async ({ client }) => {
  return {
    'experimental.chat.system.transform': (
      input: { model?: { providerID?: string } },
      output: { system: string[] },
    ) => {
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude."
      if (input.model?.providerID === 'anthropic') {
        output.system.unshift(prefix)
        if (output.system[1])
          output.system[1] = `${prefix}\n\n${output.system[1]}`
      }
    },
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
              if (!auth.access || !auth.expires || auth.expires < Date.now()) {
                const response = await fetch(
                  'https://console.anthropic.com/v1/oauth/token',
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      grant_type: 'refresh_token',
                      refresh_token: auth.refresh,
                      client_id: CLIENT_ID,
                    }),
                  },
                )
                if (!response.ok) {
                  throw new Error(`Token refresh failed: ${response.status}`)
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
                auth.access = json.access_token
              }

              const requestHeaders = mergeHeaders(input, init)
              // biome-ignore lint/style/noNonNullAssertion: access is guaranteed set above
              setOAuthHeaders(requestHeaders, auth.access!)

              let body = init?.body
              if (body && typeof body === 'string') {
                body = prefixToolNames(body)
              }

              const rewritten = rewriteUrl(input)

              const response = await fetch(rewritten.input, {
                ...init,
                body,
                headers: requestHeaders,
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
            const { url, verifier } = await authorize('max')
            return {
              url: url,
              instructions: 'Paste the authorization code here: ',
              method: 'code',
              callback: async (code: string) => {
                const credentials = await exchange(code, verifier)
                return credentials
              },
            }
          },
        },
        {
          label: 'Create an API Key',
          type: 'oauth',
          authorize: async () => {
            const { url, verifier } = await authorize('console')
            return {
              url: url,
              instructions: 'Paste the authorization code here: ',
              method: 'code',
              callback: async (code: string) => {
                const credentials = await exchange(code, verifier)
                if (credentials.type === 'failed') return credentials
                const result = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((r) => r.json() as Promise<{ raw_key: string }>)
                return { type: 'success' as const, key: result.raw_key }
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
