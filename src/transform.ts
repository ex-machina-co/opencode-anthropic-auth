import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { buildBillingHeaderValue } from './cch.ts'
import {
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_IDENTITY,
  CLAUDE_CODE_VERSION,
  formatUserAgent,
  OPENCODE_IDENTITY_PREFIX,
  PARAGRAPH_REMOVAL_ANCHORS,
  REQUIRED_BETAS,
  TEXT_REPLACEMENTS,
  TOOL_PREFIX,
} from './constants.ts'
import {
  assertWellFormedUtf16,
  createBoundedJsonToolNameStream,
  MAX_JSON_NODES,
  MAX_JSON_OBJECT_KEYS,
  MAX_JSON_TOOL_NAME_BYTES,
} from './json-response-stream.ts'

// Bound an incomplete SSE line so malformed streams cannot grow memory forever.
export const MAX_SSE_LINE_BYTES = 5 * 1024 * 1024
export const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024
export { MAX_JSON_TOOL_NAME_BYTES }

const SHORT_TOOL_ALIAS_PREFIX = `${TOOL_PREFIX}T`
const LONG_TOOL_ALIAS_PREFIX = `${TOOL_PREFIX}H`
const MAX_TOOL_ALIAS_BYTES = 64
const MAX_INLINE_TOOL_NAME_BYTES = 44
const DEFAULT_ALIAS_ENTRIES = 4096
const DEFAULT_ALIAS_BYTES = 256 * 1024
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

type ToolNameAliasOptions = {
  maxEntries?: number
  maxBytes?: number
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Reversible tool-name aliases bounded to Anthropic's 64-byte limit.
 *
 * Names up to 44 UTF-8 bytes are encoded inline. Longer names use a stable
 * SHA-256 alias and are retained in a bounded table because a lossless,
 * stateless 64-byte source -> 60-byte payload mapping is impossible.
 */
export class ToolNameAliasTable {
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly longByName = new Map<string, string>()
  private readonly longByAlias = new Map<string, string>()
  private retainedBytes = 0
  private disposed = false

  constructor(options: ToolNameAliasOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_ALIAS_ENTRIES
    this.maxBytes = options.maxBytes ?? DEFAULT_ALIAS_BYTES
    if (
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 0 ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 0
    ) {
      throw new TypeError(
        'Tool-name alias limits must be safe non-negative integers',
      )
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Tool-name alias table is disposed')
  }

  encode(name: string): string {
    this.assertActive()
    assertWellFormedUtf16(name)
    const bytes = utf8Encoder.encode(name)
    if (bytes.byteLength === 0) {
      throw new Error('Tool names must not be empty')
    }

    if (bytes.byteLength <= MAX_INLINE_TOOL_NAME_BYTES) {
      const alias = `${SHORT_TOOL_ALIAS_PREFIX}${base64url(bytes)}`
      if (utf8Encoder.encode(alias).byteLength > MAX_TOOL_ALIAS_BYTES) {
        throw new Error('Encoded tool name exceeds Anthropic alias limit')
      }
      return alias
    }

    const existing = this.longByName.get(name)
    if (existing) return existing

    const alias = `${LONG_TOOL_ALIAS_PREFIX}${createHash('sha256')
      .update(bytes)
      .digest('base64url')}`
    const collision = this.longByAlias.get(alias)
    if (collision !== undefined && collision !== name) {
      throw new Error('Tool-name alias collision')
    }
    if (this.longByName.size >= this.maxEntries) {
      throw new Error('Tool-name alias entry limit exceeded')
    }
    if (bytes.byteLength > this.maxBytes - this.retainedBytes) {
      throw new Error('Tool-name alias byte limit exceeded')
    }

    this.longByName.set(name, alias)
    this.longByAlias.set(alias, name)
    this.retainedBytes += bytes.byteLength
    return alias
  }

  decode(alias: string): string | undefined {
    this.assertActive()
    if (alias.startsWith(SHORT_TOOL_ALIAS_PREFIX)) {
      const encoded = alias.slice(SHORT_TOOL_ALIAS_PREFIX.length)
      if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined
      try {
        const bytes = Buffer.from(encoded, 'base64url')
        if (bytes.byteLength > MAX_INLINE_TOOL_NAME_BYTES) return undefined
        if (base64url(bytes) !== encoded) return undefined
        const name = utf8Decoder.decode(bytes)
        const canonical = `${SHORT_TOOL_ALIAS_PREFIX}${base64url(
          utf8Encoder.encode(name),
        )}`
        return canonical === alias ? name : undefined
      } catch {
        return undefined
      }
    }
    if (alias.startsWith(LONG_TOOL_ALIAS_PREFIX)) {
      return this.longByAlias.get(alias)
    }
    return undefined
  }

  get hasStatefulAliases(): boolean {
    this.assertActive()
    return this.longByName.size > 0
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.longByName.clear()
    this.longByAlias.clear()
    this.retainedBytes = 0
  }
}

function statelessToolNameAliases(): ToolNameAliasTable {
  return new ToolNameAliasTable({ maxEntries: 0, maxBytes: 0 })
}

function finalizeStream(
  stream: ReadableStream<Uint8Array>,
  finalize: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader()
  let released = false
  const release = () => {
    if (released) return
    released = true
    reader.releaseLock()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          release()
          finalize()
          controller.close()
        } else {
          controller.enqueue(result.value)
        }
      } catch (error) {
        release()
        finalize()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        release()
        finalize()
      }
    },
  })
}

