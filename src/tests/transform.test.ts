import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  CLAUDE_CODE_IDENTITY,
  OPENCODE_IDENTITY,
  REQUIRED_BETAS,
} from '../constants'
import {
  computeCCH,
  createStrippedStream,
  extractFirstUserMessage,
  isInsecure,
  mergeBetaHeaders,
  mergeHeaders,
  prefixToolNames,
  prependClaudeCodeIdentity,
  rewriteRequestBody,
  rewriteUrl,
  sanitizeSystemText,
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
    const beta = REQUIRED_BETAS[0] ?? ''
    const headers = new Headers({
      'anthropic-beta': beta,
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
    expect(headers.get('user-agent')).toContain('claude-cli')
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
  const originalEnv = process.env.ANTHROPIC_BASE_URL

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ANTHROPIC_BASE_URL
    } else {
      process.env.ANTHROPIC_BASE_URL = originalEnv
    }
  })

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

  test('overrides origin when ANTHROPIC_BASE_URL is set', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('http://localhost:8080')
    expect(url.pathname).toBe('/v1/messages')
  })

  test('preserves beta=true when ANTHROPIC_BASE_URL is set', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('preserves existing query params when ANTHROPIC_BASE_URL is set', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const { input } = rewriteUrl(
      'https://api.anthropic.com/v1/messages?foo=bar',
    )
    const url = new URL(input.toString())
    expect(url.origin).toBe('http://localhost:8080')
    expect(url.searchParams.get('foo')).toBe('bar')
  })

  test('handles ANTHROPIC_BASE_URL with trailing slash', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080/'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.pathname).toBe('/v1/messages')
    expect(url.origin).toBe('http://localhost:8080')
  })

  test('ignores invalid ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'not-a-url'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://api.anthropic.com')
  })

  test('ignores empty ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = ''
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://api.anthropic.com')
  })

  test('rejects file: scheme in ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'file:///etc/passwd'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://api.anthropic.com')
  })

  test('rejects ANTHROPIC_BASE_URL with embedded credentials', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://user:pass@localhost:8080'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://api.anthropic.com')
  })

  test('returns original input when no URL changes are needed', () => {
    const original = 'https://api.anthropic.com/v1/complete'
    const { input } = rewriteUrl(original)
    expect(input).toBe(original)
  })

  test('returns original Request when no URL changes are needed', () => {
    const request = new Request('https://api.anthropic.com/v1/complete')
    const { input } = rewriteUrl(request)
    expect(input).toBe(request)
  })

  test('overrides origin for Request input when ANTHROPIC_BASE_URL is set', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const request = new Request('https://api.anthropic.com/v1/messages')
    const { input } = rewriteUrl(request)
    const url = new URL((input as Request).url)
    expect(url.origin).toBe('http://localhost:8080')
    expect(url.pathname).toBe('/v1/messages')
  })
})

