import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore } from '../accounts'
import { AnthropicAuthPlugin } from '../index'

// Isolate the account store for the WHOLE file so no test ever reads the real
// user store at ~/.local/share/opencode-anthropic-auth/accounts.json.
let globalStoreDir: string
const originalGlobalAccountsPath = process.env.ANTHROPIC_ACCOUNTS_PATH

beforeAll(() => {
  globalStoreDir = mkdtempSync(join(tmpdir(), 'accounts-global-'))
  process.env.ANTHROPIC_ACCOUNTS_PATH = join(globalStoreDir, 'accounts.json')
})

// Start every test from an empty store and the global path. The loader now
// persists the current primary into the store on each request, so without this
// reset one test's account would leak into the next. (The failover describe
// block overrides the path again with its own per-test temp file.)
beforeEach(() => {
  process.env.ANTHROPIC_ACCOUNTS_PATH = join(globalStoreDir, 'accounts.json')
  rmSync(join(globalStoreDir, 'accounts.json'), { force: true })
})

afterAll(() => {
  if (originalGlobalAccountsPath === undefined) {
    delete process.env.ANTHROPIC_ACCOUNTS_PATH
  } else {
    process.env.ANTHROPIC_ACCOUNTS_PATH = originalGlobalAccountsPath
  }
  rmSync(globalStoreDir, { recursive: true, force: true })
})

/** Extract the URL string from a fetch input (string, URL, or Request). */
function extractUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

// Minimal mock of the OpenCode plugin client
function createMockClient() {
  return {
    auth: {
      set: mock(() => Promise.resolve()),
    },
  }
}

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const EMPTY_POST = { method: 'POST', body: '{}' } as const

/**
 * Set up the common test scaffolding for concurrent refresh tests:
 * mocks setTimeout to be synchronous and creates a plugin loader
 * with an already-expired OAuth token.
 */
async function setupExpiredTokenLoader() {
  // @ts-expect-error — mock override for testing
  globalThis.setTimeout = mock((handler: () => unknown) => {
    handler()
    return 0
  })

  const mockClient = createMockClient()
  const plugin = await getPlugin(mockClient)
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth',
        access: 'expired-token',
        refresh: 'old-refresh',
        expires: Date.now() - 1000,
      }),
    { models: {} },
  )

  return { mockClient, result }
}

/** Fire 5 concurrent fetch requests against /v1/messages. */
function fireConcurrentFetches(result: { fetch: typeof fetch }) {
  return Promise.all(
    Array.from({ length: 5 }, () => result.fetch(MESSAGES_URL, EMPTY_POST)),
  )
}

async function getPlugin(client?: ReturnType<typeof createMockClient>) {
  return (await AnthropicAuthPlugin({
    // @ts-expect-error: minimal mock for testing
    client: client ?? createMockClient(),
  })) as Promise<any>
}

describe('AnthropicAuthPlugin', () => {
  test('returns an object with auth properties', async () => {
    const plugin = await getPlugin()
    expect(plugin.auth).toBeDefined()
    expect(plugin.auth.provider).toBe('anthropic')
    expect(plugin.auth.loader).toBeFunction()
    expect(plugin.auth.methods).toBeArray()
  })
})

describe('auth.methods', () => {
  test('has three auth methods (no separate failover option)', async () => {
    const plugin = await getPlugin()
    expect(plugin.auth.methods).toHaveLength(3)
    // The failover flow is transparent — there is no dedicated method for it.
    const labels = plugin.auth.methods.map((m: any) => m.label)
    expect(labels).not.toContain('Add another Claude account (failover)')
  })

  test('first method is Claude Pro/Max OAuth with code flow', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[0]
    expect(method.label).toBe('Claude Pro/Max')
    expect(method.type).toBe('oauth')
    expect(method.authorize).toBeFunction()
  })

  test('second method is Create an API Key OAuth with code flow', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[1]
    expect(method.label).toBe('Create an API Key')
    expect(method.type).toBe('oauth')
    expect(method.authorize).toBeFunction()
  })

  test('third method is manual API key', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[2]
    expect(method.label).toBe('Manually enter API Key')
    expect(method.type).toBe('api')
    expect(method.provider).toBe('anthropic')
  })
})

