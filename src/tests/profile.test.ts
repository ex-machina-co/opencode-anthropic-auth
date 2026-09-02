import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { fetchAccountProfile } from '../profile'

describe('fetchAccountProfile', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('returns undefined for an empty token without calling fetch', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    expect(await fetchAccountProfile('')).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('extracts email + organization from the profile response (account.email)', async () => {
    let capturedAuth: string | undefined
    globalThis.fetch = mock((input: any, init: any) => {
      expect(String(input)).toContain('/api/oauth/profile')
      capturedAuth = (init?.headers as Record<string, string>).Authorization
      return Promise.resolve(
        new Response(
          JSON.stringify({
            // Real endpoint shape: account.email
            account: { email: 'me@example.com', uuid: 'u1' },
            organization: { name: 'My Org' },
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    const profile = await fetchAccountProfile('my-access-token')
    expect(profile).toEqual({
      email: 'me@example.com',
      organizationName: 'My Org',
    })
    expect(capturedAuth).toBe('Bearer my-access-token')
  })

  test('falls back to account.email_address', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ account: { email_address: 'legacy@example.com' } }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const profile = await fetchAccountProfile('t')
    expect(profile?.email).toBe('legacy@example.com')
  })

  test('returns undefined on a non-ok response', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('nope', { status: 401 })),
    ) as unknown as typeof fetch
    expect(await fetchAccountProfile('t')).toBeUndefined()
  })

  test('returns undefined on invalid JSON', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('{ not json', { status: 200 })),
    ) as unknown as typeof fetch
    expect(await fetchAccountProfile('t')).toBeUndefined()
  })

  test('returns undefined on a network error', async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error('fetch failed')),
    ) as unknown as typeof fetch
    expect(await fetchAccountProfile('t')).toBeUndefined()
  })
})