export function headersAfterBodyTransform(source: Headers): Headers {
  const headers = new Headers(source)
  for (const name of [
    'content-digest',
    'content-encoding',
    'content-length',
    'content-md5',
    'content-range',
    'digest',
    'etag',
  ]) {
    headers.delete(name)
  }
  return headers
}

export type FetchInput = string | URL | Request

/**
 * Merge headers from a Request object and/or a RequestInit headers value
 * into a single Headers instance.
 */
export function mergeHeaders(input: FetchInput, init?: RequestInit): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  const initHeaders = init?.headers
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers.set(key, value)
      })
    } else if (Array.isArray(initHeaders)) {
      for (const entry of initHeaders) {
        const [key, value] = entry as [string, string]
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    }
  }

  return headers
}

/**
 * Merge incoming beta headers with the required OAuth betas, deduplicating.
 */
export function mergeBetaHeaders(headers: Headers): string {
  const incomingBeta = headers.get('anthropic-beta') || ''
  const incomingBetasList = incomingBeta
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)

  return [...new Set([...REQUIRED_BETAS, ...incomingBetasList])].join(',')
}

/**
 * Set OAuth-required headers on the request: authorization, beta, user-agent.
 * Removes x-api-key since we're using OAuth.
 */
export function setOAuthHeaders(
  headers: Headers,
  accessToken: string,
  version: string = CLAUDE_CODE_VERSION,
): Headers {
  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('anthropic-beta', mergeBetaHeaders(headers))
  headers.set('user-agent', formatUserAgent(version))
  headers.delete('x-api-key')
  return headers
}

/**
 * Add TOOL_PREFIX to tool names in the request body.
 * Prefixes both tool definitions and tool_use blocks in messages.
 */
export function prefixToolNames(
  parsed: Record<string, unknown>,
  alreadyPrefixed = false,
  aliases: ToolNameAliasTable = statelessToolNameAliases(),
): string {
  const prefix = (name: string) =>
    alreadyPrefixed && name.startsWith(TOOL_PREFIX)
      ? name
      : aliases.encode(name)

  if (parsed.tools && Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.map((tool) =>
      isRecord(tool) && typeof tool.name === 'string' && tool.name.length > 0
        ? { ...tool, name: prefix(tool.name) }
        : tool,
    )
  }

  if (parsed.messages && Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map((message) => {
      if (!isRecord(message) || !Array.isArray(message.content)) return message
      return {
        ...message,
        content: message.content.map((block) =>
          isRecord(block) &&
          block.type === 'tool_use' &&
          typeof block.name === 'string' &&
          block.name.length > 0
            ? { ...block, name: prefix(block.name) }
            : block,
        ),
      }
    })
  }

  return JSON.stringify(parsed)
}

