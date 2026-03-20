import { describe, expect, test } from 'bun:test'
import { REQUIRED_BETAS } from '../constants'
import {
  computeBillingHeader,
  createStrippedStream,
  injectBillingHeader,
  mergeBetaHeaders,
  mergeHeaders,
  prefixToolNames,
  rewriteUrl,
  setOAuthHeaders,
  stripToolPrefix,
} from '../transform'

describe('mergeHeaders', () => {
  test('copies headers from a Request object', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-custom': 'value' },
    })
    const headers = mergeHeaders(request)
    expect(headers.get('x-custom')).toBe('value')
  })

  test('copies headers from init Headers object', () => {
    const headers = mergeHeaders('https://example.com', {
      headers: new Headers({ 'x-init': 'from-headers' }),
    })
    expect(headers.get('x-init')).toBe('from-headers')
  })

  test('copies headers from init array', () => {
    const headers = mergeHeaders('https://example.com', {
      headers: [['x-arr', 'from-array']],
    })
    expect(headers.get('x-arr')).toBe('from-array')
  })

  test('copies headers from init plain object', () => {
    const headers = mergeHeaders('https://example.com', {
      headers: { 'x-obj': 'from-object' },
    })
    expect(headers.get('x-obj')).toBe('from-object')
  })

  test('init headers override Request headers', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-key': 'from-request' },
    })
    const headers = mergeHeaders(request, {
      headers: { 'x-key': 'from-init' },
    })
    expect(headers.get('x-key')).toBe('from-init')
  })

  test('handles string input without init', () => {
    const headers = mergeHeaders('https://example.com')
    expect([...headers.entries()]).toHaveLength(0)
  })

  test('handles URL input', () => {
    const headers = mergeHeaders(new URL('https://example.com'))
    expect([...headers.entries()]).toHaveLength(0)
  })
})

describe('mergeBetaHeaders', () => {
  test('includes required betas when no incoming betas', () => {
    const headers = new Headers()
    const result = mergeBetaHeaders(headers)
    expect(result).toBe(REQUIRED_BETAS.join(','))
  })

  test('merges incoming betas with required betas', () => {
    const headers = new Headers({ 'anthropic-beta': 'custom-beta-1' })
    const result = mergeBetaHeaders(headers)

    for (const beta of REQUIRED_BETAS) {
      expect(result).toContain(beta)
    }
    expect(result).toContain('custom-beta-1')
  })

  test('deduplicates betas', () => {
    const headers = new Headers({
      'anthropic-beta': REQUIRED_BETAS[0],
    })
    const result = mergeBetaHeaders(headers)
    const parts = result.split(',')
    const occurrences = parts.filter((p) => p === REQUIRED_BETAS[0])
    expect(occurrences).toHaveLength(1)
  })

  test('handles comma-separated incoming betas', () => {
    const headers = new Headers({
      'anthropic-beta': 'beta-a, beta-b',
    })
    const result = mergeBetaHeaders(headers)
    expect(result).toContain('beta-a')
    expect(result).toContain('beta-b')
  })
})

describe('setOAuthHeaders', () => {
  test('sets authorization bearer token', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'my-token')
    expect(headers.get('authorization')).toBe('Bearer my-token')
  })

  test('sets user-agent', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'token')
    expect(headers.get('user-agent')).toContain('claude-code')
  })

  test('removes x-api-key', () => {
    const headers = new Headers({ 'x-api-key': 'sk-ant-xxx' })
    setOAuthHeaders(headers, 'token')
    expect(headers.get('x-api-key')).toBeNull()
  })

  test('sets anthropic-beta header', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'token')
    expect(headers.get('anthropic-beta')).toBeString()
    for (const beta of REQUIRED_BETAS) {
      expect(headers.get('anthropic-beta')).toContain(beta)
    }
  })
})

