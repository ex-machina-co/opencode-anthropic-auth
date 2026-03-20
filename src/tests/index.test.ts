import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { AnthropicAuthPlugin } from '../index'

// Minimal mock of the OpenCode plugin client
function createMockClient() {
  return {
    auth: {
      set: mock(() => Promise.resolve()),
    },
  } as any
}

async function getPlugin(client?: any) {
  return AnthropicAuthPlugin({
    client: client ?? createMockClient(),
    app: {} as any,
    $: {} as any,
  }) as Promise<any>
}

describe('AnthropicAuthPlugin', () => {
  test('returns an object with expected hook and auth properties', async () => {
    const plugin = await getPlugin()
    expect(plugin['experimental.chat.system.transform']).toBeFunction()
    expect(plugin.auth).toBeDefined()
    expect(plugin.auth.provider).toBe('anthropic')
    expect(plugin.auth.loader).toBeFunction()
    expect(plugin.auth.methods).toBeArray()
  })
})

describe('experimental.chat.system.transform', () => {
  const PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

  test('prepends system prefix for anthropic provider', async () => {
    const plugin = await getPlugin()
    const hook = plugin['experimental.chat.system.transform']
    const output = { system: ['Existing system prompt'] }
    hook({ model: { providerID: 'anthropic' } }, output)

    expect(output.system[0]).toBe(PREFIX)
    expect(output.system[1]).toBe(`${PREFIX}\n\nExisting system prompt`)
  })

  test('does not modify system for non-anthropic providers', async () => {
    const plugin = await getPlugin()
    const hook = plugin['experimental.chat.system.transform']
    const output = { system: ['Original prompt'] }
    hook({ model: { providerID: 'openai' } }, output)

    expect(output.system).toEqual(['Original prompt'])
  })

  test('handles empty system array for anthropic', async () => {
    const plugin = await getPlugin()
    const hook = plugin['experimental.chat.system.transform']
    const output = { system: [] as string[] }
    hook({ model: { providerID: 'anthropic' } }, output)

    expect(output.system[0]).toBe(PREFIX)
    expect(output.system).toHaveLength(1)
  })
})

describe('auth.methods', () => {
  test('has three auth methods', async () => {
    const plugin = await getPlugin()
    expect(plugin.auth.methods).toHaveLength(3)
  })

  test('first method is Claude Pro/Max OAuth', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[0]
    expect(method.label).toBe('Claude Pro/Max')
    expect(method.type).toBe('oauth')
    expect(method.authorize).toBeFunction()
  })

  test('second method is Create an API Key OAuth', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[1]
    expect(method.label).toBe('Create an API Key')
    expect(method.type).toBe('oauth')
  })

  test('third method is manual API key', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[2]
    expect(method.label).toBe('Manually enter API Key')
    expect(method.type).toBe('api')
    expect(method.provider).toBe('anthropic')
  })
})

describe('auth.methods callbacks', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  test('Claude Pro/Max authorize returns OAuth URL and callback', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[0]
    const result = await method.authorize()

    expect(result.url).toContain('claude.ai/oauth/authorize')
    expect(result.url).toContain('client_id=')
    expect(result.instructions).toContain('Paste')
    expect(result.method).toBe('code')
    expect(result.callback).toBeFunction()
  })

  test('Claude Pro/Max callback calls exchange and returns result', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'r',
            access_token: 'a',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const method = plugin.auth.methods[0]
    const auth = await method.authorize()
    const result = await auth.callback('code123#state456')

    expect(result.type).toBe('success')
    if (result.type === 'success') {
      expect(result.refresh).toBe('r')
      expect(result.access).toBe('a')
    }
  })

  test('Create an API Key authorize returns console URL', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[1]
    const result = await method.authorize()

    expect(result.url).toContain('platform.claude.com/oauth/authorize')
    expect(result.callback).toBeFunction()
  })

  test('Create an API Key callback returns API key on success', async () => {
    let callCount = 0
    globalThis.fetch = mock(() => {
      callCount++
      if (callCount === 1) {
        // Token exchange
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'r',
              access_token: 'access-tok',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      // API key creation
      return Promise.resolve(
        new Response(JSON.stringify({ raw_key: 'sk-ant-test-key' }), {
          status: 200,
        }),
      )
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const method = plugin.auth.methods[1]
    const auth = await method.authorize()
    const result = await auth.callback('code#state')

    expect(result.type).toBe('success')
    expect(result.key).toBe('sk-ant-test-key')
  })

  test('Create an API Key callback returns failed on exchange failure', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Unauthorized', { status: 401 })),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const method = plugin.auth.methods[1]
    const auth = await method.authorize()
    const result = await auth.callback('bad-code#state')

    expect(result.type).toBe('failed')
  })
})

describe('auth.loader', () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout

  beforeEach(() => {
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
      messages: [],
    })

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body,
    })

    expect(capturedHeaders).toBeDefined()
    expect(capturedHeaders!.get('authorization')).toBe('Bearer my-access-token')
    expect(capturedHeaders!.get('x-api-key')).toBeNull()
    expect(capturedHeaders!.get('anthropic-beta')).toContain('oauth-2025-04-20')

    // Tool name should be prefixed
    const parsedBody = JSON.parse(capturedBody!)
    expect(parsedBody.tools[0].name).toBe('mcp_bash')
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
    const setTimeoutMock = mock((handler: TimerHandler) => {
      if (typeof handler === 'function') {
        handler()
      }
      return 0 as ReturnType<typeof setTimeout>
    }) as typeof setTimeout

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

  test('fetch wrapper logs error on non-OK API response', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('{"error":"bad_request"}', {
          status: 400,
          statusText: 'Bad Request',
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
      { method: 'POST', body: '{}' },
    )

    // Should still return the response (not throw)
    expect(response.status).toBe(400)
  })

  test('fetch wrapper injects billing header into system prompt', async () => {
    let capturedBody: string | undefined

    globalThis.fetch = mock((_input: any, init: any) => {
      capturedBody = init?.body
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

    const body = JSON.stringify({
      system: [{ type: 'text', text: 'You are helpful.' }],
      messages: [{ role: 'user', content: 'hello world' }],
    })

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body,
    })

    const parsed = JSON.parse(capturedBody!)
    expect(parsed.system[0].type).toBe('text')
    expect(parsed.system[0].text).toStartWith('x-anthropic-billing-header:')
    expect(parsed.system[0].text).toContain('cc_version=2.1.79.')
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
