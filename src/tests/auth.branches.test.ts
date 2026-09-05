import { afterEach, describe, expect, test } from 'bun:test'
import { exchange } from '../auth'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

type FetchArgs = Parameters<typeof fetch>

function stubFetch(response: Response): FetchArgs[] {
  const calls: FetchArgs[] = []
  globalThis.fetch = (async (...args: FetchArgs) => {
    calls.push(args)
    return response
  }) as unknown as typeof fetch
  return calls
}

describe('exchange - callback parsing', () => {
  test('accepts a query-string callback with code and state', async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const result = await exchange(
      'code=abc&state=xyz',
      'verifier',
      'https://example.com/callback',
      'xyz',
    )

    expect(result.type).toBe('success')
  })
})

describe('exchange - token endpoint failures', () => {
  test('returns failed when the token endpoint rejects the code', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const calls = stubFetch(new Response(body, { status: 400 }))

    const result = await exchange(
      'abc#xyz',
      'verifier',
      'https://example.com/callback',
      'xyz',
    )

    expect(result.type).toBe('failed')
    expect(calls).toHaveLength(1)
    expect(cancelled).toBe(true)
  })

  test('returns failed on a 500 from the token endpoint', async () => {
    const calls = stubFetch(new Response('boom', { status: 500 }))

    const result = await exchange(
      'abc#xyz',
      'verifier',
      'https://example.com/callback',
      'xyz',
    )

    expect(result.type).toBe('failed')
    expect(calls).toHaveLength(1)
  })
})
