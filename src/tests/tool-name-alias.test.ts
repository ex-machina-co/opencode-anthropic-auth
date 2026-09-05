import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  createStrippedStream,
  prefixToolNames,
  rewriteRequestBody,
  stripToolPrefix,
  ToolNameAliasTable,
} from '../transform'

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function shortAlias(name: string): string {
  return `mcp_T${base64url(encoder.encode(name))}`
}

function longAlias(name: string): string {
  const digest = createHash('sha256').update(name, 'utf8').digest()
  return `mcp_H${digest.toString('base64url')}`
}

async function responseText(response: Response): Promise<string> {
  return await response.text()
}

function splitEveryByte(text: string): Uint8Array[] {
  const bytes = encoder.encode(text)
  return Array.from(bytes, (byte) => new Uint8Array([byte]))
}

function responseFromChunks(
  chunks: Uint8Array[],
  contentType: string,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': contentType } })
}

describe('ToolNameAliasTable', () => {
  test('rejects unpaired UTF-16 surrogates and round-trips astral pairs', () => {
    const aliases = new ToolNameAliasTable()
    expect(() => aliases.encode('\ud800')).toThrow()
    expect(() => aliases.encode('\udfff')).toThrow()
    const name = 'tool-😀'
    const alias = aliases.encode(name)
    expect(aliases.decode(alias)).toBe(name)
    aliases.dispose()
  })

  test('throws when decoding after disposal and preserves malformed aliases', () => {
    const aliases = new ToolNameAliasTable()
    expect(aliases.decode('mcp_Tnot-base64!')).toBeUndefined()
    expect(aliases.decode('mcp_T')).toBeUndefined()
    expect(aliases.decode('mcp_TYWJj=')).toBeUndefined()
    aliases.dispose()
    expect(() => aliases.decode(shortAlias('Read'))).toThrow()
  })

  test('uses UTF-8 base64url aliases for short names', () => {
    const aliases = new ToolNameAliasTable()
    const name = 'Read/é'
    const output = JSON.parse(
      prefixToolNames({ tools: [{ name }] }, false, aliases),
    )
    expect(output.tools[0].name).toBe(shortAlias(name))
    expect(output.tools[0].name).toMatch(/^mcp_[A-Z][A-Za-z0-9_-]{0,59}$/)
    expect(encoder.encode(output.tools[0].name).byteLength).toBeLessThanOrEqual(
      64,
    )
    expect(
      JSON.parse(stripToolPrefix(JSON.stringify(output), aliases)).tools[0]
        .name,
    ).toBe(name)
    aliases.dispose()
  })

  test('keeps Read and read distinct and order-independent', () => {
    for (const names of [
      ['Read', 'read'],
      ['read', 'Read'],
    ]) {
      const aliases = new ToolNameAliasTable()
      const output = JSON.parse(
        prefixToolNames(
          { tools: names.map((name) => ({ name })) },
          false,
          aliases,
        ),
      )
      expect(output.tools[0].name).not.toBe(output.tools[1].name)
      const restored = JSON.parse(
        stripToolPrefix(JSON.stringify(output), aliases),
      )
      expect(restored.tools.map((tool: { name: string }) => tool.name)).toEqual(
        names,
      )
      aliases.dispose()
    }
  })

  test('shares aliases between definitions and historical tool_use references', () => {
    const aliases = new ToolNameAliasTable()
    const output = JSON.parse(
      prefixToolNames(
        {
          tools: [{ name: 'Read' }],
          messages: [{ content: [{ type: 'tool_use', name: 'Read' }] }],
        },
        false,
        aliases,
      ),
    )
    expect(output.tools[0].name).toBe(output.messages[0].content[0].name)
    expect(
      JSON.parse(stripToolPrefix(JSON.stringify(output), aliases)).messages[0]
        .content[0].name,
    ).toBe('Read')
    aliases.dispose()
  })

  test('round-trips names beginning with mcp_', () => {
    const aliases = new ToolNameAliasTable()
    const name = 'mcp_Read'
    const output = JSON.parse(
      prefixToolNames({ tools: [{ name }] }, false, aliases),
    )
    expect(
      JSON.parse(stripToolPrefix(JSON.stringify(output), aliases)).tools[0]
        .name,
    ).toBe(name)
    aliases.dispose()
  })

  test('uses mcp_T at 44 bytes and mcp_H at 45 bytes', () => {
    const aliases = new ToolNameAliasTable()
    const shortName = 'x'.repeat(44)
    const longName = 'x'.repeat(45)
    const shortOutput = JSON.parse(
      prefixToolNames({ tools: [{ name: shortName }] }, false, aliases),
    )
    const longOutput = JSON.parse(
      prefixToolNames({ tools: [{ name: longName }] }, false, aliases),
    )
    expect(shortOutput.tools[0].name).toBe(shortAlias(shortName))
    expect(longOutput.tools[0].name).toBe(longAlias(longName))
    expect(shortOutput.tools[0].name).toMatch(/^mcp_T/)
    expect(longOutput.tools[0].name).toMatch(/^mcp_H/)
    expect(
      JSON.parse(stripToolPrefix(JSON.stringify(shortOutput), aliases)).tools[0]
        .name,
    ).toBe(shortName)
    expect(
      JSON.parse(stripToolPrefix(JSON.stringify(longOutput), aliases)).tools[0]
        .name,
    ).toBe(longName)
    for (const output of [shortOutput, longOutput]) {
      expect(
        encoder.encode(output.tools[0].name).byteLength,
      ).toBeLessThanOrEqual(64)
      expect(output.tools[0].name).toMatch(/^mcp_[A-Z][A-Za-z0-9_-]{0,59}$/)
    }
    aliases.dispose()
  })

  test('uses the UTF-8 byte boundary rather than JavaScript length', () => {
    const aliases = new ToolNameAliasTable()
    const shortName = 'é'.repeat(22)
    const longName = 'é'.repeat(23)
    expect(encoder.encode(shortName).byteLength).toBe(44)
    expect(encoder.encode(longName).byteLength).toBe(46)
    expect(
      JSON.parse(
        prefixToolNames({ tools: [{ name: shortName }] }, false, aliases),
      ).tools[0].name,
    ).toBe(shortAlias(shortName))
    expect(
      JSON.parse(
        prefixToolNames({ tools: [{ name: longName }] }, false, aliases),
      ).tools[0].name,
    ).toBe(longAlias(longName))
    aliases.dispose()
  })

  test('keeps all requested ASCII lengths within the alias bound', () => {
    const aliases = new ToolNameAliasTable()
    for (const length of [44, 45, 59, 60, 61, 62, 63, 64]) {
      const name = 'x'.repeat(length)
      const output = JSON.parse(
        prefixToolNames({ tools: [{ name }] }, false, aliases),
      )
      expect(
        encoder.encode(output.tools[0].name).byteLength,
      ).toBeLessThanOrEqual(64)
      expect(output.tools[0].name).toMatch(/^mcp_[A-Z][A-Za-z0-9_-]{0,59}$/)
      expect(
        JSON.parse(stripToolPrefix(JSON.stringify(output), aliases)).tools[0]
          .name,
      ).toBe(name)
    }
    aliases.dispose()
  })

  test('uses deterministic SHA-256 aliases for long names', () => {
    const name = 'x'.repeat(64)
    const first = new ToolNameAliasTable()
    const second = new ToolNameAliasTable()
    const firstAlias = JSON.parse(
      prefixToolNames({ tools: [{ name }] }, false, first),
    ).tools[0].name
    const secondAlias = JSON.parse(
      prefixToolNames({ tools: [{ name }] }, false, second),
    ).tools[0].name
    expect(firstAlias).toBe(longAlias(name))
    expect(secondAlias).toBe(firstAlias)
    expect(firstAlias).toMatch(/^mcp_[A-Z][A-Za-z0-9_-]{0,59}$/)
    first.dispose()
    second.dispose()
  })

  test('preserves unknown aliases exactly, including case', () => {
    const aliases = new ToolNameAliasTable()
    const text = '{"name":"mcp_Unknown_ALIAS"}'
    expect(stripToolPrefix(text, aliases)).toBe(text)
    aliases.dispose()
  })

  test('enforces entry and original-name byte budgets independently', () => {
    const entries = new ToolNameAliasTable({ maxEntries: 1, maxBytes: 1024 })
    const firstName = 'x'.repeat(45)
    const duplicate = JSON.parse(
      prefixToolNames({ tools: [{ name: firstName }] }, false, entries),
    ).tools[0].name
    expect(
      JSON.parse(
        prefixToolNames({ tools: [{ name: firstName }] }, false, entries),
      ).tools[0].name,
    ).toBe(duplicate)
    expect(() =>
      prefixToolNames({ tools: [{ name: 'y'.repeat(46) }] }, false, entries),
    ).toThrow()
    entries.dispose()

    const bytes = new ToolNameAliasTable({ maxEntries: 10, maxBytes: 45 })
    expect(() =>
      prefixToolNames({ tools: [{ name: 'y'.repeat(64) }] }, false, bytes),
    ).toThrow()
    const validName = 'z'.repeat(45)
    expect(() =>
      prefixToolNames({ tools: [{ name: validName }] }, false, bytes),
    ).not.toThrow()
    expect(() =>
      prefixToolNames({ tools: [{ name: validName }] }, false, bytes),
    ).not.toThrow()
    bytes.dispose()
  })

  test('dispose is idempotent and rejects encoding afterward', () => {
    const aliases = new ToolNameAliasTable()
    aliases.dispose()
    expect(() => aliases.dispose()).not.toThrow()
    expect(() =>
      prefixToolNames({ tools: [{ name: 'x'.repeat(45) }] }, false, aliases),
    ).toThrow()
  })
})

