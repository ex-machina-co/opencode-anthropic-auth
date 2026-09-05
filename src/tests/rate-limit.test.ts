import { describe, expect, test } from 'bun:test'
import {
  createConnectionLabel,
  describeConnection,
  enhanceRateLimitResponse,
  isSubscriptionUsageDiagnostic,
} from '../rate-limit'

const connection = 'Anthropic 3 [connection af60761e26]'

describe('privacy-safe connection identity', () => {
  test('creates distinguishable labels from random bytes, not credentials', () => {
    expect(createConnectionLabel(Uint8Array.of(0x01, 0x23, 0xab, 0xcd))).toBe(
      'Claude OAuth • 0123ABCD',
    )
    expect(createConnectionLabel(Uint8Array.of(0x01, 0x23, 0xab, 0xce))).toBe(
      'Claude OAuth • 0123ABCE',
    )
  })

  test('describes generic and plugin labels without exposing arbitrary labels', () => {
    expect(
      describeConnection({
        type: 'credential',
        id: 'cred-active-stale',
        label: 'Anthropic 3',
      }),
    ).toMatch(/^Anthropic 3 \[connection [a-f0-9]{10}\]$/)
    expect(
      describeConnection({
        type: 'credential',
        id: 'cred-personal',
        label: 'person@example.com',
      }),
    ).toMatch(/^Custom label hidden \[connection [a-f0-9]{10}\]$/)
    expect(
      describeConnection({
        type: 'credential',
        id: 'cred-generated',
        label: 'Claude OAuth • 0123ABCD',
      }),
    ).toMatch(/^Claude OAuth • 0123ABCD \[connection [a-f0-9]{10}\]$/)
  })
})