describe('isInsecure', () => {
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
  const originalInsecure = process.env.ANTHROPIC_INSECURE

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.ANTHROPIC_BASE_URL
    } else {
      process.env.ANTHROPIC_BASE_URL = originalBaseUrl
    }
    if (originalInsecure === undefined) {
      delete process.env.ANTHROPIC_INSECURE
    } else {
      process.env.ANTHROPIC_INSECURE = originalInsecure
    }
  })

  test('returns false when neither env var is set', () => {
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_INSECURE
    expect(isInsecure()).toBe(false)
  })

  test('returns false when only ANTHROPIC_INSECURE is set (no base URL)', () => {
    delete process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_INSECURE = '1'
    expect(isInsecure()).toBe(false)
  })

  test('returns false when ANTHROPIC_BASE_URL is set but ANTHROPIC_INSECURE is not', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.local'
    delete process.env.ANTHROPIC_INSECURE
    expect(isInsecure()).toBe(false)
  })

  test('returns true when both are set and ANTHROPIC_INSECURE is "1"', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.local'
    process.env.ANTHROPIC_INSECURE = '1'
    expect(isInsecure()).toBe(true)
  })

  test('returns true when ANTHROPIC_INSECURE is "true"', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.local'
    process.env.ANTHROPIC_INSECURE = 'true'
    expect(isInsecure()).toBe(true)
  })

  test('returns false for other ANTHROPIC_INSECURE values', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.local'
    process.env.ANTHROPIC_INSECURE = 'yes'
    expect(isInsecure()).toBe(false)
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

describe('computeCCH', () => {
  test('produces deterministic 3-char hex hash', () => {
    const hash = computeCCH('hello world test message', '2.1.2')
    expect(hash).toHaveLength(3)
    expect(hash).toMatch(/^[a-f0-9]{3}$/)
    // Same input should produce same output
    expect(computeCCH('hello world test message', '2.1.2')).toBe(hash)
  })

  test('different messages produce different hashes', () => {
    const hash1 = computeCCH('hello world test message', '2.1.2')
    const hash2 = computeCCH('different text entirely', '2.1.2')
    expect(hash1).not.toBe(hash2)
  })

  test('different versions produce different hashes', () => {
    const hash1 = computeCCH('hello world test message', '2.1.2')
    const hash2 = computeCCH('hello world test message', '2.2.0')
    expect(hash1).not.toBe(hash2)
  })

  test('falls back to random hash for empty message', () => {
    const hash = computeCCH('', '2.1.2')
    expect(hash).toHaveLength(3)
    expect(hash).toMatch(/^[a-f0-9]{3}$/)
  })

  test('random fallback produces different values each call', () => {
    const hashes = new Set(
      Array.from({ length: 20 }, () => computeCCH('', '2.1.2')),
    )
    // With 20 random 3-hex-char values, extremely unlikely to all be identical
    expect(hashes.size).toBeGreaterThan(1)
  })

  test('handles message shorter than max position (20)', () => {
    const hash = computeCCH('hi', '2.1.2')
    expect(hash).toHaveLength(3)
    expect(hash).toMatch(/^[a-f0-9]{3}$/)
    // Should be deterministic — short chars replaced with '0'
    expect(computeCCH('hi', '2.1.2')).toBe(hash)
  })

  test('uses characters at positions 4, 7, 20 from message', () => {
    // Position:  0123456789...
    // Message:   abcdeXfgYhijklmnopqrstUvw
    //                 ^4  ^7              ^20 (0-indexed)
    // Chars at 4='e', 7='Y' — but position 20 depends on length
    const msg = 'abcdeXfgYhijklmnopqrstUvw'
    const hash1 = computeCCH(msg, '2.1.2')
    // Change char at position 4
    const msg2 = 'abcdZXfgYhijklmnopqrstUvw'
    const hash2 = computeCCH(msg2, '2.1.2')
    expect(hash1).not.toBe(hash2)
  })
})

describe('extractFirstUserMessage', () => {
  test('extracts string content from first user message', () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello world' },
    ]
    expect(extractFirstUserMessage(messages)).toBe('hello world')
  })

  test('extracts text block from array content', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image', source: {} },
          { type: 'text', text: 'describe this image' },
        ],
      },
    ]
    expect(extractFirstUserMessage(messages)).toBe('describe this image')
  })

  test('returns empty string when no user message', () => {
    const messages = [{ role: 'assistant', content: 'hi' }]
    expect(extractFirstUserMessage(messages)).toBe('')
  })

  test('returns empty string for non-array input', () => {
    expect(extractFirstUserMessage('not an array' as any)).toBe('')
  })

  test('skips assistant messages to find first user', () => {
    const messages = [
      { role: 'assistant', content: 'I can help' },
      { role: 'assistant', content: 'with that' },
      { role: 'user', content: 'actual user message' },
    ]
    expect(extractFirstUserMessage(messages)).toBe('actual user message')
  })

  test('returns empty string when content has no text block', () => {
    const messages = [
      { role: 'user', content: [{ type: 'image', source: {} }] },
    ]
    expect(extractFirstUserMessage(messages)).toBe('')
  })

  test('returns empty string for empty messages array', () => {
    expect(extractFirstUserMessage([])).toBe('')
  })
})

