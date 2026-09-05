import { describe, expect, spyOn, test } from 'bun:test'
import {
  MAX_JSON_DEPTH,
  MAX_JSON_NUMBER_BYTES,
  MAX_JSON_OBJECT_KEYS,
  MAX_JSON_PENDING_BLOCK_BYTES,
  MAX_JSON_RETAINED_KEY_BYTES,
  MAX_JSON_STRING_BYTES,
} from '../json-response-stream'
import {
  createStrippedStream,
  MAX_JSON_TOOL_NAME_BYTES,
  MAX_SSE_EVENT_BYTES,
  MAX_SSE_LINE_BYTES,
  prefixToolNames,
  stripToolPrefix,
  ToolNameAliasTable,
} from '../transform'

const encoder = new TextEncoder()

function shortAlias(name: string): string {
  return `mcp_T${Buffer.from(encoder.encode(name)).toString('base64url')}`
}

const READ_ALIAS = shortAlias('Read')
const WRITE_ALIAS = shortAlias('Write')
const SHELL_ALIAS = shortAlias('Shell')

function streamOf(
  chunks: Array<string | Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
        )
      }
      controller.close()
    },
  })
}

function sseResponse(
  chunks: Array<string | Uint8Array>,
  headers: Record<string, string> = {},
): Response {
  return new Response(streamOf(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

function everyByte(text: string): Uint8Array[] {
  const bytes = encoder.encode(text)
  return Array.from(bytes, (byte) => Uint8Array.of(byte))
}

async function readText(response: Response): Promise<string> {
  return await new Response(response.body).text()
}

const TOOL_EVENT =
  'event: content_block_start\n' +
  'data: {"type":"content_block_start","index":0,' +
  `"content_block":{"type":"tool_use","id":"toolu_1","name":"${READ_ALIAS}","input":{}}}\n\n`

const EXPECTED = TOOL_EVENT.replace(`"name":"${READ_ALIAS}"`, '"name":"Read"')

describe('createStrippedStream - chunk boundaries', () => {
  test('strips the prefix at every possible two-chunk split point', async () => {
    for (let index = 1; index < TOOL_EVENT.length; index++) {
      const chunks = [TOOL_EVENT.slice(0, index), TOOL_EVENT.slice(index)]
      expect(await readText(createStrippedStream(sseResponse(chunks)))).toBe(
        EXPECTED,
      )
    }
  })

  test('strips a prefix delivered one byte per chunk', async () => {
    const bytes = Array.from(
      encoder.encode(TOOL_EVENT),
      (byte) => new Uint8Array([byte]),
    )
    expect(await readText(createStrippedStream(sseResponse(bytes)))).toBe(
      EXPECTED,
    )
  })

  test('tolerates interleaved empty chunks', async () => {
    const chunks = ['', TOOL_EVENT.slice(0, 20), '', TOOL_EVENT.slice(20), '']
    expect(await readText(createStrippedStream(sseResponse(chunks)))).toBe(
      EXPECTED,
    )
  })

  test('preserves a 4-byte emoji split across chunks', async () => {
    const payload =
      'data: {"type":"content_block_delta","delta":{"text":"\u{1F680} ok"}}\n\n'
    const bytes = encoder.encode(payload)
    const cut = bytes.indexOf(0xf0) + 2
    const output = await readText(
      createStrippedStream(
        sseResponse([bytes.slice(0, cut), bytes.slice(cut)]),
      ),
    )
    expect(output).toBe(payload)
  })

  test('rejects dangling malformed JSON-looking data at end of stream', async () => {
    const partial = 'data: {"name":"mcp'
    await expect(
      readText(createStrippedStream(sseResponse([partial]))),
    ).rejects.toThrow('Malformed or truncated Anthropic response JSON')
  })
})

describe('createStrippedStream - correctness guards', () => {
  test('handles CR-only SSE line endings', async () => {
    const payload = `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${READ_ALIAS}"}}\r\r`
    const expected =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"Read"}}\r\r'
    const chunks = payload.split('')

    expect(await readText(createStrippedStream(sseResponse(chunks)))).toBe(
      expected,
    )
  })

  test('preserves CRLF endings split across chunks', async () => {
    const expected =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"Read"}}\r\n\r\n'
    const chunks = [
      `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${READ_ALIAS.slice(0, 4)}`,
      `${READ_ALIAS.slice(4)}"}}\r`,
      '\n\r',
      '\n',
    ]

    expect(await readText(createStrippedStream(sseResponse(chunks)))).toBe(
      expected,
    )
  })

  test('rejects a newline-free SSE line above the buffer limit', async () => {
    const oversized = `data: ${'x'.repeat(MAX_SSE_LINE_BYTES)}`
    const response = createStrippedStream(sseResponse([oversized]))

    await expect(readText(response)).rejects.toThrow(
      `SSE line exceeds ${MAX_SSE_LINE_BYTES} byte limit`,
    )
  })

  test('rejects an oversized line ending in the same chunk', async () => {
    const oversized = `${'x'.repeat(MAX_SSE_LINE_BYTES + 1)}\n`
    const response = createStrippedStream(sseResponse([oversized]))

    await expect(readText(response)).rejects.toThrow(
      `SSE line exceeds ${MAX_SSE_LINE_BYTES} byte limit`,
    )
  })

  test('accepts a large chunk containing many bounded lines', async () => {
    const line = 'data: x\n'
    const payload = line.repeat(Math.ceil(MAX_SSE_LINE_BYTES / line.length))

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      payload,
    )
  })

  test('accepts a line exactly at the buffer limit', async () => {
    const payload = 'x'.repeat(MAX_SSE_LINE_BYTES)

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      payload,
    )
  })

  test('enforces the byte limit for multi-byte UTF-8 input', async () => {
    const payload = '🚀'.repeat(Math.floor(MAX_SSE_LINE_BYTES / 4) + 1)
    const response = createStrippedStream(sseResponse([payload]))

    await expect(readText(response)).rejects.toThrow(
      `SSE line exceeds ${MAX_SSE_LINE_BYTES} byte limit`,
    )
  })

  test('accepts an event exactly at MAX_SSE_EVENT_BYTES without a candidate', async () => {
    const prefix = 'data: '
    const firstLine = `${prefix}${'x'.repeat(MAX_SSE_LINE_BYTES - prefix.length)}\n`
    const secondContentLength =
      MAX_SSE_EVENT_BYTES - firstLine.length - prefix.length - 2
    const payload = `${firstLine + prefix + 'x'.repeat(secondContentLength)}\n\n`

    expect(encoder.encode(payload).byteLength).toBe(MAX_SSE_EVENT_BYTES)
    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      payload,
    )
  })

  test('rejects an event one byte over MAX_SSE_EVENT_BYTES', async () => {
    const regularLine = 'data: x\n'
    const payload = regularLine.repeat(
      Math.ceil((MAX_SSE_EVENT_BYTES + 1) / regularLine.length),
    )
    const overLimit = `${payload.slice(0, -1)}x\n\n`

    expect(encoder.encode(overLimit).byteLength).toBeGreaterThan(
      MAX_SSE_EVENT_BYTES,
    )
    await expect(
      readText(createStrippedStream(sseResponse([overLimit]))),
    ).rejects.toThrow()
  })

  test('keeps the SSE line limit independent from the event limit', async () => {
    const payload = `${'x'.repeat(MAX_SSE_LINE_BYTES + 1)}\n\n`
    expect(encoder.encode(payload).byteLength).toBeLessThan(MAX_SSE_EVENT_BYTES)
    await expect(
      readText(createStrippedStream(sseResponse([payload]))),
    ).rejects.toThrow(`SSE line exceeds ${MAX_SSE_LINE_BYTES} byte limit`)
  })

  test('is a no-op for a stream with no prefixed names', async () => {
    const payload = 'data: {"type":"message_stop"}\n\ndata: [DONE]\n\n'
    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      payload,
    )
  })

  test('does not attempt a whole-document parse for an SSE event batch', async () => {
    const payload =
      'event: content_block_start\n' +
      `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${READ_ALIAS}"}}\n\n`
    const parse = spyOn(JSON, 'parse')

    try {
      const output = await readText(
        createStrippedStream(sseResponse([payload])),
      )

      expect(output).toBe(payload.replace(`"${READ_ALIAS}"`, '"Read"'))
      expect(parse.mock.calls.some(([input]) => input === payload)).toBe(false)
    } finally {
      parse.mockRestore()
    }
  })

  test('strips several tool names in a single chunk', async () => {
    const payload = [READ_ALIAS, WRITE_ALIAS, SHELL_ALIAS]
      .map(
        (name) =>
          `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${name}"}}\n\n`,
      )
      .join('')
    const expected = ['Read', 'Write', 'Shell']
      .map(
        (name) =>
          `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${name}"}}\n\n`,
      )
      .join('')
    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      expected,
    )
  })

  test('rejects a decoded oversized name spanning many chunks', async () => {
    const payload = `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_${'\\u0061'.repeat(61)}"}}\n\n`
    const chunks = payload.match(/.{1,7}/gs) ?? []
    await expect(
      readText(createStrippedStream(sseResponse(chunks))),
    ).rejects.toThrow(
      `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`,
    )
  })

  test('rejects an oversized decoded message tool name spanning chunks', async () => {
    const payload = `data: {"type":"message","content":[{"type":"tool_use","name":"mcp_${'\\u00e9'.repeat(31)}"}]}\n\n`
    const chunks = payload.match(/.{1,7}/gs) ?? []

    await expect(
      readText(createStrippedStream(sseResponse(chunks))),
    ).rejects.toThrow(
      `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`,
    )
  })

  test.each([
    ['high', '\\ud800'],
    ['low', '\\udfff'],
  ])('rejects an escaped lone %s surrogate in an SSE tool name', async (_, escaped) => {
    const payload = `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_${escaped}","metadata":{"name":"mcp_Metadata"}}}\n\n`
    const chunks = payload.match(/.{1,5}/gs) ?? []

    await expect(
      readText(createStrippedStream(sseResponse(chunks))),
    ).rejects.toThrow('Tool names must contain well-formed UTF-16')
  })

  test('preserves an escaped astral surrogate pair in an unknown SSE alias', async () => {
    const payload = `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_\\ud83d\\ude00","metadata":{"name":"mcp_Metadata"}},"metadata":{"name":"mcp_Top"}}\n\n`
    const chunks = payload.match(/.{1,5}/gs) ?? []

    expect(await readText(createStrippedStream(sseResponse(chunks)))).toBe(
      payload,
    )
  })

  test('normalises whitespace variants of the name field', () => {
    expect(stripToolPrefix(`{"name"  :  "${READ_ALIAS}"}`)).toBe(
      '{"name": "Read"}',
    )
  })

  test('decodes a known StructuredOutput alias', () => {
    expect(
      stripToolPrefix(`{"name":"${shortAlias('StructuredOutput')}"}`),
    ).toBe('{"name": "StructuredOutput"}')
  })

  test('does not rewrite unrelated name fields in SSE JSON', async () => {
    const payload =
      'data: {"type":"message_delta","metadata":{"name":"mcp_Read"}}\n\n'

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      payload,
    )
  })

  test('rewrites only tool_use.name when unrelated names share the prefix', async () => {
    const payload = `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${READ_ALIAS}","metadata":{"name":"mcp_Nested"}},"metadata":{"name":"mcp_Top"}}\n\n`
    const output = await readText(createStrippedStream(sseResponse([payload])))
    const value = JSON.parse(output.slice('data: '.length).trim())

    expect(value.content_block.name).toBe('Read')
    expect(value.content_block.metadata.name).toBe('mcp_Nested')
    expect(value.metadata.name).toBe('mcp_Top')
  })

  test('does not rewrite a fake tool_use object inside tool input', async () => {
    const payload = `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${READ_ALIAS}","input":{"payload":{"type":"tool_use","name":"mcp_NotATool"}}}}\n\n`
    const expected = payload.replace(`"name":"${READ_ALIAS}"`, '"name":"Read"')

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      expected,
    )
  })

  test.each([
    '\n',
    '\r',
    '\r\n',
  ])('combines multiline SSE data using %j semantics and rewrites pretty JSON', async (lineEnding) => {
    const pretty = JSON.stringify(
      {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: READ_ALIAS, input: {} },
      },
      null,
      2,
    )
    const dataLines = pretty.split('\n')
    const event =
      [
        'id: event-1',
        ': before',
        ...dataLines.map((line) => `data: ${line}`),
        ': between',
        'retry: 1000',
        ': after',
        '',
      ].join(lineEnding) + lineEnding
    const rewrittenPayload = JSON.stringify({
      type: 'content_block_start',
      content_block: { type: 'tool_use', name: 'Read', input: {} },
    })
    const expected =
      [
        'id: event-1',
        ': before',
        `data: ${rewrittenPayload}`,
        ': between',
        'retry: 1000',
        ': after',
        '',
      ].join(lineEnding) + lineEnding

    const output = await readText(
      createStrippedStream(sseResponse(everyByte(event))),
    )
    expect(output).toBe(expected)
    const logicalData = output
      .split(/\r\n|\r|\n/)
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n')
    expect(JSON.parse(logicalData).content_block.name).toBe('Read')
  })

  test('leaves a malformed multiline non-JSON SSE event byte-identical', async () => {
    const payload =
      'event: text\n' +
      ': comment before\n' +
      'data: not-json\n' +
      ': comment between\n' +
      'data: still-not-json\n' +
      ': comment after\n\n'

    expect(
      await readText(createStrippedStream(sseResponse(everyByte(payload)))),
    ).toBe(payload)
  })

  test.each([
    `{"type":"content_block_start","content_block":{"name":"${READ_ALIAS}","type":"text"}}`,
    `{"type":"content_block_start","content_block":{"type":"text","name":"${READ_ALIAS}"}}`,
    `{"type":"message","content":[{"name":"${READ_ALIAS}","type":"text"}]}`,
    `{"type":"message","content":[{"type":"text","name":"${READ_ALIAS}"}]}`,
  ])('leaves text-only SSE tool-shaped JSON byte-identical: %s', async (json) => {
    const payload = `data: ${json}\n\n`
    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      payload,
    )
  })

  test.each([
    `{"type":"message","content_block":{"type":"tool_use","name":"${READ_ALIAS}"}}`,
    `{"type":"content_block_start","content":[{"type":"tool_use","name":"${READ_ALIAS}"}]}`,
  ])('ignores an SSE candidate under the wrong root type: %s', async (json) => {
    const payload = `data: ${json}\n\n`
    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      payload,
    )
  })

  test('leaves raw JSON SSE events without data byte-identical', async () => {
    const payload =
      `event: content_block_start\n` +
      `{"type":"content_block_start","content_block":{"type":"tool_use","name":"${READ_ALIAS}"}}\n\n`

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      payload,
    )
  })

  test('leaves comments and non-data-only SSE events byte-identical', async () => {
    const payload =
      ': mcp_Read\n' +
      'event: ping\n' +
      'id: 42\n' +
      'retry: 100\n\n' +
      ': another comment\n\n'

    expect(
      await readText(createStrippedStream(sseResponse(everyByte(payload)))),
    ).toBe(payload)
  })

  test.each([
    '{not-json}',
    '[not-json]',
    '{"name":"mcp_Read"',
    '["mcp_Read"',
  ])('rejects malformed JSON-looking SSE data: %s', async (json) => {
    await expect(
      readText(createStrippedStream(sseResponse([`data: ${json}\n\n`]))),
    ).rejects.toThrow()
  })

  test('leaves malformed non-JSON plain SSE data byte-identical', async () => {
    const payload =
      'data: not-json mcp_Read\n' + 'data: still plain text [broken\n\n'

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      payload,
    )
  })

  test('preserves whitespace and JSON escapes outside the name token', async () => {
    const payload = `data: { "type" : "content_block_start", "content_block" : { "type" : "tool_use", "name" : "${READ_ALIAS}", "text" : "\\u0061", "input" : { "spaced" : true } } }\n\n`
    const expected = payload.replace(`"${READ_ALIAS}"`, '"Read"')

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      expected,
    )
  })

  test('rejects duplicate name keys instead of rewriting the effective value', async () => {
    const payload = `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Decoy","name":"${READ_ALIAS}","input":{}}}\n\n`
    await expect(
      readText(createStrippedStream(sseResponse([payload]))),
    ).rejects.toThrow()
  })

  test('rewrites tool blocks only in a complete message content array', async () => {
    const payload = `data: { "type" : "message", "content" : [{"type":"text","text":"mcp_Read"},{"type":"tool_use","name":"${READ_ALIAS}","input":{}}] }\n\n`
    const expected = payload.replace(`"name":"${READ_ALIAS}"`, '"name":"Read"')

    expect(await readText(createStrippedStream(sseResponse([payload])))).toBe(
      expected,
    )
  })

  test('rejects response JSON above the traversal depth limit', async () => {
    let input: Record<string, unknown> = {}
    for (let depth = 0; depth < 258; depth++) input = { nested: input }
    const value = {
      type: 'content_block_start',
      content_block: { type: 'tool_use', name: READ_ALIAS, input },
    }
    const response = createStrippedStream(
      sseResponse([`data: ${JSON.stringify(value)}\n\n`]),
    )

    await expect(readText(response)).rejects.toThrow(
      'Anthropic response JSON exceeds traversal limits',
    )
  })

  test('rejects malformed UTF-8 instead of inserting replacement text', async () => {
    const malformed = Uint8Array.of(
      ...encoder.encode('data: {"type":"text","text":"'),
      0xc3,
      0x28,
      ...encoder.encode('"}\n\n'),
    )

    await expect(
      readText(createStrippedStream(sseResponse([malformed]))),
    ).rejects.toBeInstanceOf(TypeError)
  })

  test('bounds decoded tool names while preserving unknown bounded aliases', async () => {
    const unknown = `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_${'a'.repeat(60)}"}}\n\n`
    expect(await readText(createStrippedStream(sseResponse([unknown])))).toBe(
      unknown,
    )
  })
})

