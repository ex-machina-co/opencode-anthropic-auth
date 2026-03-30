import { generatePKCE } from '@openauthjs/openauth/pkce'
import {
  AUTHORIZE_URLS,
  CLIENT_ID,
  CODE_CALLBACK_URL,
  OAUTH_SCOPES,
  TOKEN_URL,
} from './constants'

type CallbackParams = {
  code: string
  state: string
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
  const result = await fetch(TOKEN_URL, {
    method: 'POST',
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

  return exchangeCode(callback, verifier, redirectUri)
}