describe('sanitizeSystemText', () => {
  const SYSTEM_WITH_OPENCODE = `${OPENCODE_IDENTITY}\n\nSome OpenCode specific instructions\n\n# Code References\n\nActual content here`

  test('removes section between OpenCode identity and Code References', () => {
    const result = sanitizeSystemText(SYSTEM_WITH_OPENCODE)
    expect(result).not.toContain(OPENCODE_IDENTITY)
    expect(result).toContain('# Code References')
    expect(result).toContain('Actual content here')
  })

  test('returns text unchanged when OpenCode identity not present', () => {
    const text = 'Just a normal system prompt'
    expect(sanitizeSystemText(text)).toBe(text)
  })

  test('calls onError when Code References marker is missing', () => {
    const onError = mock(() => {})
    const text = `${OPENCODE_IDENTITY}\n\nSome instructions without marker`
    const result = sanitizeSystemText(text, onError)
    expect(result).toBe(text) // unchanged
    expect(onError).toHaveBeenCalledTimes(1)
  })

  test('preserves content before OpenCode identity', () => {
    const text = `Prefix content\n${OPENCODE_IDENTITY}\nstuff\n# Code References\nrest`
    const result = sanitizeSystemText(text)
    expect(result).toBe('Prefix content\n# Code References\nrest')
  })

  test('handles identity at the very start of text', () => {
    const text = `${OPENCODE_IDENTITY}\n# Code References\nrest`
    const result = sanitizeSystemText(text)
    expect(result).toBe('# Code References\nrest')
  })

  test('only processes first occurrence of OpenCode identity', () => {
    const text = `${OPENCODE_IDENTITY}\nfirst\n# Code References\nmiddle\n${OPENCODE_IDENTITY}\nsecond`
    const result = sanitizeSystemText(text)
    // First occurrence removed, second stays
    expect(result).toBe(
      `# Code References\nmiddle\n${OPENCODE_IDENTITY}\nsecond`,
    )
  })
})

describe('prependClaudeCodeIdentity', () => {
  test('returns identity block for undefined system', () => {
    const result = prependClaudeCodeIdentity(undefined)
    expect(result).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])
  })

  test('sanitizes and prepends for string system', () => {
    const result = prependClaudeCodeIdentity('Some assistant prompt')
    expect(result).toHaveLength(2)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result[1]?.text).toBe('Some assistant prompt')
  })

  test('sanitizes array of text blocks', () => {
    const system = [
      {
        type: 'text',
        text: `${OPENCODE_IDENTITY}\nstuff\n# Code References\nrest`,
      },
      { type: 'text', text: 'other block' },
    ]
    const result = prependClaudeCodeIdentity(system)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result[1]?.text).not.toContain(OPENCODE_IDENTITY)
    expect(result[1]?.text).toContain('# Code References')
  })

  test('does not double-prepend if identity already present', () => {
    const system = [
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: 'other' },
    ]
    const result = prependClaudeCodeIdentity(system)
    expect(result).toHaveLength(2)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('handles string elements in array', () => {
    const system = ['some text', 'more text']
    const result = prependClaudeCodeIdentity(system)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result[1]).toEqual({ type: 'text', text: 'some text' })
  })
})