/**
 * Strip TOOL_PREFIX from tool names in streaming response text.
 */
export function stripToolPrefix(
  text: string,
  aliases: ToolNameAliasTable = statelessToolNameAliases(),
): string {
  return text.replace(
    /"name"\s*:\s*"(mcp_[A-Za-z0-9_-]+)"/g,
    (match, alias: string) => {
      const name = aliases.decode(alias)
      return name === undefined ? match : `"name": ${JSON.stringify(name)}`
    },
  )
}

type JsonPath = Array<string | number>

type JsonReplacement = {
  path: JsonPath
  value: string
}

const MAX_RESPONSE_JSON_DEPTH = 256

function isToolUseWithAlias(value: unknown): value is Record<
  string,
  unknown
> & {
  name: string
} {
  return (
    isRecord(value) &&
    value.type === 'tool_use' &&
    typeof value.name === 'string' &&
    value.name.startsWith(TOOL_PREFIX)
  )
}

function validateResponseToolName(name: string): void {
  assertWellFormedUtf16(name)
  if (utf8Encoder.encode(name).byteLength > MAX_JSON_TOOL_NAME_BYTES) {
    throw new Error(
      `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`,
    )
  }
}

function responseToolNameReplacements(
  value: unknown,
  aliases: ToolNameAliasTable,
): JsonReplacement[] {
  if (!isRecord(value)) return []

  if (
    value.type === 'content_block_start' &&
    isToolUseWithAlias(value.content_block)
  ) {
    validateResponseToolName(value.content_block.name)
    const name = aliases.decode(value.content_block.name)
    return name === undefined
      ? []
      : [{ path: ['content_block', 'name'], value: name }]
  }

  if (value.type !== 'message' || !Array.isArray(value.content)) return []

  const replacements: JsonReplacement[] = []
  for (let index = 0; index < value.content.length; index++) {
    const block = value.content[index]
    if (!isToolUseWithAlias(block)) continue
    validateResponseToolName(block.name)
    const name = aliases.decode(block.name)
    if (name !== undefined) {
      replacements.push({ path: ['content', index, 'name'], value: name })
    }
  }
  return replacements
}

function pathKey(path: JsonPath): string {
  return JSON.stringify(path)
}