describe('Anthropic 429 diagnostics', () => {
  test('preserves a subscription usage block and marks it non-retryable', async () => {
    const original = new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'You have reached your weekly usage limit.',
        },
        request_id: 'req_safe_123',
        ignored: { body: 'must not survive' },
      }),
      {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': '999',
          'content-encoding': 'gzip',
          'retry-after': '30',
          'request-id': 'req_safe_123',
        },
      },
    )

    const result = await enhanceRateLimitResponse(original, connection)
    expect(result.category).toBe('subscription-usage')
    expect(result.response).not.toBe(original)
    expect(result.response.status).toBe(429)
    expect(result.response.statusText).toBe('Too Many Requests')
    expect(result.response.headers.get('retry-after')).toBe('30')
    expect(result.response.headers.get('request-id')).toBe('req_safe_123')
    expect(result.response.headers.get('x-should-retry')).toBe('false')
    expect(result.response.headers.get('content-length')).toBeNull()
    expect(result.response.headers.get('content-encoding')).toBeNull()

    const body = (await result.response.json()) as {
      type: string
      error: { type: string; message: string }
      request_id?: string
    }
    expect(body).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: expect.stringContaining(
          'Anthropic reports that this account has reached a subscription or usage limit.',
        ),
      },
      request_id: 'req_safe_123',
    })
    expect(body.error.message).toContain('category=subscription-usage')
    expect(body.error.message).toContain(`active=${connection}`)
    expect(body.error.message).toContain('retry-after=30s')
    expect(body.error.message).toContain('request-id=req_safe_123')
    expect(isSubscriptionUsageDiagnostic(body.error.message)).toBe(true)
  })

  test('keeps a transient request limit retryable', async () => {
    const original = Response.json(
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Rate limited. Please try again later.',
        },
      },
      { status: 429, headers: { 'retry-after': '2' } },
    )

    const result = await enhanceRateLimitResponse(original, connection)
    expect(result.category).toBe('transient-rate-limit')
    expect(result.response.headers.get('x-should-retry')).toBeNull()
    const body = (await result.response.json()) as {
      error: { message: string }
    }
    expect(body.error.message).toContain('category=transient-rate-limit')
    expect(isSubscriptionUsageDiagnostic(body.error.message)).toBe(false)
  })

  test('keeps ambiguous account rate-limit wording retryable even with Retry-After', async () => {
    const original = Response.json(
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message:
            "This request would exceed your account's rate limit. Please try again later.",
        },
      },
      { status: 429, headers: { 'retry-after': '30' } },
    )

    const result = await enhanceRateLimitResponse(original, connection)
    const body = (await result.response.json()) as {
      error: { message: string }
    }
    expect(result.category).toBe('transient-rate-limit')
    expect(result.response.headers.get('x-should-retry')).toBeNull()
    expect(body.error.message).toContain('category=transient-rate-limit')
  })

  test('treats extra-usage requirements as a structural usage block', async () => {
    const original = Response.json(
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Extra usage is required for long context requests.',
        },
      },
      { status: 429 },
    )

    const result = await enhanceRateLimitResponse(original, connection)
    expect(result.category).toBe('subscription-usage')
    expect(result.response.headers.get('x-should-retry')).toBe('false')
  })

  test('redacts possible PII and credential material instead of copying the body', async () => {
    const secret = `sk-ant-oat01-${'A'.repeat(48)}`
    const original = Response.json(
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message:
            `Usage limit reached for person@example.com ${secret} ` +
            'org_private123456 https://example.com/path?account=private',
        },
        debug: { access_token: secret },
      },
      { status: 429 },
    )

    const result = await enhanceRateLimitResponse(original, connection)
    const text = await result.response.text()
    expect(text).not.toContain('person@example.com')
    expect(text).not.toContain(secret)
    expect(text).not.toContain('org_private123456')
    expect(text).not.toContain('account=private')
    expect(text).not.toContain('access_token')
    expect(text).not.toContain('private')
    expect(text).toContain(
      'Anthropic reports that this account has reached a subscription or usage limit.',
    )
  })

  test('never reflects arbitrary short names, phone numbers, or prompt text', async () => {
    const original = Response.json(
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message:
            'Usage limit reached for Alice at +1-555-0100 while processing "private prompt fragment".',
        },
      },
      { status: 429 },
    )

    const result = await enhanceRateLimitResponse(original, connection)
    const text = await result.response.text()
    expect(text).not.toContain('Alice')
    expect(text).not.toContain('555')
    expect(text).not.toContain('private prompt fragment')
    expect(text).toContain('category=subscription-usage')
  })

  test('omits a body request ID unless it has the known Anthropic req_ format', async () => {
    const original = Response.json(
      {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Rate limited.' },
        request_id: 'oauth_secret_like_value_123456789',
      },
      { status: 429 },
    )

    const result = await enhanceRateLimitResponse(original, connection)
    const text = await result.response.text()
    expect(text).not.toContain('oauth_secret_like_value_123456789')
    expect(text).not.toContain('request-id=')
  })

  test('passes malformed, non-JSON, and declared-oversized responses through', async () => {
    const malformed = new Response('{"error":', {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })
    const text = new Response('rate limited', {
      status: 429,
      headers: { 'content-type': 'text/plain' },
    })
    const oversized = Response.json(
      { error: { type: 'rate_limit_error', message: 'Rate limited' } },
      { status: 429, headers: { 'content-length': String(64 * 1024 + 1) } },
    )

    const malformedResult = await enhanceRateLimitResponse(
      malformed,
      connection,
    )
    expect(malformedResult.category).toBe('unknown-rate-limit')
    expect(await malformedResult.response.text()).toBe('{"error":')
    await expect(enhanceRateLimitResponse(text, connection)).resolves.toEqual({
      response: text,
      category: 'unknown-rate-limit',
    })
    await expect(
      enhanceRateLimitResponse(oversized, connection),
    ).resolves.toEqual({ response: oversized, category: 'unknown-rate-limit' })
  })

  test('passes an actually oversized chunked body through without consuming it', async () => {
    const payload = JSON.stringify({
      error: { type: 'rate_limit_error', message: 'x'.repeat(70 * 1024) },
    })
    const original = new Response(payload, {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })

    const result = await enhanceRateLimitResponse(original, connection)
    expect(result.category).toBe('unknown-rate-limit')
    expect(await result.response.text()).toBe(payload)
  })

  test('replays one multi-megabyte source chunk without copying or truncating it', async () => {
    const payload = new Uint8Array(2 * 1024 * 1024)
    payload.fill(0x78)
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload)
          controller.close()
        },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    )

    const result = await enhanceRateLimitResponse(original, connection)
    const replayed = new Uint8Array(await result.response.arrayBuffer())
    expect(result.category).toBe('unknown-rate-limit')
    expect(replayed.byteLength).toBe(payload.byteLength)
    expect(replayed[0]).toBe(0x78)
    expect(replayed.at(-1)).toBe(0x78)
  })

  test('returns a stalled chunked body to the host after the diagnostic timeout', async () => {
    const original = new Response(new ReadableStream<Uint8Array>(), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })

    const result = await enhanceRateLimitResponse(original, connection, {
      probeTimeoutMs: 10,
    })

    expect(result.category).toBe('unknown-rate-limit')
    expect(result.response.status).toBe(429)
    await result.response.body?.cancel()
  }, 500)

  test('handles a late stalled-read rejection before replay consumption', async () => {
    let rejectRead: ((error: Error) => void) | undefined
    const original = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>((_resolve, reject) => {
            rejectRead = reject
          })
        },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    )

    const result = await enhanceRateLimitResponse(original, connection, {
      probeTimeoutMs: 10,
    })
    rejectRead?.(new Error('late source failure'))
    await Promise.resolve()

    expect(result.category).toBe('unknown-rate-limit')
    await result.response.body?.cancel().catch(() => {})
  }, 500)

  test('replays a genuinely streaming oversized body byte-for-byte', async () => {
    const chunks = [
      new TextEncoder().encode('{"error":{"message":"'),
      new TextEncoder().encode('x'.repeat(40 * 1024)),
      new TextEncoder().encode('y'.repeat(30 * 1024)),
      new TextEncoder().encode('"}}'),
    ]
    const expected = Buffer.concat(chunks).toString()
    const original = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift()
          if (chunk) controller.enqueue(chunk)
          else controller.close()
        },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    )

    const result = await enhanceRateLimitResponse(original, connection)

    expect(result.category).toBe('unknown-rate-limit')
    expect(await result.response.text()).toBe(expected)
  })

  test('bounds zero-length chunk processing without retaining empty chunks', async () => {
    let pulls = 0
    const original = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++
          controller.enqueue(new Uint8Array())
        },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    )

    const result = await enhanceRateLimitResponse(original, connection, {
      probeTimeoutMs: 100,
    })

    expect(result.category).toBe('unknown-rate-limit')
    expect(pulls).toBeLessThanOrEqual(1028)
    await result.response.body?.cancel()
  })
})
