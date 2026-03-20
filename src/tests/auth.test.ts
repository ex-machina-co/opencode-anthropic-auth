import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { authorize, exchange } from '../auth'
import { CLIENT_ID, OAUTH_SCOPES, TOKEN_URL } from '../constants'

const originalFetch = globalThis.fetch

function mockTokenEndpoint(onBody?: (body: string) => void) {
  globalThis.fetch = mock((input: any, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    if (url === TOKEN_URL) {
      if (onBody && init?.body) onBody(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'refresh_abc',
            access_token: 'access_xyz',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }

    return originalFetch(input, init)
  }) as unknown as typeof fetch
}

describe('authorize', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('returns a localhost callback URL for max mode', async () => {
    mockTokenEndpoint()
    const result = await authorize('max')

    expect(result.url).toBeString()
    expect(result.redirectUri).toStartWith('http://localhost:')

    const url = new URL(result.url)
    expect(url.origin).toBe('https://claude.ai')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(result.redirectUri)

    await originalFetch(`${result.redirectUri}?code=test&state=${result.state}`)
    await result.callback()
  })

  test('returns a localhost callback URL for console mode', async () => {
    mockTokenEndpoint()
    const result = await authorize('console')

    const url = new URL(result.url)
    expect(url.origin).toBe('https://platform.claude.com')
    expect(url.pathname).toBe('/oauth/authorize')

    await originalFetch(`${result.redirectUri}?code=test&state=${result.state}`)
    await result.callback()
  })

  test('sets required OAuth query params', async () => {
    mockTokenEndpoint()
    const result = await authorize('max')
    const url = new URL(result.url)

    expect(url.searchParams.get('code')).toBe('true')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(result.redirectUri)
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPES.join(' '))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')

    await originalFetch(`${result.redirectUri}?code=test&state=${result.state}`)
    await result.callback()
  })

  test('captures the callback and exchanges the code', async () => {
    let capturedBody: string | undefined
    mockTokenEndpoint((body) => {
      capturedBody = body
    })

    const result = await authorize('max')
    const callbackPromise = result.callback()

    const browserResponse = await originalFetch(
      `${result.redirectUri}?code=mycode&state=${result.state}`,
    )

    expect(browserResponse.status).toBe(200)

    const exchangeResult = await callbackPromise
    expect(exchangeResult.type).toBe('success')

    const body = JSON.parse(capturedBody!)
    expect(body.code).toBe('mycode')
    expect(body.state).toBe(result.state)
    expect(body.redirect_uri).toBe(result.redirectUri)
  })

  test('fails on state mismatch', async () => {
    const fetchMock = mock((input: any, init?: RequestInit) =>
      originalFetch(input, init),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await authorize('max')
    const callbackPromise = result.callback()

    const browserResponse = await originalFetch(
      `${result.redirectUri}?code=mycode&state=wrong-state`,
    )

    expect(browserResponse.status).toBe(400)
    expect(await callbackPromise).toEqual({ type: 'failed' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('exchange', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('accepts a full localhost callback URL', async () => {
    let capturedBody: string | undefined

    globalThis.fetch = mock((input: any, init: any) => {
      capturedBody = init?.body
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'r',
            access_token: 'a',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    await exchange(
      'http://localhost:59233/callback?code=mycode&state=mystate',
      'myverifier',
      'http://localhost:59233/callback',
      'mystate',
    )

    const body = JSON.parse(capturedBody!)
    expect(body.code).toBe('mycode')
    expect(body.state).toBe('mystate')
  })

  test('returns failed on invalid callback input', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(null)))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await exchange(
      'not-a-callback',
      'verifier',
      'http://localhost:59233/callback',
    )
    expect(result.type).toBe('failed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('returns failed on state mismatch', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(null)))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await exchange(
      'code#wrong',
      'verifier',
      'http://localhost:59233/callback',
      'expected',
    )
    expect(result.type).toBe('failed')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
