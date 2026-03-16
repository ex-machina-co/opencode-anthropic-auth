import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { authorize, exchange } from '../auth'
import { CLIENT_ID } from '../constants'

describe('authorize', () => {
  test('returns a URL and verifier for max mode', async () => {
    const result = await authorize('max')

    expect(result.url).toBeString()
    expect(result.verifier).toBeString()

    const url = new URL(result.url)
    expect(url.origin).toBe('https://claude.ai')
    expect(url.pathname).toBe('/oauth/authorize')
  })

  test('returns a URL and verifier for console mode', async () => {
    const result = await authorize('console')

    const url = new URL(result.url)
    expect(url.origin).toBe('https://console.anthropic.com')
    expect(url.pathname).toBe('/oauth/authorize')
  })

  test('sets required OAuth query params', async () => {
    const result = await authorize('max')
    const url = new URL(result.url)

    expect(url.searchParams.get('code')).toBe('true')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://console.anthropic.com/oauth/code/callback',
    )
    expect(url.searchParams.get('scope')).toBe(
      'org:create_api_key user:profile user:inference',
    )
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  test('includes PKCE challenge and verifier as state', async () => {
    const result = await authorize('max')
    const url = new URL(result.url)

    expect(url.searchParams.get('code_challenge')).toBeString()
    expect(url.searchParams.get('state')).toBe(result.verifier)
  })

  test('generates unique PKCE values per call', async () => {
    const result1 = await authorize('max')
    const result2 = await authorize('max')

    expect(result1.verifier).not.toBe(result2.verifier)
  })
})

describe('exchange', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  test('returns success with tokens on HTTP 200', async () => {
    const mockTokens = {
      refresh_token: 'refresh_abc',
      access_token: 'access_xyz',
      expires_in: 3600,
    }

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockTokens), { status: 200 }),
      ),
    ) as unknown as typeof fetch

    const before = Date.now()
    const result = await exchange('code123#state456', 'verifier789')

    expect(result.type).toBe('success')
    if (result.type === 'success') {
      expect(result.refresh).toBe('refresh_abc')
      expect(result.access).toBe('access_xyz')
      expect(result.expires).toBeGreaterThanOrEqual(before + 3600 * 1000)
    }
  })

  test('sends correct request body', async () => {
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

    await exchange('mycode#mystate', 'myverifier')

    const body = JSON.parse(capturedBody!)
    expect(body.code).toBe('mycode')
    expect(body.state).toBe('mystate')
    expect(body.grant_type).toBe('authorization_code')
    expect(body.client_id).toBe(CLIENT_ID)
    expect(body.redirect_uri).toBe(
      'https://console.anthropic.com/oauth/code/callback',
    )
    expect(body.code_verifier).toBe('myverifier')
  })

  test('returns failed on non-OK response', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Unauthorized', { status: 401 })),
    ) as unknown as typeof fetch

    const result = await exchange('code#state', 'verifier')
    expect(result.type).toBe('failed')
  })

  test('posts to the correct token endpoint', async () => {
    let capturedUrl: string | undefined

    globalThis.fetch = mock((input: any) => {
      capturedUrl = typeof input === 'string' ? input : input.url
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

    await exchange('c#s', 'v')
    expect(capturedUrl).toBe('https://console.anthropic.com/v1/oauth/token')
  })
})