describe('prefixToolNames - OpenCode rewriting', () => {
  test('rewrites OpenCode to Claude Code in system prompt blocks', () => {
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'You are OpenCode, a coding assistant.' },
        { type: 'text', text: 'Use opencode tools.' },
      ],
    })
    const result = JSON.parse(prefixToolNames(body))
    expect(result.system[0].text).toBe(
      'You are Claude Code, a coding assistant.',
    )
    expect(result.system[1].text).toBe('Use Claude tools.')
  })

  test('does not rewrite non-text system blocks', () => {
    const body = JSON.stringify({
      system: [{ type: 'image', data: 'OpenCode' }],
    })
    const result = JSON.parse(prefixToolNames(body))
    expect(result.system[0].data).toBe('OpenCode')
  })

  test('handles system as string (no rewriting)', () => {
    const body = JSON.stringify({
      system: 'A string system prompt with OpenCode',
      tools: [],
    })
    const result = JSON.parse(prefixToolNames(body))
    // system is a string, not array — no rewriting applied
    expect(result.system).toBe('A string system prompt with OpenCode')
  })
})

describe('prefixToolNames', () => {
  test('prefixes tool definition names', () => {
    const body = JSON.stringify({
      tools: [
        { name: 'read_file', type: 'function' },
        { name: 'write_file', type: 'function' },
      ],
    })
    const result = JSON.parse(prefixToolNames(body))
    expect(result.tools[0].name).toBe('mcp_read_file')
    expect(result.tools[1].name).toBe('mcp_write_file')
  })

  test('prefixes tool_use block names in messages', () => {
    const body = JSON.stringify({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'bash', id: '1' },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    })
    const result = JSON.parse(prefixToolNames(body))
    expect(result.messages[0].content[0].name).toBe('mcp_bash')
    expect(result.messages[0].content[1].type).toBe('text')
  })

  test('does not prefix non-tool_use blocks', () => {
    const body = JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    })
    const result = JSON.parse(prefixToolNames(body))
    expect(result.messages[0].content[0]).toEqual({
      type: 'text',
      text: 'hello',
    })
  })

  test('handles missing tools and messages gracefully', () => {
    const body = JSON.stringify({ model: 'claude-3' })
    const result = JSON.parse(prefixToolNames(body))
    expect(result.model).toBe('claude-3')
  })

  test('returns original string on invalid JSON', () => {
    const body = 'not valid json'
    expect(prefixToolNames(body)).toBe(body)
  })

  test('handles tools without names', () => {
    const body = JSON.stringify({
      tools: [{ type: 'function' }],
    })
    const result = JSON.parse(prefixToolNames(body))
    expect(result.tools[0].name).toBeUndefined()
  })
})

describe('stripToolPrefix', () => {
  test('strips mcp_ prefix from tool names', () => {
    const text = '{"name": "mcp_read_file"}'
    expect(stripToolPrefix(text)).toBe('{"name": "read_file"}')
  })

  test('strips multiple prefixed names', () => {
    const text = '{"name": "mcp_tool_a"} and {"name": "mcp_tool_b"}'
    const result = stripToolPrefix(text)
    expect(result).toContain('"name": "tool_a"')
    expect(result).toContain('"name": "tool_b"')
  })

  test('does not strip names without mcp_ prefix', () => {
    const text = '{"name": "regular_tool"}'
    expect(stripToolPrefix(text)).toBe(text)
  })

  test('handles whitespace variations in JSON', () => {
    const text = '{"name"  :  "mcp_tool"}'
    expect(stripToolPrefix(text)).toBe('{"name": "tool"}')
  })
})