describe('createStrippedStream - transport semantics', () => {
  test('returns every non-2xx JSON and SSE response unchanged', async () => {
    const cases = [
      { status: 400, mediaType: 'application/json', body: '' },
      { status: 503, mediaType: 'application/json', body: 'not-json' },
      {
        status: 400,
        mediaType: 'text/event-stream',
        body: 'data: {"name":"mcp_Read"}\n\n',
      },
    ]

    for (const { status, mediaType, body } of cases) {
      const original = new Response(body, {
        status,
        statusText: 'Bad Request',
        headers: {
          'content-type': mediaType,
          'content-length': String(new TextEncoder().encode(body).byteLength),
          'content-encoding': 'gzip',
          etag: '"upstream"',
          'x-request-id': 'req-error',
        },
      })

      const result = createStrippedStream(original)

      expect(result).toBe(original)
      expect(result.status).toBe(status)
      expect(result.statusText).toBe('Bad Request')
      expect(await result.text()).toBe(body)
      expect(result.headers.get('content-type')).toBe(mediaType)
      expect(result.headers.get('content-length')).toBe(
        String(new TextEncoder().encode(body).byteLength),
      )
      expect(result.headers.get('content-encoding')).toBe('gzip')
      expect(result.headers.get('etag')).toBe('"upstream"')
      expect(result.headers.get('x-request-id')).toBe('req-error')
    }
  })

  test('returns an oversized non-JSON response unchanged', async () => {
    const body = new Uint8Array(MAX_SSE_LINE_BYTES + 1).fill(0x78)
    const original = new Response(body, {
      status: 502,
      headers: { 'content-type': 'application/octet-stream' },
    })

    const result = createStrippedStream(original)

    expect(result).toBe(original)
    expect((await result.arrayBuffer()).byteLength).toBe(body.byteLength)
  })

  test('strips tool prefixes from a non-streaming JSON response', async () => {
    const payload = `{"type":"message","content":[{"type":"tool_use","name":"${READ_ALIAS}","input":{}}]}`
    const response = createStrippedStream(
      new Response(payload, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    )

    expect(await readText(response)).toContain('"name":"Read"')
    expect(response.headers.has('content-length')).toBe(false)
  })

  test('rejects malformed JSON', async () => {
    const body = new TextEncoder().encode('not-json')
    const response = createStrippedStream(
      new Response(streamOf([body]), {
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(response.arrayBuffer()).rejects.toThrow()
  })

  test('bounds buffered JSON between emitted tokens', async () => {
    const payload = `{"value":1 ${' '.repeat(MAX_JSON_STRING_BYTES + 4096)}`
    const response = createStrippedStream(
      new Response(streamOf([payload]), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(readText(response)).rejects.toThrow(
      'Anthropic response JSON exceeds bounded token buffer',
    )
  })

  test('rejects invalid UTF-8 JSON', async () => {
    const body = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])
    const response = createStrippedStream(
      new Response(streamOf([body]), {
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(response.arrayBuffer()).rejects.toThrow()
  })

  test('rejects a UTF-8 BOM split across chunks', async () => {
    const payload = encoder.encode(
      `{"type":"message","content":[{"type":"tool_use","name":"${READ_ALIAS}"}]}`,
    )
    const response = createStrippedStream(
      new Response(
        streamOf([
          Uint8Array.of(0xef),
          Uint8Array.of(0xbb),
          Uint8Array.of(0xbf),
          payload,
        ]),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
    await expect(response.arrayBuffer()).rejects.toThrow(
      'UTF-8 BOM is not accepted',
    )
  })

  test('rejects a UTF-8 BOM before an SSE JSON object', async () => {
    const payload = `data: \uFEFF{"type":"message"}\n\n`

    await expect(
      readText(createStrippedStream(sseResponse([payload]))),
    ).rejects.toThrow()
  })

  test('strips stale representation headers after JSON transformation', async () => {
    const response = createStrippedStream(
      new Response(
        `{"type":"message","content":[{"type":"tool_use","name":"${READ_ALIAS}"}]}`,
        {
          headers: {
            'content-digest': 'sha-256=:stale:',
            'content-encoding': 'gzip',
            'content-md5': 'stale',
            'content-range': 'bytes 0-9/10',
            digest: 'sha-256=stale',
            etag: '"stale"',
            'content-type': 'application/problem+json',
          },
        },
      ),
    )

    expect(await readText(response)).toContain('"name":"Read"')
    for (const name of [
      'content-digest',
      'content-encoding',
      'content-length',
      'content-md5',
      'content-range',
      'digest',
      'etag',
    ]) {
      expect(response.headers.has(name)).toBe(false)
    }
  })

  test('accepts event-stream media type parameters case-insensitively', async () => {
    const response = createStrippedStream(
      sseResponse([TOOL_EVENT], {
        'content-type': 'Text/Event-Stream; charset=utf-8',
      }),
    )

    expect(await readText(response)).toBe(EXPECTED)
  })

  test('preserves status, statusText and passthrough headers', () => {
    const response = createStrippedStream(
      new Response(streamOf([TOOL_EVENT]), {
        status: 207,
        statusText: 'Multi-Status',
        headers: {
          'content-type': 'text/event-stream',
          'x-request-id': 'req_1',
        },
      }),
    )
    expect(response.status).toBe(207)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('x-request-id')).toBe('req_1')
  })

  test('drops content-length because the body length changes', () => {
    const response = createStrippedStream(
      sseResponse([TOOL_EVENT], {
        'content-length': String(TOOL_EVENT.length),
      }),
    )
    expect(response.headers.get('content-length')).toBeNull()
  })

  test('strips stale representation headers from transformed SSE', () => {
    const response = createStrippedStream(
      sseResponse([TOOL_EVENT], {
        'content-encoding': 'gzip',
        etag: '"stale"',
      }),
    )

    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('etag')).toBeNull()
  })

  test('propagates an upstream stream error instead of truncating silently', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"name":"mcp_Re'))
        controller.error(new Error('upstream boom'))
      },
    })
    const response = createStrippedStream(
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    await expect(readText(response)).rejects.toThrow('upstream boom')
  })
})

describe('createStrippedStream - finalization lifecycle', () => {
  test('finalizes exactly once after transformed JSON normal completion', async () => {
    let finalizations = 0
    const response = createStrippedStream(
      new Response(
        `{"type":"message","content":[{"type":"tool_use","name":"${READ_ALIAS}"}]}`,
        { headers: { 'content-type': 'application/json' } },
      ),
      new ToolNameAliasTable(),
      () => {
        finalizations += 1
      },
    )

    const body = JSON.parse(await response.text())

    expect(body.content[0].name).toBe('Read')
    expect(finalizations).toBe(1)
  })

  test('finalizes exactly once after transformed SSE consumer cancellation', async () => {
    let finalizations = 0
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(TOOL_EVENT))
      },
      cancel() {},
    })
    const response = createStrippedStream(
      new Response(source, {
        headers: { 'content-type': 'text/event-stream' },
      }),
      new ToolNameAliasTable(),
      () => {
        finalizations += 1
      },
    )

    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()

    expect(finalizations).toBe(1)
  })

  test('finalizes exactly once after transformed JSON upstream error', async () => {
    let finalizations = 0
    const failure = new Error('upstream JSON failed')
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure)
      },
    })
    const response = createStrippedStream(
      new Response(source, {
        headers: { 'content-type': 'application/json' },
      }),
      new ToolNameAliasTable(),
      () => {
        finalizations += 1
      },
    )

    await expect(response.arrayBuffer()).rejects.toBe(failure)

    expect(finalizations).toBe(1)
  })

  test('finalizes immediately exactly once when the response is unchanged', () => {
    for (const response of [
      new Response('error', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
      new Response('binary', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    ]) {
      let finalizations = 0

      const result = createStrippedStream(
        response,
        new ToolNameAliasTable(),
        () => {
          finalizations += 1
        },
      )

      expect(result).toBe(response)
      expect(finalizations).toBe(1)
    }
  })
})