function rewriteJsonStringTokens(
  text: string,
  replacements: JsonReplacement[],
): string {
  const wanted = new Map(
    replacements.map((replacement) => [
      pathKey(replacement.path),
      JSON.stringify(replacement.value),
    ]),
  )
  const edits = new Map<string, { start: number; end: number; value: string }>()
  let visited = 0
  let objectKeys = 0

  function failLimits() {
    throw new Error('Anthropic response JSON exceeds traversal limits')
  }

  function skipWhitespace(offset: number): number {
    while (/\s/.test(text[offset] ?? '')) offset++
    return offset
  }

  function scanString(offset: number): number {
    let cursor = offset + 1
    while (cursor < text.length) {
      const char = text[cursor]
      if (char === '"') return cursor + 1
      if (char === '\\') cursor++
      cursor++
    }
    return text.length
  }

  function walkValue(offset: number, path: JsonPath, depth: number): number {
    visited++
    if (visited > MAX_JSON_NODES || depth > MAX_RESPONSE_JSON_DEPTH) {
      failLimits()
    }

    let cursor = skipWhitespace(offset)
    const char = text[cursor]
    if (char === '"') {
      const end = scanString(cursor)
      const key = pathKey(path)
      const replacement = wanted.get(key)
      if (replacement !== undefined) {
        edits.set(key, { start: cursor, end, value: replacement })
      }
      return end
    }

    if (char === '{') {
      cursor = skipWhitespace(cursor + 1)
      const seenKeys = new Set<string>()
      while (text[cursor] !== '}' && cursor < text.length) {
        const keyStart = cursor
        const keyEnd = scanString(keyStart)
        const key: string = JSON.parse(text.slice(keyStart, keyEnd))
        objectKeys += 1
        if (objectKeys > MAX_JSON_OBJECT_KEYS) {
          throw new Error('Anthropic response JSON exceeds object-key limit')
        }
        if (seenKeys.has(key)) {
          throw new Error(
            'Malformed Anthropic response JSON: duplicate object key',
          )
        }
        seenKeys.add(key)
        cursor = skipWhitespace(keyEnd)
        cursor = skipWhitespace(cursor + 1)
        cursor = walkValue(cursor, [...path, key], depth + 1)
        cursor = skipWhitespace(cursor)
        if (text[cursor] === ',') cursor = skipWhitespace(cursor + 1)
      }
      return cursor + 1
    }

    if (char === '[') {
      cursor = skipWhitespace(cursor + 1)
      let index = 0
      while (text[cursor] !== ']' && cursor < text.length) {
        cursor = walkValue(cursor, [...path, index], depth + 1)
        index++
        cursor = skipWhitespace(cursor)
        if (text[cursor] === ',') cursor = skipWhitespace(cursor + 1)
      }
      return cursor + 1
    }

    while (cursor < text.length && !/[\s,\]}]/.test(text[cursor] ?? '')) {
      cursor++
    }
    return cursor
  }

  walkValue(0, [], 0)

  let output = text
  const orderedEdits = [...edits.values()].sort(
    (left, right) => right.start - left.start,
  )
  for (const edit of orderedEdits) {
    output = output.slice(0, edit.start) + edit.value + output.slice(edit.end)
  }
  return output
}

function rewriteResponseJson(
  text: string,
  aliases: ToolNameAliasTable,
): string | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }

  return rewriteJsonStringTokens(
    text,
    responseToolNameReplacements(value, aliases),
  )
}

type SseLine = {
  readonly content: string
  readonly ending: string
}

function splitSseLines(event: string): SseLine[] {
  const lines: SseLine[] = []
  let offset = 0
  while (offset < event.length) {
    let cursor = offset
    while (
      cursor < event.length &&
      event[cursor] !== '\r' &&
      event[cursor] !== '\n'
    ) {
      cursor += 1
    }
    let ending = ''
    if (event[cursor] === '\r' && event[cursor + 1] === '\n') ending = '\r\n'
    else if (event[cursor] === '\r') ending = '\r'
    else if (event[cursor] === '\n') ending = '\n'
    lines.push({ content: event.slice(offset, cursor), ending })
    offset = cursor + ending.length
  }
  return lines
}

function sseDataValue(line: string): string | undefined {
  if (line === 'data') return ''
  if (!line.startsWith('data:')) return undefined
  const value = line.slice('data:'.length)
  return value.startsWith(' ') ? value.slice(1) : value
}

function transformSseEvent(
  bytes: Uint8Array,
  aliases: ToolNameAliasTable,
): Uint8Array {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const encoder = new TextEncoder()
  const event = decoder.decode(bytes)

  const lines = splitSseLines(event)
  const dataIndexes: number[] = []
  const dataValues: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const value = sseDataValue(lines[index]?.content ?? '')
    if (value === undefined) continue
    dataIndexes.push(index)
    dataValues.push(value)
  }
  if (dataIndexes.length === 0) return bytes

  const payload = dataValues.join('\n')
  if (payload.trim() === '[DONE]') return bytes
  const firstPayloadCharacter = payload.trimStart()[0]
  const jsonLooking =
    firstPayloadCharacter === '{' || firstPayloadCharacter === '['
  if (!payload.includes(TOOL_PREFIX) && !jsonLooking) return bytes

  const rewritten = rewriteResponseJson(payload, aliases)
  if (rewritten === undefined) {
    if (jsonLooking) {
      throw new Error('Malformed or truncated Anthropic response JSON')
    }
    return bytes
  }
  if (rewritten === payload) return bytes
  const canonical =
    /[\r\n]/.test(rewritten) || dataIndexes.length > 1
      ? JSON.stringify(JSON.parse(rewritten))
      : rewritten
  const firstIndex = dataIndexes[0]
  const dataIndexSet = new Set(dataIndexes)
  const output = lines
    .map((line, index) => {
      if (index === firstIndex) return `data: ${canonical}${line.ending}`
      if (dataIndexSet.has(index)) return ''
      return `${line.content}${line.ending}`
    })
    .join('')
  return encoder.encode(output)
}