describe('alias-aware request and response transforms', () => {
  test('request rewriting is byte-idempotent with same and fresh tables', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: [{ type: 'tool_use', name: 'Read' }] },
      ],
      tools: [{ name: 'Read' }],
    })
    const firstTable = new ToolNameAliasTable()
    const once = rewriteRequestBody(body, undefined, firstTable)
    expect(rewriteRequestBody(once, undefined, firstTable)).toBe(once)
    const secondTable = new ToolNameAliasTable()
    expect(rewriteRequestBody(body, undefined, secondTable)).toBe(once)
    firstTable.dispose()
    secondTable.dispose()
  })

  test('decodes JSON responses with the explicit table', async () => {
    const aliases = new ToolNameAliasTable()
    const name = 'j'.repeat(64)
    const request = JSON.parse(
      prefixToolNames({ tools: [{ name }] }, false, aliases),
    )
    const response = new Response(
      JSON.stringify({
        type: 'message',
        content: [{ type: 'tool_use', name: request.tools[0].name }],
      }),
      { headers: { 'content-type': 'application/json' } },
    )
    expect(
      JSON.parse(await responseText(createStrippedStream(response, aliases)))
        .content[0].name,
    ).toBe(name)
    aliases.dispose()
  })

  test('decodes SSE responses across every byte boundary with the same table', async () => {
    const aliases = new ToolNameAliasTable()
    const name = 's'.repeat(64)
    const request = JSON.parse(
      prefixToolNames({ tools: [{ name }] }, false, aliases),
    )
    const sse = `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${request.tools[0].name}"}}\n\n`
    const output = await responseText(
      createStrippedStream(
        responseFromChunks(splitEveryByte(sse), 'text/event-stream'),
        aliases,
      ),
    )
    expect(JSON.parse(output.slice(6)).content_block.name).toBe(name)
    aliases.dispose()
  })
})