describe('prefix round-trip', () => {
  test('stripToolPrefix reverses prefixToolNames for tool names', () => {
    const aliases = new ToolNameAliasTable()
    const body = {
      tools: [{ name: 'read' }, { name: 'write' }],
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'shell', input: {} }],
        },
      ],
    }
    const prefixed = prefixToolNames(structuredClone(body), false, aliases)
    expect(JSON.parse(stripToolPrefix(prefixed, aliases))).toEqual(body)
    aliases.dispose()
  })

  test('restores the original case for PascalCase tool names', () => {
    const aliases = new ToolNameAliasTable()
    const body = { tools: [{ name: 'Read' }] }
    const prefixed = prefixToolNames(structuredClone(body), false, aliases)
    expect(JSON.parse(stripToolPrefix(prefixed, aliases))).toEqual(body)
    aliases.dispose()
  })
})

describe('createStrippedStream - cancellation', () => {
  test('forwards consumer cancellation to the upstream stream', async () => {
    let cancelled = false
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(TOOL_EVENT))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = createStrippedStream(
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelled).toBe(true)
  })

  test('buffers a chunk without a newline until flush', async () => {
    const output = await readText(
      createStrippedStream(
        sseResponse([
          `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${READ_ALIAS}"}}`,
        ]),
      ),
    )
    expect(output).toBe(
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"Read"}}',
    )
  })
})

