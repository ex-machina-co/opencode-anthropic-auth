import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { buildBillingHeaderValue } from '../cch'
import { ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR } from '../config'
import { CLAUDE_CODE_VERSION } from '../constants'
import { AnthropicAuthPlugin } from '../index'

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
    app: {
      log: mock(() => Promise.resolve()),
    },
  }
}

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const EMPTY_POST = { method: 'POST', body: '{}' } as const

/**
 * Set up the common test scaffolding for concurrent refresh tests:
 * creates a plugin loader with an already-expired OAuth token.
 */
async function setupExpiredTokenLoader() {
  const refresh = `concurrent-${crypto.randomUUID()}`
  const mockClient = createMockClient()
  const plugin = await getPlugin(mockClient)
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth',
        access: 'expired-token',
        refresh,
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

// The plugin reads ANTHROPIC_CLAUDE_CODE_VERSION at load time, so an ambient
// value in the developer's shell would otherwise leak into every test in this
// file.
const originalVersionEnv = process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]

beforeEach(() => {
  delete process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]
})

afterEach(() => {
  if (originalVersionEnv === undefined) {
    delete process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]
  } else {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = originalVersionEnv
  }
})

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
  test('has three auth methods', async () => {
    const plugin = await getPlugin()
    expect(plugin.auth.methods).toHaveLength(3)
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
      capturedHeaders = init?.headers
      capturedBody = init?.body
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

  test.each([
    [
      'HTTP 503',
      () => Promise.resolve(new Response('Temporary failure', { status: 503 })),
    ],
    [
      'network failure',
      () =>
        Promise.reject(
          Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }),
        ),
    ],
  ])('does not retry an ambiguous %s token refresh', async (_name, failure) => {
    let tokenRefreshCalls = 0
    const refresh = `ambiguous-${crypto.randomUUID()}`

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return failure()
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
          refresh,
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await expect(result.fetch(MESSAGES_URL, EMPTY_POST)).rejects.toThrow()
    await expect(result.fetch(MESSAGES_URL, EMPTY_POST)).rejects.toThrow()

    expect(tokenRefreshCalls).toBe(1)
    expect(mockClient.auth.set).not.toHaveBeenCalled()
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

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(responseStream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    ) as unknown as typeof fetch

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

  test('independent loader instances share one rotating-token refresh', async () => {
    const refresh = `shared-${crypto.randomUUID()}`
    let stored = {
      type: 'oauth',
      access: 'expired-access',
      refresh,
      expires: Date.now() - 1000,
    }
    let tokenRefreshCalls = 0
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const used = new Set<string>()
    const mockClient = createMockClient()
    ;(mockClient.auth.set as any).mockImplementation(async ({ body }: any) => {
      stored = body
    })

    globalThis.fetch = mock(async (input: any, init: any) => {
      const url = extractUrl(input)
      if (!url.includes('/v1/oauth/token')) {
        return new Response(null, { status: 200 })
      }

      tokenRefreshCalls += 1
      const token = String(JSON.parse(init.body).refresh_token)
      if (used.has(token)) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
        })
      }
      used.add(token)
      await firstMayFinish
      return Response.json({
        refresh_token: 'rotated-refresh',
        access_token: 'rotated-access',
        expires_in: 3600,
      })
    }) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
    const getAuth = () => Promise.resolve({ ...stored })
    const [first, second] = await Promise.all([
      plugin.auth.loader(getAuth, { models: {} }),
      plugin.auth.loader(getAuth, { models: {} }),
    ])
    const outcomes = [
      first.fetch(MESSAGES_URL, EMPTY_POST),
      second.fetch(MESSAGES_URL, EMPTY_POST),
    ]
    await Promise.resolve()
    releaseFirst()

    await expect(Promise.all(outcomes)).resolves.toHaveLength(2)
    expect(tokenRefreshCalls).toBe(1)
    expect(mockClient.auth.set).toHaveBeenCalledTimes(1)
  })

  test('independent credential stores share one rotation and both persist it', async () => {
    const refresh = `cross-store-${crypto.randomUUID()}`
    let tokenRefreshCalls = 0
    let releaseRotation!: () => void
    const rotationMayFinish = new Promise<void>((resolve) => {
      releaseRotation = resolve
    })
    globalThis.fetch = mock(async (input: any) => {
      const url = extractUrl(input)
      if (!url.includes('/v1/oauth/token')) {
        return new Response(null, { status: 200 })
      }
      tokenRefreshCalls += 1
      await rotationMayFinish
      return Response.json({
        refresh_token: 'cross-store-rotated-refresh',
        access_token: 'cross-store-rotated-access',
        expires_in: 3600,
      })
    }) as unknown as typeof fetch

    const firstClient = createMockClient()
    const secondClient = createMockClient()
    const [firstPlugin, secondPlugin] = await Promise.all([
      getPlugin(firstClient),
      getPlugin(secondClient),
    ])
    const getAuth = () =>
      Promise.resolve({
        type: 'oauth',
        access: 'expired-access',
        refresh,
        expires: Date.now() - 1000,
      })
    const [first, second] = await Promise.all([
      firstPlugin.auth.loader(getAuth, { models: {} }),
      secondPlugin.auth.loader(getAuth, { models: {} }),
    ])
    const outcomes = [
      first.fetch(MESSAGES_URL, EMPTY_POST),
      second.fetch(MESSAGES_URL, EMPTY_POST),
    ]
    await Promise.resolve()
    releaseRotation()

    await expect(Promise.all(outcomes)).resolves.toHaveLength(2)
    expect(tokenRefreshCalls).toBe(1)
    expect(firstClient.auth.set).toHaveBeenCalledTimes(1)
    expect(secondClient.auth.set).toHaveBeenCalledTimes(1)
    expect(firstClient.auth.set).toHaveBeenCalledWith({
      path: { id: 'anthropic' },
      body: {
        type: 'oauth',
        refresh: 'cross-store-rotated-refresh',
        access: 'cross-store-rotated-access',
        expires: expect.any(Number),
      },
    })
    expect(secondClient.auth.set).toHaveBeenCalledWith({
      path: { id: 'anthropic' },
      body: {
        type: 'oauth',
        refresh: 'cross-store-rotated-refresh',
        access: 'cross-store-rotated-access',
        expires: expect.any(Number),
      },
    })
  })

  test('a later stale credential store reuses the settled rotation', async () => {
    const refresh = `later-store-${crypto.randomUUID()}`
    let tokenRefreshCalls = 0
    const authorizations: Array<string | null> = []
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(
          Response.json({
            refresh_token: 'later-store-rotated-refresh',
            access_token: 'later-store-rotated-access',
            expires_in: 3600,
          }),
        )
      }
      authorizations.push(new Headers(init.headers).get('authorization'))
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const firstClient = createMockClient()
    const secondClient = createMockClient()
    const staleAuth = () =>
      Promise.resolve({
        type: 'oauth',
        access: 'expired-access',
        refresh,
        expires: Date.now() - 1000,
      })
    const firstPlugin = await getPlugin(firstClient)
    const first = await firstPlugin.auth.loader(staleAuth, { models: {} })
    await first.fetch(MESSAGES_URL, EMPTY_POST)

    const secondPlugin = await getPlugin(secondClient)
    const second = await secondPlugin.auth.loader(staleAuth, { models: {} })
    await second.fetch(MESSAGES_URL, EMPTY_POST)

    expect(tokenRefreshCalls).toBe(1)
    expect(firstClient.auth.set).toHaveBeenCalledTimes(1)
    expect(secondClient.auth.set).toHaveBeenCalledTimes(1)
    expect(secondClient.auth.set).toHaveBeenCalledWith({
      path: { id: 'anthropic' },
      body: {
        type: 'oauth',
        refresh: 'later-store-rotated-refresh',
        access: 'later-store-rotated-access',
        expires: expect.any(Number),
      },
    })
    expect(authorizations).toEqual([
      'Bearer later-store-rotated-access',
      'Bearer later-store-rotated-access',
    ])
  })

  test('reuses a settled refresh result for a stale credential snapshot', async () => {
    const refresh = `settled-${crypto.randomUUID()}`
    let tokenRefreshCalls = 0
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(
          Response.json({
            refresh_token: 'rotated-refresh',
            access_token: 'rotated-access',
            expires_in: 3600,
          }),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'expired-access',
          refresh,
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)
    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(tokenRefreshCalls).toBe(1)
  })

  test('reuses a newly persisted valid access token instead of refreshing again', async () => {
    const expired = {
      type: 'oauth',
      access: 'expired-access',
      refresh: `stale-${crypto.randomUUID()}`,
      expires: Date.now() - 1000,
    }
    const current = {
      type: 'oauth',
      access: 'persisted-access',
      refresh: 'persisted-refresh',
      expires: Date.now() + 60_000,
    }
    let authReads = 0
    let tokenRefreshCalls = 0
    const captured: { authorization: string | null } = {
      authorization: null,
    }
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) tokenRefreshCalls += 1
      else {
        captured.authorization = new Headers(init.headers).get('authorization')
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => {
        authReads += 1
        return Promise.resolve(authReads < 3 ? expired : current)
      },
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(tokenRefreshCalls).toBe(0)
    expect(captured.authorization).toBe('Bearer persisted-access')
  })

  test('reports invalid_grant safely with an actionable re-authentication message', async () => {
    const refresh = `invalid-${crypto.randomUUID()}`
    const sensitiveBody = JSON.stringify({
      error: 'invalid_grant',
      error_description: 'provider-secret-detail',
    })
    let tokenRefreshCalls = 0
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(new Response(sensitiveBody, { status: 400 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'expired-access',
          refresh,
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    const error = await result
      .fetch(MESSAGES_URL, EMPTY_POST)
      .catch((value: unknown) =>
        value instanceof Error ? value : new Error(String(value)),
      )
    expect(error.message).toContain('reconnect Claude Pro/Max')
    expect(error.message).not.toContain('provider-secret-detail')
    expect(error.message).not.toContain(refresh)
    await expect(result.fetch(MESSAGES_URL, EMPTY_POST)).rejects.toThrow(
      'reconnect Claude Pro/Max',
    )
    expect(tokenRefreshCalls).toBe(1)
  })

  test('blocks replay after an invalid token success response', async () => {
    const refresh = `malformed-success-${crypto.randomUUID()}`
    let tokenRefreshCalls = 0
    const mockClient = createMockClient()
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(Response.json({ access_token: 'incomplete' }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'expired-access',
          refresh,
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await expect(result.fetch(MESSAGES_URL, EMPTY_POST)).rejects.toThrow(
      'invalid success response',
    )
    await expect(result.fetch(MESSAGES_URL, EMPTY_POST)).rejects.toThrow(
      'reconnect Claude Pro/Max',
    )
    expect(tokenRefreshCalls).toBe(1)
    expect(mockClient.auth.set).not.toHaveBeenCalled()
  })

  test('does not replay a consumed token after the result cache expires', async () => {
    const refresh = `expired-cache-${crypto.randomUUID()}`
    const cacheExpirations: Array<() => void> = []
    // @ts-expect-error — minimal timer mock for deterministic cache expiry
    globalThis.setTimeout = mock((handler: () => void, delay?: number) => {
      if (delay === 30_000) cacheExpirations.push(handler)
      return { unref() {} }
    })
    let tokenRefreshCalls = 0
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(
          Response.json({
            refresh_token: 'cache-expired-rotated-refresh',
            access_token: 'cache-expired-rotated-access',
            expires_in: 3600,
          }),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'expired-access',
          refresh,
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(cacheExpirations).toHaveLength(2)
    for (const expire of cacheExpirations) expire()

    await expect(result.fetch(MESSAGES_URL, EMPTY_POST)).rejects.toThrow(
      'already consumed',
    )
    expect(tokenRefreshCalls).toBe(1)
  })

  test('blocks replay when persisting a rotated credential fails', async () => {
    const refresh = `persist-failure-${crypto.randomUUID()}`
    let tokenRefreshCalls = 0
    const mockClient = createMockClient()
    mockClient.auth.set = mock(() => Promise.reject(new Error('disk failed')))
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(
          Response.json({
            refresh_token: 'rotated-refresh',
            access_token: 'rotated-access',
            expires_in: 3600,
          }),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'expired-access',
          refresh,
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await expect(result.fetch(MESSAGES_URL, EMPTY_POST)).rejects.toThrow()
    await expect(result.fetch(MESSAGES_URL, EMPTY_POST)).rejects.toThrow()
    expect(tokenRefreshCalls).toBe(1)
  })

  test('refresh always reads the latest refresh token, not a stale snapshot', async () => {
    const tokenRequestBodies: string[] = []

    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/oauth/token')) {
        tokenRequestBodies.push(init?.body)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'rotated-refresh',
              access_token: 'fresh-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    let callCount = 0
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    const result = await plugin.auth.loader(
      () => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            type: 'oauth',
            access: 'expired-access',
            refresh: 'stale-refresh',
            expires: Date.now() - 1000,
          })
        }
        return Promise.resolve({
          type: 'oauth',
          access: 'expired-access',
          refresh: 'rotated-refresh-from-storage',
          expires: Date.now() - 1000,
        })
      },
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(tokenRequestBodies).toHaveLength(1)
    const sentBody = JSON.parse(tokenRequestBodies[0] ?? '{}')
    expect(sentBody.refresh_token).toBe('rotated-refresh-from-storage')
    expect(sentBody.refresh_token).not.toBe('stale-refresh')
  })

  test('fetch wrapper adds beta=true to /v1/messages URL', async () => {
    let capturedUrl: string | undefined

    globalThis.fetch = mock((input: any) => {
      capturedUrl = extractUrl(input)
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

describe('reported Claude Code version', () => {
  const originalFetch = globalThis.fetch
  const USER_MESSAGE = 'hello world test message'

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  /**
   * Drive one OAuth request through the plugin and return the two places the
   * Claude Code version is reported to Anthropic.
   */
  async function captureReportedVersion(
    client: ReturnType<typeof createMockClient>,
  ) {
    let capturedHeaders: Headers | undefined
    let capturedBody: string | undefined

    globalThis.fetch = mock((_input: any, init: any) => {
      capturedHeaders = init?.headers
      capturedBody = init?.body
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(client)
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

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: USER_MESSAGE }],
      }),
    })

    return {
      userAgent: capturedHeaders!.get('user-agent'),
      billingHeader: JSON.parse(capturedBody!).system[0].text as string,
    }
  }

  /** Read the single startup log call the plugin made about the override. */
  function readSingleLog(client: ReturnType<typeof createMockClient>) {
    expect(client.app.log).toHaveBeenCalledTimes(1)
    return (client.app.log as unknown as ReturnType<typeof mock>).mock
      .calls[0]![0] as { body: { level: string; message: string } }
  }

  test('reports the bundled version when the override is unset', async () => {
    const { userAgent, billingHeader } = await captureReportedVersion(
      createMockClient(),
    )

    expect(userAgent).toBe(`claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`)
    expect(billingHeader).toContain(`cc_version=${CLAUDE_CODE_VERSION}.`)
  })

  test('reports a valid override in both the user-agent and billing header', async () => {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = '  2.9.99  '

    const { userAgent, billingHeader } = await captureReportedVersion(
      createMockClient(),
    )

    expect(userAgent).toBe('claude-cli/2.9.99 (external, cli)')
    // The billing suffix is derived from the override, not the bundled version.
    expect(billingHeader).toBe(
      buildBillingHeaderValue(
        [{ role: 'user', content: USER_MESSAGE }],
        '2.9.99',
        'sdk-cli',
      ),
    )
  })

  test('logs and falls back to the bundled version for a malformed override', async () => {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = 'latest'
    const client = createMockClient()

    const { userAgent, billingHeader } = await captureReportedVersion(client)

    const logged = readSingleLog(client)
    expect(logged.body.level).toBe('error')
    expect(logged.body.message).toContain(ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR)
    expect(logged.body.message).toContain('major.minor.patch')

    // Falling back keeps both reported values valid and in agreement.
    expect(userAgent).toBe(`claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`)
    expect(billingHeader).toContain(`cc_version=${CLAUDE_CODE_VERSION}.`)
  })

  test('warns but still reports an override older than the bundled version', async () => {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = '2.1.279'
    const client = createMockClient()

    const { userAgent, billingHeader } = await captureReportedVersion(client)

    const logged = readSingleLog(client)
    expect(logged.body.level).toBe('warn')
    expect(logged.body.message).toContain(ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR)
    expect(logged.body.message).toContain(CLAUDE_CODE_VERSION)

    // Warning it is not the same as ignoring it: the explicit override still
    // reaches both reported places.
    expect(userAgent).toBe('claude-cli/2.1.279 (external, cli)')
    expect(billingHeader).toContain('cc_version=2.1.279.')
  })

  test('stays silent for an override at or above the bundled version', async () => {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = CLAUDE_CODE_VERSION
    const client = createMockClient()

    await captureReportedVersion(client)

    expect(client.app.log).not.toHaveBeenCalled()
  })

  test('loads without throwing when the client cannot log', async () => {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = 'latest'

    const plugin = await AnthropicAuthPlugin({
      // @ts-expect-error: client without app.log, as in older OpenCode builds
      client: { auth: { set: mock(() => Promise.resolve()) } },
    })

    expect((plugin as any).auth.provider).toBe('anthropic')
  })
})
