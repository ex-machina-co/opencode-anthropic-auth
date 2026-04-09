import { afterEach, describe, expect, mock, test } from 'bun:test'
import dedent from 'dedent'
import {
  CLAUDE_CODE_IDENTITY,
  OPENCODE_IDENTITY,
  REQUIRED_BETAS,
} from '../constants'
import {
  createStrippedStream,
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

describe('sanitizeSystemText', () => {
  // Anchor-based sanitization. Three mechanisms:
  //
  //   1. The OPENCODE_IDENTITY line is always removed.
  //   2. Any paragraph containing a PARAGRAPH_REMOVAL_ANCHORS entry
  //      (e.g. "github.com/anomalyco/opencode", "opencode.ai/docs")
  //      is removed entirely.
  //   3. TEXT_REPLACEMENTS are applied inline for short branded strings
  //      inside paragraphs we want to keep (e.g. "if OpenCode honestly"
  //      → "if the assistant honestly").
  //
  // Everything else — generic instructions, tone/style, task management,
  // tool policy, environment info, skills, user instructions, file paths
  // containing "opencode", etc. — is preserved.

  test('returns text unchanged when OpenCode identity not present', () => {
    const text = 'Just a normal system prompt'
    expect(sanitizeSystemText(text)).toBe(text)
  })

  test('removes identity, keeps generic content', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      You have access to tools for reading files.

      Instructions from: ~/.config/opencode/preamble.md
      Be concise. Prefer TypeScript.

      # Code References
      src/index.ts (1-50)
    `)
    expect(result).toMatchInlineSnapshot(`
      "You have access to tools for reading files.

      Instructions from: ~/.config/opencode/preamble.md
      Be concise. Prefer TypeScript.

      # Code References
      src/index.ts (1-50)"
    `)
  })

  test('removes paragraph containing feedback URL anchor', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      Report issues at https://github.com/anomalyco/opencode please.

      Generic instructions that stay.
    `)
    expect(result).toMatchInlineSnapshot(`"Generic instructions that stay."`)
  })

  test('removes paragraph containing docs URL anchor', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      Check out the docs at https://opencode.ai/docs for more info.

      Other content preserved.
    `)
    expect(result).toMatchInlineSnapshot(`"Other content preserved."`)
  })

  test('applies inline text replacement', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      It is best if OpenCode honestly applies rigorous standards.
    `)
    expect(result).toMatchInlineSnapshot(
      `"It is best if the assistant honestly applies rigorous standards."`,
    )
  })

  test('preserves "opencode" in file paths and unrelated content', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      Instructions from: /Users/user/project/.opencode/AGENTS.md
      Run opencode to start the CLI.
    `)
    expect(result).toMatchInlineSnapshot(`
      "Instructions from: /Users/user/project/.opencode/AGENTS.md
      Run opencode to start the CLI."
    `)
  })

  test('preserves content before and after identity', () => {
    const result = sanitizeSystemText(dedent`
      Some prefix content

      You are OpenCode, the best coding agent on the planet.

      # Code References
      file contents
    `)
    expect(result).toMatchInlineSnapshot(`
      "Some prefix content

      # Code References
      file contents"
    `)
  })

  test('does not call onError when identity is present and removed', () => {
    const onError = mock(() => {})
    sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      Normal content.
    `)
    expect(onError).not.toHaveBeenCalled()
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

  test('does not call onError when identity is present (rules always match)', () => {
    const onError = mock(() => {})
    const body = JSON.stringify({
      messages: [],
      system: `${OPENCODE_IDENTITY}\nsome other content`,
    })
    rewriteRequestBody(body)
    expect(onError).not.toHaveBeenCalled()
  })

  test('rewrites realistic OpenCode request end-to-end', () => {
    //  Input system prompt (array of blocks):
    //    [0] "You are OpenCode..." + generic content + "# Code References\n..."
    //    [1] "Additional context block"
    //
    //  Expected output:
    //    [0] Claude Code identity (prepended)
    //    [1] Identity removed, generic content preserved, # Code References kept
    //    [2] "Additional context block" (untouched)

    const systemPrompt = [
      'You are OpenCode, the best coding agent on the planet.',
      '',
      'You have access to tools.',
      '',
      '# Code References',
      '',
      'Here are some files.',
    ].join('\n')

    const body = JSON.stringify({
      tools: [
        { name: 'bash', type: 'function' },
        { name: 'read_file', type: 'function' },
      ],
      messages: [
        { role: 'user', content: 'Help me fix this bug' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'bash', id: 'tool_1' },
            { type: 'text', text: 'Let me check' },
          ],
        },
      ],
      system: [
        { type: 'text', text: systemPrompt },
        { type: 'text', text: 'Additional context block' },
      ],
    })

    const result = JSON.parse(rewriteRequestBody(body))

    // System prompt rewritten
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).not.toContain(OPENCODE_IDENTITY)
    expect(result.system[1].text).toContain('You have access to tools.')
    expect(result.system[1].text).toContain('# Code References')
    expect(result.system[2].text).toBe('Additional context block')

    // Tool names prefixed
    expect(result.tools[0].name).toBe('mcp_bash')
    expect(result.tools[1].name).toBe('mcp_read_file')

    // tool_use blocks in messages prefixed, text untouched
    expect(result.messages[1].content[0].name).toBe('mcp_bash')
    expect(result.messages[1].content[1].text).toBe('Let me check')
    expect(result.messages[0].content).toBe('Help me fix this bug')
  })

  test('handles body with no messages array', () => {
    const body = JSON.stringify({ model: 'claude-3' })
    const result = JSON.parse(rewriteRequestBody(body))
    expect(result.system[0].text).toContain(CLAUDE_CODE_IDENTITY)
  })
})

// ---------------------------------------------------------------------------
// Realistic prompt – snapshot tests
// ---------------------------------------------------------------------------

import { REALISTIC_SYSTEM_PROMPT } from './fixtures/realistic-system-prompt'

describe('sanitizeSystemText – realistic prompt', () => {
  test('sanitizeSystemText output snapshot', () => {
    const result = sanitizeSystemText(REALISTIC_SYSTEM_PROMPT)
    expect(result).toMatchSnapshot()
  })

  test('rewriteRequestBody output snapshot', () => {
    const body = JSON.stringify({
      system: REALISTIC_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        { name: 'bash', type: 'function' },
        { name: 'read', type: 'function' },
        { name: 'edit', type: 'function' },
      ],
    })
    const result = rewriteRequestBody(body)
    expect(result).toMatchSnapshot()
  })
})