describe('bounded structured JSON responses', () => {
  const aliases = new ToolNameAliasTable()
  const jsonResponse = (
    body: string | Uint8Array | ReadableStream<Uint8Array>,
  ) =>
    createStrippedStream(
      new Response(body, { headers: { 'content-type': 'application/json' } }),
      aliases,
    )

  test('rewrites a tool name at every byte split', async () => {
    const payload = `{ "type" : "message", "content" : [{"type":"tool_use","name":"${READ_ALIAS}","input":{}}] }`
    const expected = payload.replace(`"${READ_ALIAS}"`, '"Read"')
    const bytes = encoder.encode(payload)
    for (let split = 1; split < bytes.byteLength; split += 1) {
      expect(
        await readText(
          jsonResponse(streamOf([bytes.slice(0, split), bytes.slice(split)])),
        ),
      ).toBe(expected)
    }
  })

  test('preserves unrelated paths and decodes candidate escapes', async () => {
    const payload = `{"type":"message","metadata":{"name":"mcp_Top"},"content":[{"type":"tool_use","name":"${READ_ALIAS}","input":{"name":"mcp_Nested","escaped":"\\u0061"}}]}`
    const output = await readText(jsonResponse(payload))
    expect(output).toBe(payload.replace(`"${READ_ALIAS}"`, '"Read"'))
  })

  test.each([
    [
      'content_block name before text type',
      `{"type":"content_block_start","content_block":{"name":"${READ_ALIAS}","type":"text"}}`,
    ],
    [
      'content_block text type before name',
      `{"type":"content_block_start","content_block":{"type":"text","name":"${READ_ALIAS}"}}`,
    ],
    [
      'message content name before text type',
      `{"type":"message","content":[{"name":"${READ_ALIAS}","type":"text"}]}`,
    ],
    [
      'message content text type before name',
      `{"type":"message","content":[{"type":"text","name":"${READ_ALIAS}"}]}`,
    ],
  ])('leaves %s byte-identical', async (_, payload) => {
    expect(await readText(jsonResponse(payload))).toBe(payload)
  })

  test.each([
    [
      'content_block under message root',
      `{"type":"message","content_block":{"type":"tool_use","name":"${READ_ALIAS}"}}`,
    ],
    [
      'message content under content_block_start root',
      `{"type":"content_block_start","content":[{"type":"tool_use","name":"${READ_ALIAS}"}]}`,
    ],
  ])('ignores %s', async (_, payload) => {
    expect(await readText(jsonResponse(payload))).toBe(payload)
  })

  test('accepts relevant root and block key permutations and rewrites names', async () => {
    const rootPermutations = [
      `{"content":[{"type":"tool_use","name":"${READ_ALIAS}"}],"type":"message"}`,
      `{"content_block":{"name":"${READ_ALIAS}","type":"tool_use"},"type":"content_block_start"}`,
      `{"type":"message","content":[{"name":"${READ_ALIAS}","type":"tool_use"}]}`,
    ]

    for (const payload of rootPermutations) {
      const output = await readText(jsonResponse(payload))
      expect(output).toContain('"name":"Read"')
      expect(JSON.parse(output)).toBeDefined()
    }
  })

  test.each([
    ['root type', `{"type":"message","type":"message"}`],
    ['root content', `{"type":"message","content":[],"content":[]}`],
    [
      'root content_block',
      `{"type":"content_block_start","content_block":{},"content_block":{}}`,
    ],
    [
      'block type',
      `{"type":"message","content":[{"type":"tool_use","type":"tool_use","name":"${READ_ALIAS}"}]}`,
    ],
    [
      'block name',
      `{"type":"message","content":[{"type":"tool_use","name":"mcp_Decoy","name":"${READ_ALIAS}"}]}`,
    ],
    [
      'unrelated nested key',
      `{"type":"message","content":[{"type":"tool_use","name":"${READ_ALIAS}","metadata":{"x":1,"x":2}}]}`,
    ],
    [
      'escaped-equivalent name keys',
      `{"type":"message","content":[{"type":"tool_use","\\u006eame":"mcp_Decoy","name":"${READ_ALIAS}"}]}`,
    ],
  ])('rejects duplicate %s keys', async (_, payload) => {
    await expect(readText(jsonResponse(payload))).rejects.toThrow()
  })

  test('does not include duplicate object-key content in parser errors', async () => {
    const untrustedKey = `private-key-${'x'.repeat(1024)}`
    const payload = `{${JSON.stringify(untrustedKey)}:1,${JSON.stringify(untrustedKey)}:2}`
    let failure: unknown

    try {
      await readText(jsonResponse(payload))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'Malformed Anthropic response JSON: duplicate object key',
    )
    expect((failure as Error).message).not.toContain(untrustedKey)
  })

  test('does not include duplicate SSE object-key content in parser errors', async () => {
    const untrustedKey = `private-sse-key-${'x'.repeat(1024)}`
    const json = `{${JSON.stringify(untrustedKey)}:1,${JSON.stringify(untrustedKey)}:2}`
    let failure: unknown

    try {
      await readText(createStrippedStream(sseResponse([`data: ${json}\n\n`])))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'Malformed Anthropic response JSON: duplicate object key',
    )
    expect((failure as Error).message).not.toContain(untrustedKey)
  })

  test.each([
    ['root type', `{"type":"message","type":"message"}`],
    ['root content', `{"type":"message","content":[],"content":[]}`],
    [
      'root content_block',
      `{"type":"content_block_start","content_block":{},"content_block":{}}`,
    ],
    [
      'block type',
      `{"type":"message","content":[{"type":"tool_use","type":"tool_use","name":"${READ_ALIAS}"}]}`,
    ],
    [
      'block name',
      `{"type":"message","content":[{"type":"tool_use","name":"mcp_Decoy","name":"${READ_ALIAS}"}]}`,
    ],
    [
      'unrelated nested key',
      `{"type":"message","content":[{"type":"tool_use","name":"${READ_ALIAS}","metadata":{"x":1,"x":2}}]}`,
    ],
    [
      'escaped-equivalent name keys',
      `{"type":"message","content":[{"type":"tool_use","\\u006eame":"mcp_Decoy","name":"${READ_ALIAS}"}]}`,
    ],
  ])('rejects duplicate %s keys in SSE', async (_, json) => {
    await expect(
      readText(createStrippedStream(sseResponse([`data: ${json}\n\n`]))),
    ).rejects.toThrow()
  })

  test('accepts the same root and block key permutations in SSE', async () => {
    const jsonValues = [
      `{"content":[{"type":"tool_use","name":"${READ_ALIAS}"}],"type":"message"}`,
      `{"content_block":{"name":"${READ_ALIAS}","type":"tool_use"},"type":"content_block_start"}`,
      `{"type":"message","content":[{"name":"${READ_ALIAS}","type":"tool_use"}]}`,
    ]

    for (const json of jsonValues) {
      const output = await readText(
        createStrippedStream(sseResponse([`data: ${json}\n\n`])),
      )
      expect(output).toContain('"name":"Read"')
      expect(JSON.parse(output.slice('data: '.length)).type).toBeDefined()
    }
  })

  test('rejects malformed, truncated, and over-deep JSON', async () => {
    await expect(readText(jsonResponse('{"type":"message"'))).rejects.toThrow()
    await expect(
      readText(jsonResponse('{"type":"message"}oops')),
    ).rejects.toThrow()
    let nested = '{}'
    for (let depth = 0; depth <= MAX_JSON_DEPTH; depth += 1) {
      nested = `{"nested":${nested}}`
    }
    await expect(readText(jsonResponse(nested))).rejects.toThrow(
      'Anthropic response JSON exceeds traversal limits',
    )
  })

  test('rewrites a document above the former whole-document limit', async () => {
    const formerWholeDocumentLimit = 5 * 1024 * 1024
    const payload = `{"type":"message","content":[{"type":"tool_use","name":"${READ_ALIAS}","input":{"padding":"${'x'.repeat(formerWholeDocumentLimit + 1)}"}}]}`
    const output = await readText(jsonResponse(payload))
    expect(output.startsWith('{"type":"message"')).toBe(true)
    expect(output).toContain('"name":"Read"')
    const expected = payload.replace(`"${READ_ALIAS}"`, '"Read"')
    expect(output.length).toBe(expected.length)
  })

  test('bounds tool names and every individual JSON string', async () => {
    const longName = `{"type":"message","content":[{"type":"tool_use","name":"${'x'.repeat(MAX_JSON_TOOL_NAME_BYTES + 1)}"}]}`
    await expect(readText(jsonResponse(longName))).rejects.toThrow(
      `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`,
    )
    const longString = `{"value":"${'x'.repeat(MAX_JSON_STRING_BYTES + 1)}"}`
    await expect(readText(jsonResponse(longString))).rejects.toThrow(
      `${MAX_JSON_STRING_BYTES} byte string limit`,
    )
  })

  test('applies the tool-name limit to decoded escaped bytes', async () => {
    const escaped = (count: number) =>
      `{"type":"message","content":[{"type":"tool_use","name":"mcp_${'\\u0061'.repeat(count)}"}]}`
    const accepted = await readText(jsonResponse(escaped(60)))
    expect(accepted).toBe(escaped(60))
    await expect(readText(jsonResponse(escaped(61)))).rejects.toThrow(
      `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`,
    )
  })

  test.each([
    ['high', '\\ud800'],
    ['low', '\\udfff'],
  ])('rejects an escaped lone %s surrogate in JSON message tool name', async (_, escaped) => {
    const payload = `{"type":"message","content":[{"type":"tool_use","name":"mcp_${escaped}","metadata":{"name":"mcp_Metadata"}}]}`

    await expect(readText(jsonResponse(payload))).rejects.toThrow(
      'Tool names must contain well-formed UTF-16',
    )
  })

  test('preserves an escaped astral surrogate pair in an unknown JSON alias', async () => {
    const payload = `{"type":"message","metadata":{"name":"mcp_Top"},"content":[{"type":"tool_use","name":"mcp_\\ud83d\\ude00","metadata":{"name":"mcp_Metadata"}}]}`

    const output = await readText(jsonResponse(payload))
    expect(output).toBe(payload)
    expect(JSON.parse(output).content[0].name).toBe('mcp_\u{1f600}')
  })

  test('bounds a numeric token split across chunks', async () => {
    const payload = `{"value":${'1'.repeat(MAX_JSON_NUMBER_BYTES + 1)}}`
    const bytes = encoder.encode(payload)
    const split = payload.indexOf('1') + Math.floor(MAX_JSON_NUMBER_BYTES / 2)
    await expect(
      readText(
        jsonResponse(streamOf([bytes.slice(0, split), bytes.slice(split)])),
      ),
    ).rejects.toThrow(`${MAX_JSON_NUMBER_BYTES} byte number limit`)
  })

  test('forwards JSON cancellation and upstream errors', async () => {
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"message",'))
      },
      cancel() {
        cancelled = true
      },
    })
    const reader = jsonResponse(source).body!.getReader()
    await reader.read()
    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelled).toBe(true)

    const failure = new Error('upstream JSON failed')
    const failed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure)
      },
    })
    await expect(readText(jsonResponse(failed))).rejects.toBe(failure)
  })

  test('decodes multiple deferred message tool names when root type is last', async () => {
    const payload = `{"content":[{"name":"${READ_ALIAS}","type":"tool_use"},{"name":"${WRITE_ALIAS}","type":"tool_use"}],"type":"message"}`
    const output = await readText(jsonResponse(payload))
    const parsed = JSON.parse(output)

    expect(parsed.content.map((block: { name: string }) => block.name)).toEqual(
      ['Read', 'Write'],
    )
    expect(output).toBe(
      `{"content":[{"name":"Read","type":"tool_use"},{"name":"Write","type":"tool_use"}],"type":"message"}`,
    )
  })

  test('preserves deferred text names while decoding tool names', async () => {
    const payload = `{"content":[{"name":"${READ_ALIAS}","type":"text"},{"name":"${WRITE_ALIAS}","type":"tool_use"}],"type":"message"}`
    const output = await readText(jsonResponse(payload))
    const parsed = JSON.parse(output)

    expect(parsed.content[0].name).toBe(READ_ALIAS)
    expect(parsed.content[1].name).toBe('Write')
    expect(output).toBe(
      `{"content":[{"name":"${READ_ALIAS}","type":"text"},{"name":"Write","type":"tool_use"}],"type":"message"}`,
    )
  })

  test.each([
    [
      'an escaped lone surrogate',
      '\\ud800',
      'Tool names must contain well-formed UTF-16',
    ],
    [
      'a name over 64 UTF-8 bytes',
      `mcp_${'x'.repeat(MAX_JSON_TOOL_NAME_BYTES + 1 - 'mcp_'.length)}`,
      `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`,
    ],
  ])('rejects deferred %s only after final tool_use type confirmation', async (_, name, error) => {
    const toolUse = `{"content":[{"name":"${name}","type":"tool_use"}],"type":"message"}`
    await expect(readText(jsonResponse(toolUse))).rejects.toThrow(error)

    const text = `{"content":[{"name":"${name}","type":"text"}],"type":"message"}`
    expect(await readText(jsonResponse(text))).toBe(text)
  })

  test.each([
    MAX_JSON_PENDING_BLOCK_BYTES,
    MAX_JSON_PENDING_BLOCK_BYTES + 1,
  ])('handles a deferred held region of %d UTF-8 bytes', async (targetBytes) => {
    const deferred = (padding: string) =>
      `"mcp_Unknown","padding":"${padding}","type":"tool_use"}]` +
      `,"type":"message"}`
    const prefix = '{"content":[{"name":'
    const baseBytes = encoder.encode(`${prefix}${deferred('')}`).byteLength
    const fixedHeldBytes = encoder.encode(deferred('')).byteLength - 1
    const paddingBytes = targetBytes - fixedHeldBytes
    const body = `${prefix}${deferred('x'.repeat(paddingBytes))}`

    expect(encoder.encode(body).byteLength).toBe(baseBytes + paddingBytes)
    const result = readText(jsonResponse(body))
    if (targetBytes === MAX_JSON_PENDING_BLOCK_BYTES) {
      const output = await result
      expect(JSON.parse(output).content[0].name).toBe('mcp_Unknown')
    } else {
      await expect(result).rejects.toThrow(
        `Anthropic response JSON exceeds ${MAX_JSON_PENDING_BLOCK_BYTES} byte pending-block limit`,
      )
    }
  })

  test('rejects application/json with more than the object-key cap', async () => {
    const value = Object.fromEntries(
      Array.from({ length: MAX_JSON_OBJECT_KEYS + 1 }, (_, index) => [
        `key${index}`,
        index,
      ]),
    )

    await expect(
      readText(jsonResponse(JSON.stringify(value))),
    ).rejects.toThrow()
  })

  test('bounds aggregate object keys retained until an object closes', async () => {
    const key = 'k'.repeat(1024 * 1024)
    const count = Math.floor(MAX_JSON_RETAINED_KEY_BYTES / key.length) + 1
    const payload = `{${Array.from(
      { length: count },
      (_, index) => `${JSON.stringify(`${index}${key}`)}:null`,
    ).join(',')}}`

    await expect(readText(jsonResponse(payload))).rejects.toThrow(
      'Anthropic response JSON exceeds retained-key byte limit',
    )
  })

  test('releases retained-key bytes when sibling objects close', async () => {
    const key = 'k'.repeat(1024 * 1024)
    const payload = `[${Array.from(
      { length: 9 },
      (_, index) => `{${JSON.stringify(`${index}${key}`)}:null}`,
    ).join(',')}]`

    expect(await readText(jsonResponse(payload))).toBe(payload)
  })

  test('rejects application/json with more than 100000 traversal nodes', async () => {
    const value = Array.from({ length: 100_001 }, () => null)

    await expect(readText(jsonResponse(JSON.stringify(value)))).rejects.toThrow(
      'Anthropic response JSON exceeds traversal limits',
    )
  })

  test('rejects SSE JSON with more than the object-key cap', async () => {
    const value = Object.fromEntries(
      Array.from({ length: MAX_JSON_OBJECT_KEYS + 1 }, (_, index) => [
        `key${index}`,
        index,
      ]),
    )
    const pretty = JSON.stringify(value, null, 2)
    const payload = `${pretty
      .split('\n')
      .map((line) => `data: ${line}\n`)
      .join('')}\n`

    await expect(
      readText(createStrippedStream(sseResponse([payload]))),
    ).rejects.toThrow()
  })

  test.each([
    MAX_JSON_PENDING_BLOCK_BYTES,
    MAX_JSON_PENDING_BLOCK_BYTES + 1,
  ])('bounds direct replacement expansion at %d UTF-8 bytes', async (targetBytes) => {
    const aliases = new ToolNameAliasTable()
    const original = `original-${'x'.repeat(80)}`
    const alias = aliases.encode(original)
    const replacementBytes = encoder.encode(JSON.stringify(original)).byteLength
    const whitespaceBytes = targetBytes - replacementBytes
    const whitespace = ' '.repeat(whitespaceBytes)
    const body = `{"type":"message","content":[{"type":"tool_use","name":${JSON.stringify(alias)}${whitespace}}]}`
    const response = createStrippedStream(
      new Response(streamOf([body]), {
        headers: { 'content-type': 'application/json' },
      }),
      aliases,
    )

    try {
      const result = readText(response)
      if (targetBytes === MAX_JSON_PENDING_BLOCK_BYTES) {
        const output = await result
        expect(JSON.parse(output).content[0].name).toBe(original)
      } else {
        await expect(result).rejects.toThrow(
          `Anthropic response JSON exceeds ${MAX_JSON_PENDING_BLOCK_BYTES} byte rewritten-segment limit`,
        )
      }
    } finally {
      aliases.dispose()
    }
  })
})
