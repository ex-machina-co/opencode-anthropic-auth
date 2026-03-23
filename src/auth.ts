import { createServer, type Server } from 'node:http'
import { generatePKCE } from '@openauthjs/openauth/pkce'
import { AUTHORIZE_URLS, CLIENT_ID, OAUTH_SCOPES, TOKEN_URL } from './constants'

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

type CallbackParams = {
  code: string
  state: string
}

type AuthorizationResult = {
  url: string
  redirectUri: string
  state: string
  callback: () => Promise<ExchangeResult>
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

async function close(server: Server) {
  if (!server.listening) return

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
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

function successPage() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Authorization complete</title>
  </head>
  <body>
    <h1>Authorization complete</h1>
    <p>You can close this window and return to OpenCode.</p>
  </body>
</html>`
}

async function exchangeCode(
  callback: CallbackParams,
  verifier: string,
  redirectUri: string,
): Promise<ExchangeResult> {
  const result = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'claude-cli/2.1.2 (external, cli)',
    },
    body: new URLSearchParams({
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

async function createCallbackServer(expectedState: string) {
  let settled = false
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  let resolveResult: ((result: string) => void) | undefined
  let rejectResult: ((error: Error) => void) | undefined

  const server = createServer((req, res) => {
    const requestUrl = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    )

    if (requestUrl.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }

    const code = requestUrl.searchParams.get('code')
    const state = requestUrl.searchParams.get('state')

    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Missing code or state')
      return
    }

    if (state !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Invalid state')
      if (!settled) {
        settled = true
        rejectResult?.(new Error('OAuth state mismatch'))
      }
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(successPage())

    if (!settled) {
      settled = true
      resolveResult?.(requestUrl.toString())
    }
  })

  const callbackUrl = new Promise<string>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  await listen(server)

  cleanupTimer = setTimeout(() => {
    if (settled) return
    settled = true
    rejectResult?.(new Error('Timed out waiting for OAuth callback'))
  }, CALLBACK_TIMEOUT_MS)

  const address = server.address()
  if (!address || typeof address === 'string') {
    clearTimeout(cleanupTimer)
    await close(server)
    throw new Error('Failed to allocate localhost redirect port')
  }

  return {
    redirectUri: `http://localhost:${address.port}/callback`,
    waitForCallback: async () => {
      try {
        return await callbackUrl
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer)
        await close(server)
      }
    },
  }
}

export async function authorize(
  mode: 'max' | 'console',
): Promise<AuthorizationResult> {
  const pkce = await generatePKCE()
  const state = generateState()
  const callbackServer = await createCallbackServer(state)

  const url = new URL(AUTHORIZE_URLS[mode], import.meta.url)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', callbackServer.redirectUri)
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '))
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)

  return {
    url: url.toString(),
    redirectUri: callbackServer.redirectUri,
    state,
    callback: async () => {
      try {
        const callbackUrl = await callbackServer.waitForCallback()
        return await exchange(
          callbackUrl,
          pkce.verifier,
          callbackServer.redirectUri,
          state,
        )
      } catch {
        return { type: 'failed' }
      }
    },
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
