import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { AnthropicAuthPlugin } from '../index'

// Minimal mock of the OpenCode plugin client
function createMockClient() {
  return {
    auth: {
      set: mock(() => Promise.resolve()),
    },
  }
}

async function getPlugin(client?: ReturnType<typeof createMockClient>) {
  return AnthropicAuthPlugin({
    // @ts-expect-error: minimal mock for testing
    client: client ?? createMockClient(),
  }) as Promise<any>
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
    expect(parsedBody.tools[0].name).toBe('mcp_bash')
    // System prompt should be rewritten with Claude Code identity
    expect(parsedBody.system[0].text).toContain(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    )
  })

  test('fetch wrapper refreshes expired token', async () => {
    const fetchCalls: Array<{ url: string; body?: string }> = []

    globalThis.fetch = mock((input: any, init: any) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
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
    const setTimeoutMock = mock((handler: Function) => {
      handler()
      return 0
    })

    // @ts-expect-error — mock override for testing
    globalThis.setTimeout = setTimeoutMock

    globalThis.fetch = mock((input: any) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

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
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
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
      Promise.resolve(new Response(responseStream, { status: 200 })),
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

    // @ts-expect-error — mock override for testing
    globalThis.setTimeout = mock((handler: Function) => {
      handler()
      return 0
    })

    globalThis.fetch = mock((input: any, init: any) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

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

    // Fire 5 concurrent requests, all with expired token
    await Promise.all([
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ])

    // With deduplication, only ONE refresh request should be made, not 5
    expect(tokenRefreshCount).toBe(1)
  })

  test('concurrent refresh with token rotation should not cause cascading failures', async () => {
    const usedRefreshTokens = new Set<string>()

    // @ts-expect-error — mock override for testing
    globalThis.setTimeout = mock((handler: Function) => {
      handler()
      return 0
    })

    globalThis.fetch = mock((input: any, init: any) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

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

    // Fire 5 concurrent requests — ALL should succeed because only one refresh
    // fires and the rest reuse its result
    const outcomes = await Promise.all([
      result
        .fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        })
        .then(
          () => 'ok' as const,
          () => 'fail' as const,
        ),
      result
        .fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        })
        .then(
          () => 'ok' as const,
          () => 'fail' as const,
        ),
      result
        .fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        })
        .then(
          () => 'ok' as const,
          () => 'fail' as const,
        ),
      result
        .fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        })
        .then(
          () => 'ok' as const,
          () => 'fail' as const,
        ),
      result
        .fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        })
        .then(
          () => 'ok' as const,
          () => 'fail' as const,
        ),
    ])

    // With deduplication, all callers share the single successful refresh.
    // Without it, 4 out of 5 get 401 from the rotated-away token → cascading failures.
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
  })

  test('concurrent refresh should persist tokens exactly once', async () => {
    // @ts-expect-error — mock override for testing
    globalThis.setTimeout = mock((handler: Function) => {
      handler()
      return 0
    })

    globalThis.fetch = mock((input: any) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

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
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await Promise.all([
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ])

    // With deduplication, client.auth.set should be called exactly once.
    // Without it, each concurrent refresh calls auth.set independently → 5 calls.
    expect(mockClient.auth.set).toHaveBeenCalledTimes(1)
  })

  test('fetch wrapper adds beta=true to /v1/messages URL', async () => {
    let capturedUrl: string | undefined

    globalThis.fetch = mock((input: any) => {
      capturedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
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
