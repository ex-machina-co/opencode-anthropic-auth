import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import dedent from 'dedent'
import {
  CLAUDE_CODE_IDENTITY,
  CLAUDE_CODE_VERSION,
  OPENCODE_IDENTITY_PREFIX,
  REQUIRED_BETAS,
} from '../constants'
import {
  createStrippedStream,
  isInsecure,
  isTrustedAnthropicUrl,
  mergeBetaHeaders,
  mergeHeaders,
  prefixToolNames,
  prependClaudeCodeIdentity,
  rewriteRequestBody,
  rewriteUrl,
  sanitizeSystemText,
  setOAuthHeaders,
  stripToolPrefix,
  ToolNameAliasTable,
} from '../transform'

function shortAlias(name: string): string {
  return `mcp_T${Buffer.from(new TextEncoder().encode(name)).toString('base64url')}`
}

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
    expect(headers.get('user-agent')).toBe(
      `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    )
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
  test('preserves malformed tool and message entries without throwing', () => {
    const aliases = new ToolNameAliasTable()
    const body = {
      tools: [null, 'not-a-tool', {}, { name: 'valid' }],
      messages: [
        null,
        'not-a-message',
        {},
        { content: null },
        {
          content: [
            'not-a-block',
            null,
            {},
            { type: 'tool_use', name: 'valid' },
          ],
        },
      ],
    } as any

    let rewritten = ''
    expect(() => {
      rewritten = prefixToolNames(body, false, aliases)
    }).not.toThrow()
    const result = JSON.parse(rewritten)
    expect(result.tools.slice(0, 3)).toEqual([null, 'not-a-tool', {}])
    expect(result.tools[3].name).toBe(shortAlias('valid'))
    expect(result.messages.slice(0, 4)).toEqual([
      null,
      'not-a-message',
      {},
      { content: null },
    ])
    expect(result.messages[4].content.slice(0, 3)).toEqual([
      'not-a-block',
      null,
      {},
    ])
    expect(result.messages[4].content[3].name).toBe(shortAlias('valid'))
    aliases.dispose()
  })

  test('prefixes tool definition names', () => {
    const body = {
      tools: [
        { name: 'read_file', type: 'function' },
        { name: 'write_file', type: 'function' },
      ],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.tools[0].name).toBe(shortAlias('read_file'))
    expect(result.tools[1].name).toBe(shortAlias('write_file'))
  })

  test('prefixes tool_use block names in messages', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'bash', id: '1' },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.messages[0].content[0].name).toBe(shortAlias('bash'))
    expect(result.messages[0].content[1].type).toBe('text')
  })

  test('does not prefix non-tool_use blocks', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.messages[0].content[0]).toEqual({
      type: 'text',
      text: 'hello',
    })
  })

  test('handles missing tools and messages gracefully', () => {
    const body = { model: 'claude-3' }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.model).toBe('claude-3')
  })

  test('handles tools without names', () => {
    const body = {
      tools: [{ type: 'function' }],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.tools[0].name).toBeUndefined()
  })
})

describe('stripToolPrefix', () => {
  test('strips mcp_ prefix from tool names', () => {
    const text = `{"name": "${shortAlias('read_file')}"}`
    expect(stripToolPrefix(text)).toBe('{"name": "read_file"}')
  })

  test('strips multiple prefixed names', () => {
    const text = `{"name": "${shortAlias('tool_a')}"} and {"name": "${shortAlias('tool_b')}"}`
    const result = stripToolPrefix(text)
    expect(result).toContain('"name": "tool_a"')
    expect(result).toContain('"name": "tool_b"')
  })

  test('does not strip names without mcp_ prefix', () => {
    const text = '{"name": "regular_tool"}'
    expect(stripToolPrefix(text)).toBe(text)
  })

  test('handles whitespace variations in JSON', () => {
    const text = `{"name"  :  "${shortAlias('tool')}"}`
    expect(stripToolPrefix(text)).toBe('{"name": "tool"}')
  })
})

describe('rewriteUrl', () => {
  const originalEnv = process.env.ANTHROPIC_BASE_URL

  beforeEach(() => {
    delete process.env.ANTHROPIC_BASE_URL
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = originalEnv
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

  test('preserves an explicit beta query parameter', () => {
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

  test('uses the exact configured custom origin and preserves the API path', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080/base'
    const { input } = rewriteUrl(
      'https://api.anthropic.com/v1/messages?existing=yes',
    )
    const url = new URL(input.toString())
    expect(url.origin).toBe('http://localhost:8080')
    expect(url.pathname).toBe('/v1/messages')
    expect(url.searchParams.get('existing')).toBe('yes')
    expect(url.searchParams.get('beta')).toBe('true')
    expect(isTrustedAnthropicUrl(url)).toBe(true)
    expect(isTrustedAnthropicUrl('http://localhost:8081/v1/messages')).toBe(
      false,
    )
  })

  test.each([
    'not-a-url',
    'file:///etc/passwd',
    'http://user:pass@localhost:8080',
    'http://proxy.example.test',
  ])('ignores invalid custom endpoint %s', (configured) => {
    process.env.ANTHROPIC_BASE_URL = configured
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    expect(new URL(input.toString()).origin).toBe('https://api.anthropic.com')
  })

  test.each([
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://[::1]:8080',
    'https://proxy.example.test',
  ])('accepts a secure or loopback custom endpoint %s', (configured) => {
    process.env.ANTHROPIC_BASE_URL = configured
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe(new URL(configured).origin)
    expect(isTrustedAnthropicUrl(url)).toBe(true)
  })
})

describe('isTrustedAnthropicUrl', () => {
  test('accepts only the official HTTPS Anthropic API origin', () => {
    expect(isTrustedAnthropicUrl('https://api.anthropic.com/v1/messages')).toBe(
      true,
    )
    expect(
      isTrustedAnthropicUrl('https://api.anthropic.com:443/v1/messages'),
    ).toBe(true)
  })

  test.each([
    'http://api.anthropic.com/v1/messages',
    'https://api.anthropic.com.evil.test/v1/messages',
    'https://localhost/v1/messages',
    'http://127.0.0.1/v1/messages',
    'http://169.254.169.254/latest/meta-data',
    'https://[::1]/v1/messages',
    'https://user:pass@api.anthropic.com/v1/messages',
    'not-a-url',
  ])('rejects untrusted URL %s', (url) => {
    expect(isTrustedAnthropicUrl(url)).toBe(false)
  })
})

describe('isInsecure', () => {
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
  const originalInsecure = process.env.ANTHROPIC_INSECURE

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl
    if (originalInsecure === undefined) delete process.env.ANTHROPIC_INSECURE
    else process.env.ANTHROPIC_INSECURE = originalInsecure
  })

  test('requires both a custom endpoint and an explicit supported value', () => {
    delete process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_INSECURE = '1'
    expect(isInsecure()).toBe(false)

    process.env.ANTHROPIC_BASE_URL = 'https://proxy.local'
    expect(isInsecure()).toBe(true)
    process.env.ANTHROPIC_INSECURE = 'yes'
    expect(isInsecure()).toBe(false)
  })
})

describe('createStrippedStream', () => {
  test('strips tool prefixes from streamed response body', async () => {
    const chunks = [
      `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${shortAlias('bash')}"}}\n\n`,
      `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${shortAlias('read')}"}}\n\n`,
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

    const original = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const stripped = createStrippedStream(original)

    const text = await stripped.text()
    expect(text).toContain('"name":"bash"')
    expect(text).toContain('"name":"read"')
    expect(text).not.toContain(shortAlias('bash'))
    expect(text).not.toContain(shortAlias('read'))
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
      headers: {
        'content-type': 'text/event-stream',
        'x-custom': 'value',
      },
    })

    const stripped = createStrippedStream(original)
    expect(stripped.status).toBe(201)
    expect(stripped.headers.get('x-custom')).toBe('value')
  })

  test('strips a tool prefix split across arbitrary stream chunks', async () => {
    const chunks = [
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","na',
      `me":"${shortAlias('bash').slice(0, 4)}`,
      `${shortAlias('bash').slice(4, 8)}`,
      `${shortAlias('bash').slice(8)}"}}\n\n`,
    ]
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })

    const text = await createStrippedStream(
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    ).text()

    expect(text).toContain('"name":"bash"')
    expect(text).not.toContain('mcp_')
  })

  test('preserves unicode when every input byte is a separate chunk', async () => {
    const input = `data: {"type":"content_block_start","text":"Привет 👋","content_block":{"type":"tool_use","name":"${shortAlias('Read')}"}}\n\n`
    const bytes = new TextEncoder().encode(input)
    const stream = new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })

    const text = await createStrippedStream(
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    ).text()

    expect(text).toContain('Привет 👋')
    expect(text).toContain('"name":"Read"')
    expect(text).not.toContain('�')
  })

  test('drops stale content-length after rewriting the response body', () => {
    const original = new Response(
      `data: {"name":"${shortAlias('Read')}"}\n\n`,
      {
        headers: {
          'content-type': 'text/event-stream',
          'content-length': '999',
          'x-custom': 'value',
        },
      },
    )

    const stripped = createStrippedStream(original)

    expect(stripped.headers.get('content-length')).toBeNull()
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

  test('rewrites the "useful information about the environment" fingerprint', () => {
    // Anthropic's classifier matches this exact phrase as a third-party-agent
    // signal; leaving it intact produces a 400 invalid_request_error disguised
    // as "You're out of extra usage." The TEXT_REPLACEMENTS entry rewrites it
    // in place so the env-block context still reaches the model.
    const result = sanitizeSystemText(dedent`
      Here is some useful information about the environment you are running in:
      <env>
        Working directory: /tmp/project
      </env>
    `)
    expect(result).toMatchInlineSnapshot(`
      "Environment context you are running in:
      <env>
        Working directory: /tmp/project
      </env>"
    `)
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
        text: `${OPENCODE_IDENTITY_PREFIX}\nstuff\n\n# Code References\nrest`,
      },
      { type: 'text', text: 'other block' },
    ]
    const result = prependClaudeCodeIdentity(system)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result[1]?.text).not.toContain(OPENCODE_IDENTITY_PREFIX)
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

  test('does not emit empty text blocks after sanitization', () => {
    const result = prependClaudeCodeIdentity([
      '',
      'https://github.com/anomalyco/opencode',
      { type: 'text', text: '' },
      {
        type: 'text',
        text: 'kept',
        metadata: { source: 'test' },
        cache_control: { type: 'ephemeral' },
      },
    ])

    expect(result).toEqual([
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      {
        type: 'text',
        text: 'kept',
        metadata: { source: 'test' },
        cache_control: { type: 'ephemeral' },
      },
    ])
    expect(result.some((block) => block.text === '')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('[object Object]')
  })

  test('drops unsupported object and array system block types', () => {
    expect(
      prependClaudeCodeIdentity([
        { type: 'image', source: { type: 'base64', data: 'x' } },
        { type: 'tool_use', name: 'mcp_Read' },
        [],
      ]),
    ).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])

    expect(
      prependClaudeCodeIdentity({
        type: 'image',
        source: { type: 'base64', data: 'x' },
      }),
    ).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])
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
    expect(result.tools[0].name).toBe(shortAlias('bash'))
    // system[0] = billing header, system[1] = identity, system[2] = rest
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toBe('You are a helpful assistant.')
  })

  test('handles missing system field', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))
    // system[0] = billing header, system[1] = identity (no rest block)
    expect(result.system).toHaveLength(2)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('returns original string on invalid JSON', () => {
    const body = 'not valid json'
    expect(rewriteRequestBody(body)).toBe(body)
  })

  test('does not call onError when identity is present (rules always match)', () => {
    const onError = mock(() => {})
    const body = JSON.stringify({
      messages: [],
      system: `${OPENCODE_IDENTITY_PREFIX}\nsome other content`,
    })
    rewriteRequestBody(body)
    expect(onError).not.toHaveBeenCalled()
  })

  test('rewrites realistic OpenCode request end-to-end', () => {
    //  Input system prompt (array of blocks):
    //    [0] "You are OpenCode..." + generic content + "# Code References\n..."
    //    [1] "Additional context block"
    //
    //  Expected output (three-block layout):
    //    system[0] = billing header
    //    system[1] = identity
    //    system[2..n] = sanitized system blocks
    //    User messages are untouched.

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

    // Three-block layout: billing header, identity, sanitized blocks
    expect(result.system).toHaveLength(4)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toContain('You have access to tools.')
    expect(result.system[2].text).toContain('# Code References')
    expect(result.system[2].text).not.toContain(OPENCODE_IDENTITY_PREFIX)
    expect(result.system[3].text).toBe('Additional context block')

    // User messages are untouched
    expect(result.messages[0].content).toBe('Help me fix this bug')
    expect(result.messages[1].content[0].name).toBe(shortAlias('bash'))
  })

  test('handles body with no messages array', () => {
    const body = JSON.stringify({ model: 'claude-3' })
    const result = JSON.parse(rewriteRequestBody(body))
    // No messages → no billing header; system[0] = identity only
    expect(result.system).toHaveLength(1)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('keeps system blocks in system[] (string content)', () => {
    const body = JSON.stringify({
      system: 'Custom instructions for the assistant.',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    // system[0] = billing, system[1] = identity, system[2] = rest
    expect(result.system).toHaveLength(3)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toBe('Custom instructions for the assistant.')

    // User message is untouched
    expect(result.messages[0].content).toBe('hello')
  })

  test('keeps system blocks in system[] (array content)', () => {
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'Block A instructions' },
        { type: 'text', text: 'Block B instructions' },
      ],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    // system[0] = billing, system[1] = identity, system[2..3] = rest
    expect(result.system).toHaveLength(4)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toBe('Block A instructions')
    expect(result.system[3].text).toBe('Block B instructions')

    // User message is untouched
    expect(result.messages[0].content).toHaveLength(1)
    expect(result.messages[0].content[0].text).toBe('hello')
  })

  test('keeps system intact when no user messages exist', () => {
    const body = JSON.stringify({
      system: 'Some instructions',
      messages: [],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    // No user messages → no billing header; system[0] = identity, system[1] = rest
    expect(result.system).toHaveLength(2)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toBe('Some instructions')
  })

  test('keeps multiple system blocks as separate entries', () => {
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'First block' },
        { type: 'text', text: 'Second block' },
        { type: 'text', text: 'Third block' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    // system[0] = billing, system[1] = identity, system[2..4] = original blocks
    expect(result.system).toHaveLength(5)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toBe('First block')
    expect(result.system[3].text).toBe('Second block')
    expect(result.system[4].text).toBe('Third block')

    // User message is untouched
    expect(result.messages[0].content).toBe('hi')
  })

  test('omits empty and unsupported system blocks without object coercion', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        JSON.stringify({
          messages: [{ role: 'user', content: 'hi' }],
          system: [
            '',
            { type: 'text', text: 'https://opencode.ai/docs' },
            { type: 'text', text: '' },
            [],
            { type: 'image', source: { type: 'base64', data: 'x' } },
          ],
        }),
      ),
    )

    expect(result.system).toHaveLength(2)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(
      result.system.every((block: { text: string }) => block.text !== ''),
    ).toBe(true)
    expect(JSON.stringify(result)).not.toContain('[object Object]')
  })

  test('is byte-idempotent with one identity, billing block, and prefixed tools', () => {
    const body = JSON.stringify({
      tools: [{ name: 'bash', type: 'function' }],
      messages: [{ role: 'user', content: 'hello' }],
      system: 'Useful instructions',
    })

    const aliases = new ToolNameAliasTable()
    const once = rewriteRequestBody(body, undefined, aliases)
    const twice = rewriteRequestBody(once, undefined, aliases)
    const parsed = JSON.parse(twice)

    expect(twice).toBe(once)
    expect(
      parsed.system.filter(
        (block: { text: string }) => block.text === CLAUDE_CODE_IDENTITY,
      ),
    ).toHaveLength(1)
    expect(
      parsed.system.filter((block: { text: string }) =>
        block.text.includes('x-anthropic-billing-header'),
      ),
    ).toHaveLength(1)
    expect(parsed.tools[0].name).toBe(shortAlias('bash'))
    aliases.dispose()
  })

  test('preserves native mixed tool names while making the rewrite idempotent', () => {
    const body = JSON.stringify({
      tools: [{ name: 'mcp_Bash' }, { name: 'bash' }],
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'mcp_Bash', id: 'native-1' },
            { type: 'tool_use', name: 'bash', id: 'native-2' },
          ],
        },
      ],
    })

    const aliases = new ToolNameAliasTable()
    const once = JSON.parse(rewriteRequestBody(body, undefined, aliases))
    const twiceText = rewriteRequestBody(
      JSON.stringify(once),
      undefined,
      aliases,
    )

    expect(once.tools.map((tool: { name: string }) => tool.name)).toEqual([
      shortAlias('mcp_Bash'),
      shortAlias('bash'),
    ])
    expect(
      once.messages[1].content.map((block: { name: string }) => block.name),
    ).toEqual([shortAlias('mcp_Bash'), shortAlias('bash')])
    expect(
      JSON.parse(stripToolPrefix(JSON.stringify(once), aliases)).tools.map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(['mcp_Bash', 'bash'])
    expect(twiceText).toBe(JSON.stringify(once))
    aliases.dispose()
  })

  test('normalizes rewritten-looking system blocks and already-prefixed tools', () => {
    const body = JSON.stringify({
      tools: [{ name: 'mcp_Bash' }],
      messages: [{ role: 'user', content: 'hello' }],
      system: [
        { type: 'text', text: CLAUDE_CODE_IDENTITY },
        { type: 'text', text: 'x-anthropic-billing-header: stale' },
        { type: 'text', text: 'Meaningful instructions' },
        { type: 'text', text: 'x-anthropic-billing-header: duplicate' },
        { type: 'text', text: CLAUDE_CODE_IDENTITY },
      ],
    })

    const aliases = new ToolNameAliasTable()
    const onceText = rewriteRequestBody(body, undefined, aliases)
    const once = JSON.parse(onceText)
    const twiceText = rewriteRequestBody(onceText, undefined, aliases)

    expect(once.system).toHaveLength(3)
    expect(once.system[0].text).toBe(
      'x-anthropic-billing-header: cc_version=2.1.258.59d; cc_entrypoint=sdk-cli; cch=2cf24;',
    )
    expect(once.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(once.system[2].text).toBe('Meaningful instructions')
    expect(once.tools[0].name).toBe('mcp_Bash')
    expect(JSON.parse(stripToolPrefix(onceText, aliases)).tools[0].name).toBe(
      'mcp_Bash',
    )
    expect(twiceText).toBe(onceText)
    aliases.dispose()
  })

  test('is byte-idempotent when there are no users or tools', () => {
    const body = JSON.stringify({ system: 'Only instructions', messages: [] })
    const once = rewriteRequestBody(body)
    const twice = rewriteRequestBody(once)

    expect(twice).toBe(once)
    expect(JSON.parse(twice).system).toEqual([
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: 'Only instructions' },
    ])
    expect(twice).not.toContain('x-anthropic-billing-header')
    expect(twice).not.toContain('mcp_')
  })
})

describe('reported Claude Code version', () => {
  test('uses the bundled version in both header and billing metadata', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'token')
    expect(headers.get('user-agent')).toBe(
      `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    )
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hello world test message' }],
    })
    const billingHeader = JSON.parse(rewriteRequestBody(body)).system[0].text
    expect(billingHeader).toContain(`cc_version=${CLAUDE_CODE_VERSION}.`)
  })

  test('uses one explicit version in both header and billing metadata', () => {
    const version = '2.9.99'
    const headers = new Headers()
    setOAuthHeaders(headers, 'token', version)
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hello world test message' }],
    })
    const billingHeader = JSON.parse(rewriteRequestBody(body, version))
      .system[0].text
    expect(headers.get('user-agent')).toBe(
      `claude-cli/${version} (external, cli)`,
    )
    expect(billingHeader).toContain(`cc_version=${version}.`)
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
    expect(JSON.parse(result)).toMatchSnapshot()
  })
})