describe('rewriteRequestBody', () => {
  test('prefixes tool names and rewrites system prompt', () => {
    const body = JSON.stringify({
      tools: [{ name: 'bash', type: 'function' }],
      messages: [{ role: 'user', content: 'hello world test message' }],
      system: 'You are a helpful assistant.',
    })
    const result = JSON.parse(rewriteRequestBody(body))
    expect(result.tools[0].name).toBe('mcp_bash')
    expect(result.system[0].text).toContain(CLAUDE_CODE_IDENTITY)
    expect(result.system[0].text).toMatch(/cc_version=[\d.]+\.[a-f0-9]{3}/)
  })

  test('injects CCH hash into identity block', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'test content here for hashing' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))
    expect(result.system[0].text).toMatch(/cc_version=2\.1\.2\.[a-f0-9]{3}/)
  })

  test('handles missing system field', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))
    expect(result.system).toHaveLength(1)
    expect(result.system[0].text).toContain(CLAUDE_CODE_IDENTITY)
  })

  test('returns original string on invalid JSON', () => {
    const body = 'not valid json'
    expect(rewriteRequestBody(body)).toBe(body)
  })

  test('passes onError through to sanitization', () => {
    const onError = mock(() => {})
    const body = JSON.stringify({
      messages: [],
      system: `${OPENCODE_IDENTITY}\nno code refs marker here`,
    })
    rewriteRequestBody(body, onError)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  test('rewrites realistic OpenCode system prompt end-to-end', () => {
    const body = JSON.stringify({
      tools: [
        { name: 'bash', type: 'function' },
        { name: 'read_file', type: 'function' },
      ],
      messages: [
        { role: 'user', content: 'Help me fix this bug in main.ts' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'bash', id: 'tool_1' },
            { type: 'text', text: 'Let me check' },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'output',
            },
          ],
        },
      ],
      system: [
        {
          type: 'text',
          text: `${OPENCODE_IDENTITY}\n\nYou have access to tools.\n\n# Code References\n\nHere are some files.`,
        },
        { type: 'text', text: 'Additional context block' },
      ],
    })

    const result = JSON.parse(rewriteRequestBody(body))

    // System: identity prepended, OpenCode section removed
    expect(result.system[0].text).toContain(CLAUDE_CODE_IDENTITY)
    expect(result.system[0].text).toMatch(/cc_version=/)
    expect(result.system[1].text).toContain('# Code References')
    expect(result.system[1].text).not.toContain(OPENCODE_IDENTITY)
    expect(result.system[1].text).not.toContain('You have access to tools')
    expect(result.system[2].text).toBe('Additional context block')

    // Tools: prefixed
    expect(result.tools[0].name).toBe('mcp_bash')
    expect(result.tools[1].name).toBe('mcp_read_file')

    // Messages: tool_use blocks prefixed
    expect(result.messages[1].content[0].name).toBe('mcp_bash')
    // Text blocks untouched
    expect(result.messages[1].content[1].text).toBe('Let me check')
    // User messages untouched
    expect(result.messages[0].content).toBe('Help me fix this bug in main.ts')
  })

  test('CCH hash is deterministic for same message', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'consistent message content' }],
    })
    const result1 = JSON.parse(rewriteRequestBody(body))
    const result2 = JSON.parse(rewriteRequestBody(body))
    expect(result1.system[0].text).toBe(result2.system[0].text)
  })

  test('CCH hash differs for different messages', () => {
    const body1 = JSON.stringify({
      messages: [{ role: 'user', content: 'first message here' }],
    })
    const body2 = JSON.stringify({
      messages: [{ role: 'user', content: 'different message' }],
    })
    const result1 = JSON.parse(rewriteRequestBody(body1))
    const result2 = JSON.parse(rewriteRequestBody(body2))
    const hash1 = result1.system[0].text.match(
      /cc_version=[\d.]+\.([a-f0-9]{3})/,
    )?.[1]
    const hash2 = result2.system[0].text.match(
      /cc_version=[\d.]+\.([a-f0-9]{3})/,
    )?.[1]
    expect(hash1).not.toBe(hash2)
  })

  test('handles body with no messages array', () => {
    const body = JSON.stringify({ model: 'claude-3' })
    const result = JSON.parse(rewriteRequestBody(body))
    expect(result.system[0].text).toContain(CLAUDE_CODE_IDENTITY)
  })
})
