import { generatePKCE } from '@openauthjs/openauth/pkce'
import { CLIENT_ID } from './constants'

export async function authorize(mode: 'max' | 'console') {
  const pkce = await generatePKCE()

  const url = new URL(
    `https://${mode === 'console' ? 'console.anthropic.com' : 'claude.ai'}/oauth/authorize`,
    import.meta.url,
  )

  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set(
    'redirect_uri',
    'https://console.anthropic.com/oauth/code/callback',
  )
  url.searchParams.set(
    'scope',
    'org:create_api_key user:profile user:inference',
  )
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', pkce.verifier)

  return {
    url: url.toString(),
    verifier: pkce.verifier,
  }
}

export type ExchangeResult =
  | { type: 'success'; refresh: string; access: string; expires: number }
  | { type: 'failed' }

export async function exchange(
  code: string,
  verifier: string,
): Promise<ExchangeResult> {
  const splits = code.split('#')
  const result = await fetch('https://console.anthropic.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: 'https://console.anthropic.com/oauth/code/callback',
      code_verifier: verifier,
    }),
  })

  if (!result.ok) {
    return {
      type: 'failed',
    }
  }

  const json = (await result.json()) as {
    refresh_token: string
    access_token: string
    expires_in: number
  }
  return {
    type: 'success',
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}
