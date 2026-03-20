import { generatePKCE } from '@openauthjs/openauth/pkce'
import { CLIENT_ID } from './constants'

// Deduplicate concurrent exchange calls with the same code
let pendingExchange: { code: string; promise: Promise<ExchangeResult> } | null =
  null

export async function authorize(mode: 'max' | 'console') {
  const pkce = await generatePKCE()

  const url = new URL(
    `https://${mode === 'console' ? 'platform.claude.com' : 'claude.ai'}/oauth/authorize`,
    import.meta.url,
  )

  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set(
    'redirect_uri',
    'https://platform.claude.com/oauth/code/callback',
  )
  url.searchParams.set(
    'scope',
    'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
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
  // Deduplicate: if we're already exchanging this exact code, return the same promise
  if (pendingExchange && pendingExchange.code === code) {
    return pendingExchange.promise
  }

  const promise = exchangeInternal(code, verifier)
  pendingExchange = { code, promise }
  try {
    return await promise
  } finally {
    pendingExchange = null
  }
}

async function exchangeInternal(
  code: string,
  verifier: string,
): Promise<ExchangeResult> {
  const [authCode, state] = code.split('#')

  const bodyObj: Record<string, string> = {
    code: authCode ?? code,
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    redirect_uri: 'https://platform.claude.com/oauth/code/callback',
    code_verifier: verifier,
  }
  if (state) {
    bodyObj.state = state
  }

  const result = await fetch('https://platform.claude.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'axios/1.13.6',
    },
    body: JSON.stringify(bodyObj),
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