function createBoundedSseToolNameStream(
  body: ReadableStream<Uint8Array>,
  aliases: ToolNameAliasTable,
): ReadableStream<Uint8Array> {
  let event = new Uint8Array(1024)
  let eventLength = 0
  let lineLength = 0
  let pendingCr = false

  const appendEvent = (bytes: Uint8Array): void => {
    const required = eventLength + bytes.byteLength
    if (required > MAX_SSE_EVENT_BYTES) {
      throw new Error(`SSE event exceeds ${MAX_SSE_EVENT_BYTES} byte limit`)
    }
    if (required > event.byteLength) {
      let capacity = event.byteLength
      while (capacity < required) {
        capacity = Math.min(MAX_SSE_EVENT_BYTES, capacity * 2)
      }
      const expanded = new Uint8Array(capacity)
      expanded.set(event.subarray(0, eventLength))
      event = expanded
    }
    event.set(bytes, eventLength)
    eventLength = required
  }

  const appendContent = (bytes: Uint8Array): void => {
    if (lineLength + bytes.byteLength > MAX_SSE_LINE_BYTES) {
      throw new Error(`SSE line exceeds ${MAX_SSE_LINE_BYTES} byte limit`)
    }
    lineLength += bytes.byteLength
    appendEvent(bytes)
  }

  const dispatch = (
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    if (eventLength === 0) return
    controller.enqueue(transformSseEvent(event.slice(0, eventLength), aliases))
    eventLength = 0
  }

  const finishLine = (
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    const blank = lineLength === 0
    lineLength = 0
    if (blank) dispatch(controller)
  }

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let segmentStart = 0
        if (pendingCr) {
          pendingCr = false
          if (chunk[0] === 0x0a) {
            appendEvent(chunk.subarray(0, 1))
            segmentStart = 1
          }
          finishLine(controller)
        }

        for (let index = segmentStart; index < chunk.byteLength; index += 1) {
          const byte = chunk[index]
          if (byte !== 0x0d && byte !== 0x0a) continue

          appendContent(chunk.subarray(segmentStart, index))
          appendEvent(chunk.subarray(index, index + 1))
          if (byte === 0x0d && index + 1 === chunk.byteLength) {
            pendingCr = true
            segmentStart = index + 1
            break
          }
          if (byte === 0x0d && chunk[index + 1] === 0x0a) {
            appendEvent(chunk.subarray(index + 1, index + 2))
            index += 1
          }
          finishLine(controller)
          segmentStart = index + 1
        }
        appendContent(chunk.subarray(segmentStart))
      },
      flush(controller) {
        if (pendingCr) {
          pendingCr = false
          finishLine(controller)
        }
        dispatch(controller)
      },
    }),
  )
}

/** Check whether TLS verification was explicitly requested off for a custom endpoint. */
export function isInsecure(): boolean {
  if (!process.env.ANTHROPIC_BASE_URL?.trim()) return false
  const raw = process.env.ANTHROPIC_INSECURE?.trim()
  return raw === '1' || raw === 'true'
}