describe('auth.loader', () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout

  beforeEach(() => {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  })

  test('returns empty object for non-oauth auth', async () => {
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve({ type: 'api' }),
      { models: {} },
    )
    expect(result).toEqual({})
  })

  test('zeros out model costs for oauth auth', async () => {
    const plugin = await getPlugin()
    const models = {
      'claude-3': {
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      },
    }
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models },
    )
    expect(models['claude-3'].cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
  })

  test('returns fetch wrapper for oauth auth', async () => {
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    expect(result.apiKey).toBe('')
    expect(result.fetch).toBeFunction()
  })

  test('fetch wrapper sets OAuth headers and prefixes tools', async () => {
    let capturedHeaders: Headers | undefined
    let capturedBody: string | undefined

    globalThis.fetch = mock((input: any, init: any) => {
      // Capture only the messages request; the primary is now persisted to the
      // pool, so a best-effort profile GET also fires to label it — ignore it.
      if (extractUrl(input).includes('/v1/messages')) {
        capturedHeaders = init?.headers
        capturedBody = init?.body
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const body = JSON.stringify({
      tools: [{ name: 'bash', type: 'function' }],
      messages: [{ role: 'user', content: 'hello world test message' }],
      system: 'You are a helpful assistant.',
    })

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body,
    })

    expect(capturedHeaders).toBeDefined()
    expect(capturedHeaders!.get('authorization')).toBe('Bearer my-access-token')
    expect(capturedHeaders!.get('x-api-key')).toBeNull()
    expect(capturedHeaders!.get('anthropic-beta')).toContain('oauth-2025-04-20')

    const parsedBody = JSON.parse(capturedBody!)
    // Tool name should be prefixed
    expect(parsedBody.tools[0].name).toBe('mcp_Bash')
    // Three-block layout: billing header, identity, rest
    expect(parsedBody.system).toHaveLength(3)
    expect(parsedBody.system[0].text).toContain('x-anthropic-billing-header')
    expect(parsedBody.system[1].text).toBe(
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    )
    expect(parsedBody.system[2].text).toBe('You are a helpful assistant.')
    // User message is untouched
    expect(parsedBody.messages[0].content).toBe('hello world test message')
  })

  test('fetch wrapper refreshes expired token', async () => {
    const fetchCalls: Array<{ url: string; body?: string }> = []

    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      fetchCalls.push({ url, body: init?.body })

      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'new-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'expired-token',
          refresh: 'old-refresh',
          expires: Date.now() - 1000, // expired
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })

    // Should have called token endpoint first
    const tokenCall = fetchCalls.find((c) => c.url.includes('/v1/oauth/token'))
    expect(tokenCall).toBeDefined()
    const tokenBody = JSON.parse(tokenCall!.body!)
    expect(tokenBody.grant_type).toBe('refresh_token')
    expect(tokenBody.refresh_token).toBe('old-refresh')

    // Should have called client.auth.set with new tokens
    expect(mockClient.auth.set).toHaveBeenCalled()
  })

  test('fetch wrapper retries transient token refresh failures', async () => {
    let tokenRefreshCalls = 0
    const setTimeoutMock = mock((handler: () => unknown) => {
      handler()
      return 0
    })

    // @ts-expect-error — mock override for testing
    globalThis.setTimeout = setTimeoutMock

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1

        if (tokenRefreshCalls === 1) {
          return Promise.resolve(
            new Response('Temporary failure', { status: 500 }),
          )
        }

        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'new-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'expired',
          refresh: 'refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })

    expect(tokenRefreshCalls).toBe(2)
    expect(setTimeoutMock).toHaveBeenCalledTimes(1)
    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 500)
    expect(mockClient.auth.set).toHaveBeenCalledTimes(1)
  })

  test('fetch wrapper does not retry non-transient token refresh failures', async () => {
    let tokenRefreshCalls = 0

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(new Response('Forbidden', { status: 403 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'expired',
          refresh: 'refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    expect(
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('Token refresh failed: 403')

    expect(tokenRefreshCalls).toBe(1)
  })

  test('fetch wrapper strips tool prefix from streaming response', async () => {
    const encoder = new TextEncoder()
    const responseStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
          ),
        )
        controller.close()
      },
    })

    globalThis.fetch = mock((input: any) => {
      // Return the stream only for the messages call; the primary-labeling
      // profile GET must not share (and drain) the same ReadableStream.
      if (extractUrl(input).includes('/v1/messages')) {
        return Promise.resolve(new Response(responseStream, { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: '{}',
      },
    )

    const text = await response.text()
    expect(text).toContain('"name": "bash"')
    expect(text).not.toContain('mcp_bash')
  })

  test('concurrent expired token refresh should deduplicate to a single token request', async () => {
    let tokenRefreshCount = 0

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCount++
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'new-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const { result } = await setupExpiredTokenLoader()
    await fireConcurrentFetches(result)

    // With deduplication, only ONE refresh request should be made, not 5
    expect(tokenRefreshCount).toBe(1)
  })

  test('concurrent refresh with token rotation should not cause cascading failures', async () => {
    const usedRefreshTokens = new Set<string>()

    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/oauth/token')) {
        const body = JSON.parse(init?.body)
        const refreshToken = body.refresh_token

        // Simulate refresh token rotation: first use succeeds, subsequent uses
        // return 401 because the old token has been invalidated
        if (usedRefreshTokens.has(refreshToken)) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'invalid_grant' }), {
              status: 401,
            }),
          )
        }

        usedRefreshTokens.add(refreshToken)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'rotated-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const { result } = await setupExpiredTokenLoader()

    // Fire 5 concurrent requests — ALL should succeed because only one refresh
    // fires and the rest reuse its result
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        result.fetch(MESSAGES_URL, EMPTY_POST).then(
          () => 'ok' as const,
          () => 'fail' as const,
        ),
      ),
    )

    // With deduplication, all callers share the single successful refresh.
    // Without it, 4 out of 5 get 401 from the rotated-away token → cascading failures.
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
  })

  test('concurrent refresh should persist tokens exactly once', async () => {
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'new-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const { mockClient, result } = await setupExpiredTokenLoader()
    await fireConcurrentFetches(result)

    // With deduplication, client.auth.set should be called exactly once.
    // Without it, each concurrent refresh calls auth.set independently → 5 calls.
    expect(mockClient.auth.set).toHaveBeenCalledTimes(1)
  })

  test('fetch wrapper adds beta=true to /v1/messages URL', async () => {
    let capturedUrl: string | undefined

    globalThis.fetch = mock((input: any) => {
      // Capture only the messages URL, not the primary-labeling profile GET.
      const url = extractUrl(input)
      if (url.includes('/v1/messages')) capturedUrl = url
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })

    expect(capturedUrl).toContain('beta=true')
  })
})