describe('rewriteUrl', () => {
  test('adds beta=true to /v1/messages URL string', () => {
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('adds beta=true to /v1/messages URL object', () => {
    const { input } = rewriteUrl(
      new URL('https://api.anthropic.com/v1/messages'),
    )
    const url = input instanceof URL ? input : new URL(input.toString())
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('adds beta=true to /v1/messages Request', () => {
    const request = new Request('https://api.anthropic.com/v1/messages')
    const { input } = rewriteUrl(request)
    const url = new URL((input as Request).url)
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('does not modify URL if beta param already exists', () => {
    const original = 'https://api.anthropic.com/v1/messages?beta=false'
    const { input } = rewriteUrl(original)
    const url = new URL(input.toString())
    expect(url.searchParams.get('beta')).toBe('false')
  })

  test('does not modify non-/v1/messages URLs', () => {
    const original = 'https://api.anthropic.com/v1/complete'
    const { input } = rewriteUrl(original)
    const url = new URL(input.toString())
    expect(url.searchParams.has('beta')).toBe(false)
  })
})

describe('computeBillingHeader', () => {
  test('short message "hey" - all indices out of bounds', async () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hey' }],
    })
    const result = await computeBillingHeader(body)
    expect(result).toBe(
      'x-anthropic-billing-header: cc_version=2.1.79.7b3; cc_entrypoint=cli; cch=00000;',
    )
  })

  test('message "abcdefg" - index 4 in bounds, 7 and 20 out', async () => {
    const body = JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { data: 'xxx' } },
            { type: 'text', text: 'abcdefg' },
          ],
        },
      ],
    })
    const result = await computeBillingHeader(body)
    expect(result).toBe(
      'x-anthropic-billing-header: cc_version=2.1.79.70c; cc_entrypoint=cli; cch=00000;',
    )
  })

  test('no user messages - all indices fallback to 0', async () => {
    const body = JSON.stringify({
      messages: [{ role: 'assistant', content: 'hello' }],
    })
    const result = await computeBillingHeader(body)
    expect(result).toContain('cc_version=2.1.79.')
    expect(result).toContain('cc_entrypoint=cli')
    expect(result).toContain('cch=00000')
  })

  test('returns fallback on invalid JSON', async () => {
    const result = await computeBillingHeader('not valid json')
    expect(result).toBe(
      'x-anthropic-billing-header: cc_version=2.1.79.000; cc_entrypoint=cli; cch=00000;',
    )
  })
})

describe('injectBillingHeader', () => {
  test('injects billing as first block with string system', async () => {
    const body = JSON.stringify({
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hey' }],
    })
    const result = JSON.parse(await injectBillingHeader(body))
    expect(Array.isArray(result.system)).toBe(true)
    expect(result.system[0].type).toBe('text')
    expect(result.system[0].text).toStartWith('x-anthropic-billing-header:')
    expect(result.system[1].text).toBe('You are helpful.')
  })

  test('injects billing as first block with array system', async () => {
    const body = JSON.stringify({
      system: [{ type: 'text', text: 'existing' }],
      messages: [{ role: 'user', content: 'hey' }],
    })
    const result = JSON.parse(await injectBillingHeader(body))
    expect(result.system[0].text).toStartWith('x-anthropic-billing-header:')
    expect(result.system[1].text).toBe('existing')
  })

  test('creates system array when no system exists', async () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hey' }],
    })
    const result = JSON.parse(await injectBillingHeader(body))
    expect(Array.isArray(result.system)).toBe(true)
    expect(result.system).toHaveLength(1)
    expect(result.system[0].text).toStartWith('x-anthropic-billing-header:')
  })

  test('returns original body on invalid JSON', async () => {
    const body = 'not valid json'
    expect(await injectBillingHeader(body)).toBe(body)
  })
})

describe('createStrippedStream', () => {
  test('strips tool prefixes from streamed response body', async () => {
    const chunks = [
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_read"}}\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    })

    const original = new Response(stream, { status: 200 })
    const stripped = createStrippedStream(original)

    const text = await stripped.text()
    expect(text).toContain('"name": "bash"')
    expect(text).toContain('"name": "read"')
    expect(text).not.toContain('mcp_bash')
    expect(text).not.toContain('mcp_read')
  })

  test('preserves response status and headers', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close()
      },
    })

    const original = new Response(stream, {
      status: 201,
      statusText: 'Created',
      headers: { 'x-custom': 'value' },
    })

    const stripped = createStrippedStream(original)
    expect(stripped.status).toBe(201)
    expect(stripped.headers.get('x-custom')).toBe('value')
  })

  test('returns original response if no body', () => {
    const original = new Response(null, { status: 204 })
    const result = createStrippedStream(original)
    expect(result).toBe(original)
  })
})