/** Resolve the configured custom endpoint without accepting embedded credentials. */
function resolveBaseUrl(): URL | null {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim()
  if (!raw) return null
  try {
    const baseUrl = new URL(raw)
    if (
      (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
      baseUrl.username ||
      baseUrl.password
    ) {
      return null
    }
    const loopback =
      baseUrl.hostname === 'localhost' ||
      baseUrl.hostname === '127.0.0.1' ||
      baseUrl.hostname === '[::1]'
    if (baseUrl.protocol === 'http:' && !loopback) return null
    return baseUrl
  } catch {
    return null
  }
}

/**
 * Allow OAuth bearer credentials only for Anthropic's official API or the
 * exact origin of an explicitly configured, validated custom endpoint.
 */
export function isTrustedAnthropicUrl(input: string | URL): boolean {
  try {
    const url = new URL(input.toString())
    const configuredOrigin = resolveBaseUrl()?.origin
    return (
      url.username === '' &&
      url.password === '' &&
      (url.origin === 'https://api.anthropic.com' ||
        (configuredOrigin !== undefined && url.origin === configuredOrigin))
    )
  } catch {
    return false
  }
}

/**
 * Rewrite the request URL to add ?beta=true for /v1/messages requests. When
 * ANTHROPIC_BASE_URL is set, override the origin for API requests while
 * retaining the original path and query.
 */
export function rewriteUrl(input: FetchInput): {
  input: FetchInput
  url: URL | null
} {
  let requestUrl: URL | null = null
  try {
    if (typeof input === 'string' || input instanceof URL) {
      requestUrl = new URL(input.toString())
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url)
    }
  } catch {
    requestUrl = null
  }

  if (!requestUrl) return { input, url: null }

  const originalHref = requestUrl.href

  const baseUrl = resolveBaseUrl()
  if (baseUrl) {
    requestUrl.protocol = baseUrl.protocol
    requestUrl.host = baseUrl.host
  }

  if (
    requestUrl.pathname === '/v1/messages' &&
    !requestUrl.searchParams.has('beta')
  ) {
    requestUrl.searchParams.set('beta', 'true')
  }

  if (requestUrl.href === originalHref) {
    return { input, url: requestUrl }
  }

  const newInput =
    input instanceof Request
      ? new Request(requestUrl.toString(), input)
      : requestUrl
  return { input: newInput, url: requestUrl }
}

/**
 * Sanitize OpenCode-branded strings from the system prompt text.
 *
 * 1. Removes the OPENCODE_IDENTITY paragraph.
 * 2. Removes any paragraph (text between blank lines) that contains
 *    one of the PARAGRAPH_REMOVAL_ANCHORS — typically URLs that
 *    identify OpenCode-specific content.
 * 3. Applies TEXT_REPLACEMENTS for inline occurrences of "OpenCode"
 *    inside paragraphs we want to keep.
 *
 * This approach is resilient to upstream rewording of the OpenCode
 * prompt — as long as the anchor strings (URLs, etc.) still appear
 * somewhere in the paragraph, the removal works.
 */
export function sanitizeSystemText(text: string): string {
  // Split into paragraphs (separated by one or more blank lines)
  const paragraphs = text.split(/\n\n+/)

  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) {
      // If the paragraph contains the identity, drop it entirely
      return false
    }

    // Remove paragraphs containing any removal anchor
    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false
    }

    return true
  })

  let result = filtered.join('\n\n')

  // Apply inline text replacements
  for (const rule of TEXT_REPLACEMENTS) {
    result = result.replace(rule.match, rule.replacement)
  }

  return result.trim()
}