describe('multi-account failover', () => {
  const originalFetch = globalThis.fetch
  let dir: string
  let storePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'failover-test-'))
    storePath = join(dir, 'accounts.json')
    process.env.ANTHROPIC_ACCOUNTS_PATH = storePath
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    // Restore to the file-wide isolated store (set in the top-level beforeAll),
    // never to the real user store.
    process.env.ANTHROPIC_ACCOUNTS_PATH = join(globalStoreDir, 'accounts.json')
    rmSync(dir, { recursive: true, force: true })
  })

  /** A primary OAuth credential with a valid (non-expired) token. */
  function primaryAuth() {
    return {
      type: 'oauth' as const,
      access: 'primary-access',
      refresh: 'primary-refresh',
      expires: Date.now() + 100_000,
    }
  }

  test('falls over to a second account on 429 and marks cooldown', async () => {
    // Seed a second account in the store.
    const store = new AccountStore(storePath)
    const second = store.add({
      refresh: 'second-refresh',
      access: 'second-access',
      expires: Date.now() + 100_000,
      label: 'Second',
    })

    const authHeaders: string[] = []
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/messages')) {
        const auth = (init?.headers as Headers).get('authorization') ?? ''
        authHeaders.push(auth)
        // First account (primary) is rate-limited, second succeeds.
        if (auth.includes('primary-access')) {
          return Promise.resolve(
            new Response('rate limited', {
              status: 429,
              headers: { 'retry-after': '120' },
            }),
          )
        }
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve(primaryAuth()),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)

    // Both the primary and the second account were attempted, in order.
    expect(authHeaders[0]).toContain('primary-access')
    expect(authHeaders[1]).toContain('second-access')

    // The primary is now persisted to the pool (so it can't be dropped later)
    // AND cooling down after its 429, so only the second account is available.
    const now = Date.now()
    const available = store.available(now)
    expect(available.map((a) => a.id)).toContain(second.id)
    expect(available).toHaveLength(1)
  })

  test('cools the primary by its POST-rotation token after a refresh then 429', async () => {
    // Regression: when the primary's token is rotated by ensureFreshTokens and
    // it THEN hits a 429, the cooldown must be recorded against the NEW refresh
    // token (which the store twin now holds), not the stale pre-rotation one.
    // Otherwise the lookup misses, no cooldown is written, and the exhausted
    // primary is rebuilt as a candidate and retried on every later request.
    const store = new AccountStore(storePath)
    store.add({
      refresh: 'second-refresh',
      access: 'second-access',
      expires: Date.now() + 100_000,
    })

    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        // The primary's expired token rotates to a brand-new refresh token.
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'primary-rotated',
              access_token: 'primary-new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      if (url.includes('/v1/messages')) {
        const auth = (init?.headers as Headers).get('authorization') ?? ''
        // The freshly-rotated primary is rate-limited; the second succeeds.
        if (auth.includes('primary-new-access')) {
          return Promise.resolve(new Response('rate limited', { status: 429 }))
        }
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'stale-primary-access',
          refresh: 'primary-refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)

    // The primary's store twin (now keyed by its rotated refresh) must be
    // cooling down. With the bug the lookup missed and it stayed available.
    const twin = new AccountStore(storePath)
      .list()
      .find((a) => a.refresh === 'primary-rotated')
    expect(twin).toBeDefined()
    expect(twin!.cooldownUntil ?? 0).toBeGreaterThan(Date.now())
  })

  test('a cooling primary is demoted below healthy accounts (not retried first)', async () => {
    // When the primary itself is on cooldown but still occupies OpenCode's slot
    // (e.g. a promotion hasn't taken effect yet), a request must try a HEALTHY
    // account first rather than wasting a round-trip on the rate-limited primary.
    const store = new AccountStore(storePath)
    // The primary is already cooling; a healthy second account is available.
    const primary = store.add({
      refresh: 'primary-refresh',
      access: 'primary-access',
      expires: Date.now() + 100_000,
    })
    store.markCooldown(primary.id, Date.now() + 100_000, 'HTTP 429')
    store.add({
      refresh: 'second-refresh',
      access: 'second-access',
      expires: Date.now() + 100_000,
    })

    const authHeaders: string[] = []
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/messages')) {
        const auth = (init?.headers as Headers).get('authorization') ?? ''
        authHeaders.push(auth)
        // The cooling primary is still rate-limited; the second succeeds.
        if (auth.includes('primary-access')) {
          return Promise.resolve(new Response('rate limited', { status: 429 }))
        }
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    // OpenCode's slot still holds the (cooling) primary.
    const result = await plugin.auth.loader(
      () => Promise.resolve(primaryAuth()),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)

    // The healthy second account is tried FIRST and the cooling primary is not
    // hit at all (it is only a last resort, never reached here).
    expect(authHeaders[0]).toContain('second-access')
    expect(authHeaders.some((h) => h.includes('primary-access'))).toBe(false)
  })

  test('returns the last error response when all accounts are exhausted', async () => {
    // Primary + one store account, both rate-limited.
    const store = new AccountStore(storePath)
    store.add({
      refresh: 'second-refresh',
      access: 'second-access',
      expires: Date.now() + 100_000,
    })

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/messages')) {
        return Promise.resolve(new Response('nope', { status: 429 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve(primaryAuth()),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    // All exhausted → surfaces the real 429 to the caller.
    expect(response.status).toBe(429)
  })

  test('does not fail over on a successful primary request', async () => {
    const store = new AccountStore(storePath)
    store.add({
      refresh: 'second-refresh',
      access: 'second-access',
      expires: Date.now() + 100_000,
    })

    let messagesCalls = 0
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/messages')) {
        messagesCalls += 1
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve(primaryAuth()),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    // Only the primary should have been hit.
    expect(messagesCalls).toBe(1)
  })

  test('skips store accounts that are cooling down', async () => {
    const store = new AccountStore(storePath)
    const cooling = store.add({
      refresh: 'cooling-refresh',
      access: 'cooling-access',
      expires: Date.now() + 100_000,
    })
    store.markCooldown(cooling.id, Date.now() + 100_000, 'HTTP 429')

    const authHeaders: string[] = []
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/messages')) {
        authHeaders.push((init?.headers as Headers).get('authorization') ?? '')
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve(primaryAuth()),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)
    // Cooling account must not be attempted.
    expect(authHeaders.some((h) => h.includes('cooling-access'))).toBe(false)
  })

  test('fails over when a 200 response carries an SSE error event', async () => {
    // This is the real-world Claude Max case: HTTP 200 but the stream's first
    // event is a rate_limit_error.
    const store = new AccountStore(storePath)
    store.add({
      refresh: 'second-refresh',
      access: 'second-access',
      expires: Date.now() + 100_000,
    })

    const encoder = new TextEncoder()
    const authHeaders: string[] = []
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/messages')) {
        const auth = (init?.headers as Headers).get('authorization') ?? ''
        authHeaders.push(auth)
        if (auth.includes('primary-access')) {
          // 200 OK, but an error event in the stream.
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"usage limit exceeded"}}\n\n',
                ),
              )
              controller.close()
            },
          })
          return Promise.resolve(
            new Response(stream, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
          )
        }
        // Second account: a normal successful stream.
        const ok = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: message_start\ndata: {"type":"message_start"}\n\n',
              ),
            )
            controller.close()
          },
        })
        return Promise.resolve(
          new Response(ok, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve(primaryAuth()),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    const text = await response.text()

    // Should have advanced to the second account and returned its good stream.
    expect(authHeaders[0]).toContain('primary-access')
    expect(authHeaders[1]).toContain('second-access')
    expect(text).toContain('message_start')
    expect(text).not.toContain('rate_limit_error')
  })

  test('passes through a normal 200 SSE stream unchanged (peek+replay)', async () => {
    const encoder = new TextEncoder()
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/messages')) {
        const ok = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: message_start\ndata: {"type":"message_start"}\n\n',
              ),
            )
            controller.enqueue(
              encoder.encode(
                'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n',
              ),
            )
            controller.close()
          },
        })
        return Promise.resolve(new Response(ok, { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve(primaryAuth()),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    const text = await response.text()
    // Both events must be present and intact.
    expect(text).toContain('message_start')
    expect(text).toContain('content_block_delta')
    expect(text).toContain('hello')
  })

  /** A primary OAuth credential whose access token is already expired. */
  function expiredPrimaryAuth() {
    return {
      type: 'oauth' as const,
      access: 'expired-primary-access',
      refresh: 'dead-primary-refresh',
      expires: Date.now() - 1000,
    }
  }

  test('invalid_grant on primary fails over to a store account and promotes it', async () => {
    const store = new AccountStore(storePath)
    store.add({
      refresh: 'second-refresh',
      access: 'second-access',
      expires: Date.now() + 100_000,
    })

    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      // Primary's refresh token is dead.
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
          }),
        )
      }
      if (url.includes('/v1/messages')) {
        const auth = (init?.headers as Headers).get('authorization') ?? ''
        // Only the second account should ever reach the messages endpoint.
        expect(auth).toContain('second-access')
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () => Promise.resolve(expiredPrimaryAuth()),
      { models: {} },
    )

    // Must NOT throw invalid_grant — it should transparently fail over.
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)

    // The working second account should be promoted into OpenCode's slot.
    expect(mockClient.auth.set).toHaveBeenCalled()
    const call = (mockClient.auth.set as any).mock.calls[0][0]
    expect(call.path.id).toBe('anthropic')
    expect(call.body.access).toBe('second-access')
  })

  test('tries a cooling account as a last resort instead of surfacing an error', async () => {
    // Primary is dead AND the only other account is cooling down. The plugin
    // should still try the cooling account rather than throw.
    const store = new AccountStore(storePath)
    const cooling = store.add({
      refresh: 'cooling-refresh',
      access: 'cooling-access',
      expires: Date.now() + 100_000,
    })
    store.markCooldown(cooling.id, Date.now() + 10 * 60_000, 'HTTP 429')

    let servedByCooling = false
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
          }),
        )
      }
      if (url.includes('/v1/messages')) {
        const auth = (init?.headers as Headers).get('authorization') ?? ''
        if (auth.includes('cooling-access')) servedByCooling = true
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve(expiredPrimaryAuth()),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(servedByCooling).toBe(true)
  })

  test('Claude Pro/Max login labels the stored account by email', async () => {
    // Token exchange returns an account email; the store should use it.
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'login-refresh',
              access_token: 'login-access',
              expires_in: 3600,
              account: { email_address: 'flo@example.com' },
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const method = plugin.auth.methods.find(
      (m: any) => m.label === 'Claude Pro/Max',
    )
    const flow = await method.authorize()
    // Provide a valid code#state matching the generated state.
    const state = new URL(flow.url).searchParams.get('state')
    const outcome = await flow.callback(`logincode#${state}`)
    expect(outcome.type).toBe('success')

    const stored = new AccountStore(storePath).list()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.email).toBe('flo@example.com')
    expect(stored[0]!.label).toBe('flo@example.com')
  })

  test('login falls back to the profile endpoint when the token has no email', async () => {
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'login-refresh',
              access_token: 'login-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      if (url.includes('/api/oauth/profile')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              account: { email_address: 'viaprofile@example.com' },
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const method = plugin.auth.methods.find(
      (m: any) => m.label === 'Claude Pro/Max',
    )
    const flow = await method.authorize()
    const state = new URL(flow.url).searchParams.get('state')
    await flow.callback(`logincode#${state}`)

    const stored = new AccountStore(storePath).list()
    expect(stored[0]!.email).toBe('viaprofile@example.com')
  })

  test('login marks the account as primary in the store', async () => {
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'login-refresh',
              access_token: 'login-access',
              expires_in: 3600,
              account: { email: 'primary@example.com' },
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const method = plugin.auth.methods.find(
      (m: any) => m.label === 'Claude Pro/Max',
    )
    const flow = await method.authorize()
    const state = new URL(flow.url).searchParams.get('state')
    await flow.callback(`logincode#${state}`)

    const stored = new AccountStore(storePath).list()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.primary).toBe(true)
    expect(stored[0]!.email).toBe('primary@example.com')
  })

  test('a request flags the current OpenCode account as primary', async () => {
    const store = new AccountStore(storePath)
    // Two stored accounts; the second matches the OpenCode primary credential.
    store.add({ refresh: 'other-refresh', access: 'other', expires: 1 })
    store.add({
      refresh: 'primary-refresh',
      access: 'primary-access',
      expires: Date.now() + 100_000,
    })

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve(primaryAuth()),
      { models: {} },
    )
    await result.fetch(MESSAGES_URL, EMPTY_POST)

    const after = new AccountStore(storePath).list()
    const primary = after.find((a) => a.primary)
    expect(primary?.refresh).toBe('primary-refresh')
    expect(after.filter((a) => a.primary)).toHaveLength(1)
  })

  test('persists a not-yet-stored primary so a later login cannot drop it', async () => {
    // Reproduces "prior account lost on new login": OpenCode already holds a
    // credential that was NOT added through this plugin's login (so the pool
    // doesn't know it). A request must persist it, and a later login with a
    // DIFFERENT account must keep it rather than overwrite it away.
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'login-refresh',
              access_token: 'login-access',
              expires_in: 3600,
              account: { email: 'second@example.com' },
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()

    // 1) A request with the pre-existing primary credential persists it.
    const result = await plugin.auth.loader(
      () => Promise.resolve(primaryAuth()),
      { models: {} },
    )
    await result.fetch(MESSAGES_URL, EMPTY_POST)

    let stored = new AccountStore(storePath).list()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.refresh).toBe('primary-refresh')
    expect(stored[0]!.primary).toBe(true)

    // 2) Now log in with a DIFFERENT Claude account.
    const method = plugin.auth.methods.find(
      (m: any) => m.label === 'Claude Pro/Max',
    )
    const flow = await method.authorize()
    const state = new URL(flow.url).searchParams.get('state')
    const outcome = await flow.callback(`logincode#${state}`)
    expect(outcome.type).toBe('success')

    // 3) BOTH accounts survive: the prior primary is preserved and the new
    // login has become the primary.
    stored = new AccountStore(storePath).list()
    expect(stored.map((a) => a.refresh).sort()).toEqual([
      'login-refresh',
      'primary-refresh',
    ])
    const nowPrimary = stored.find((a) => a.primary)
    expect(nowPrimary?.refresh).toBe('login-refresh')
    expect(stored.filter((a) => a.primary)).toHaveLength(1)
  })

  test('promotion on failover moves the primary flag to the working account', async () => {
    const store = new AccountStore(storePath)
    store.add({
      refresh: 'second-refresh',
      access: 'second-access',
      expires: Date.now() + 100_000,
    })
    // The primary credential is also in the store but its refresh is dead.
    store.add({
      refresh: 'dead-primary-refresh',
      access: 'expired-primary-access',
      expires: Date.now() - 1000,
    })

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
          }),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve(expiredPrimaryAuth()),
      { models: {} },
    )
    await result.fetch(MESSAGES_URL, EMPTY_POST)

    // The working second account should now be flagged primary.
    const after = new AccountStore(storePath).list()
    const primary = after.find((a) => a.primary)
    expect(primary?.refresh).toBe('second-refresh')
  })
})