type SystemBlock = { type: string; text: string; [k: string]: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Sanitize system prompt and prepend Claude Code identity.
 * Handles all Anthropic API system formats: undefined, string, or array of text blocks.
 */
export function prependClaudeCodeIdentity(system: unknown): SystemBlock[] {
  const identityBlock: SystemBlock = {
    type: 'text',
    text: CLAUDE_CODE_IDENTITY,
  }

  if (system == null) return [identityBlock]

  if (typeof system === 'string') {
    const sanitized = sanitizeSystemText(system)
    if (!sanitized || sanitized === CLAUDE_CODE_IDENTITY) {
      return [identityBlock]
    }
    return [identityBlock, { type: 'text', text: sanitized }]
  }

  if (isRecord(system)) {
    if (system.type !== 'text' || typeof system.text !== 'string') {
      return [identityBlock]
    }
    const text = sanitizeSystemText(system.text)
    if (!text || text === CLAUDE_CODE_IDENTITY) return [identityBlock]
    return [identityBlock, { ...system, type: 'text', text }]
  }

  if (!Array.isArray(system)) return [identityBlock]

  const sanitized: SystemBlock[] = []
  for (const item of system) {
    if (typeof item === 'string') {
      const text = sanitizeSystemText(item)
      if (text && text !== CLAUDE_CODE_IDENTITY) {
        sanitized.push({ type: 'text', text })
      }
      continue
    }

    if (
      isRecord(item) &&
      item.type === 'text' &&
      typeof item.text === 'string'
    ) {
      const text = sanitizeSystemText(item.text)
      if (text && text !== CLAUDE_CODE_IDENTITY) {
        sanitized.push({ ...item, type: 'text', text })
      }
    }
  }

  return [identityBlock, ...sanitized]
}

const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:'

function isBillingBlock(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === 'text' &&
    typeof value.text === 'string' &&
    value.text.startsWith(BILLING_HEADER_PREFIX)
  )
}

function hasRewriteMarker(parsed: Record<string, unknown>): boolean {
  if (!Array.isArray(parsed.system)) return false
  const hasIdentity = parsed.system.some(
    (block) => isRecord(block) && block.text === CLAUDE_CODE_IDENTITY,
  )
  if (!hasIdentity) return false
  const hasUser =
    Array.isArray(parsed.messages) &&
    parsed.messages.some(
      (message) => isRecord(message) && message.role === 'user',
    )
  return !hasUser || parsed.system.some(isBillingBlock)
}

/**
 * Rewrite the full request body: sanitize system prompt and prefix tool names.
 */
export function rewriteRequestBody(
  body: string,
  version: string = CLAUDE_CODE_VERSION,
  aliases: ToolNameAliasTable = statelessToolNameAliases(),
): string {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return body
  }
  if (!isRecord(value)) return body
  const parsed = value
  const alreadyPrefixed = hasRewriteMarker(parsed)

  const billingHeader =
    Array.isArray(parsed.messages) &&
    parsed.messages.some(
      (message) => isRecord(message) && message.role === 'user',
    )
      ? buildBillingHeaderValue(
          parsed.messages,
          version,
          CLAUDE_CODE_ENTRYPOINT,
        )
      : null

  // Sanitize system prompt and prepend Claude Code identity
  const system = prependClaudeCodeIdentity(parsed.system).filter(
    (block) => !isBillingBlock(block),
  )

  // Prepend the billing header as a separate system block so the
  // final layout is: [billing header, identity, ...rest]
  if (billingHeader) {
    system.unshift({ type: 'text', text: billingHeader })
  }
  parsed.system = system

  return prefixToolNames(parsed, alreadyPrefixed, aliases)
}

/**
 * Create a streaming response that strips the tool prefix from tool names.
 */
export function createStrippedStream(
  response: Response,
  aliases: ToolNameAliasTable = statelessToolNameAliases(),
  onFinalize: () => void = () => {},
): Response {
  let finalized = false
  const finalize = () => {
    if (finalized) return
    finalized = true
    onFinalize()
  }

  if (!response.ok) {
    finalize()
    return response
  }
  const mediaType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase()
  if (!response.body) {
    finalize()
    return response
  }
  if (mediaType === 'application/json' || mediaType?.endsWith('+json')) {
    const stream = finalizeStream(
      createBoundedJsonToolNameStream(response.body, TOOL_PREFIX, (alias) =>
        aliases.decode(alias),
      ),
      finalize,
    )
    const headers = headersAfterBodyTransform(response.headers)
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
  if (mediaType !== 'text/event-stream') {
    finalize()
    return response
  }

  const stream = finalizeStream(
    createBoundedSseToolNameStream(response.body, aliases),
    finalize,
  )

  const headers = headersAfterBodyTransform(response.headers)

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
