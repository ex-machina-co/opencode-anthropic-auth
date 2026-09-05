import { type ParsedTokenInfo, Tokenizer, TokenType } from '@streamparser/json'

export const MAX_JSON_TOOL_NAME_BYTES = 64
export const MAX_JSON_STRING_BYTES = 8 * 1024 * 1024
export const MAX_JSON_NUMBER_BYTES = 128
export const MAX_JSON_DEPTH = 256
export const MAX_JSON_OBJECT_KEYS = 100_000
export const MAX_JSON_RETAINED_KEY_BYTES = 8 * 1024 * 1024
export const MAX_JSON_NODES = 100_000
export const MAX_JSON_PENDING_BLOCK_BYTES = 8 * 1024 * 1024

const TOKENIZER_SLICE_BYTES = 1024
const encoder = new TextEncoder()

type ObjectState = 'key-or-end' | 'key' | 'colon' | 'value' | 'comma-or-end'
type ArrayState = 'value-or-end' | 'value' | 'comma-or-end'
type FrameRole =
  | 'root'
  | 'content-array'
  | 'message-block'
  | 'content-block'
  | 'other'

type ObjectFrame = {
  mode: 'object'
  state: ObjectState
  role: FrameRole
  key?: string
  typeSeen: boolean
  objectType?: string
  seenType: boolean
  seenName: boolean
  seenContent: boolean
  seenContentBlock: boolean
  seenKeys: Set<string>
  retainedKeyBytes: number
}

type ArrayFrame = {
  mode: 'array'
  state: ArrayState
  role: FrameRole
}

type Frame = ObjectFrame | ArrayFrame

type PendingToken = {
  offset: number
  token: TokenType
  replacement?: Uint8Array
}

type DeferredName = {
  readonly frame: ObjectFrame
  readonly root: ObjectFrame
  readonly offset: number
  readonly tokenLength: number
  readonly name: string
}

class ByteQueue {
  private chunks: Array<{
    readonly start: number
    readonly bytes: Uint8Array
  }> = []
  private head = 0
  private offset = 0
  private length = 0

  append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return
    this.chunks.push({
      start: this.offset + this.length,
      bytes: bytes.slice(),
    })
    this.length += bytes.byteLength
  }

  get start(): number {
    return this.offset
  }

  get size(): number {
    return this.length
  }

  takeTo(end: number): Uint8Array {
    const count = end - this.offset
    if (count < 0 || count > this.length) throw malformedJson()
    const output = new Uint8Array(count)
    let written = 0
    while (written < count) {
      const entry = this.chunks[this.head]
      if (!entry) throw malformedJson()
      const begin = this.offset - entry.start
      const available = entry.bytes.byteLength - begin
      const consumed = Math.min(available, count - written)
      output.set(entry.bytes.subarray(begin, begin + consumed), written)
      written += consumed
      this.offset += consumed
      this.length -= consumed
      if (begin + consumed === entry.bytes.byteLength) this.head += 1
    }
    if (this.head >= 1024 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
    return output
  }

  bytesFrom(start: number): Uint8Array {
    if (start < this.offset || start > this.offset + this.length) {
      throw malformedJson()
    }
    const output = new Uint8Array(this.offset + this.length - start)
    let outputOffset = 0
    let low = this.head
    let high = this.chunks.length
    while (low < high) {
      const middle = low + ((high - low) >> 1)
      const entry = this.chunks[middle]
      if (!entry) throw malformedJson()
      if (entry.start + entry.bytes.byteLength <= start) low = middle + 1
      else high = middle
    }
    for (let index = low; index < this.chunks.length; index += 1) {
      const entry = this.chunks[index]
      if (!entry) throw malformedJson()
      const begin = Math.max(0, start - entry.start)
      output.set(entry.bytes.subarray(begin), outputOffset)
      outputOffset += entry.bytes.byteLength - begin
    }
    return output
  }
}

function malformedJson(detail?: string): Error {
  return new Error(
    detail
      ? `Malformed Anthropic response JSON: ${detail}`
      : 'Malformed Anthropic response JSON',
  )
}

export function assertWellFormedUtf16(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) {
        throw new Error('Tool names must contain well-formed UTF-16')
      }
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) {
        throw new Error('Tool names must contain well-formed UTF-16')
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error('Tool names must contain well-formed UTF-16')
    }
  }
}

function rawTokenLength(bytes: Uint8Array, token: TokenType): number {
  if (token === TokenType.STRING) {
    let escaped = false
    for (let index = 1; index < bytes.byteLength; index += 1) {
      const byte = bytes[index]
      if (escaped) escaped = false
      else if (byte === 0x5c) escaped = true
      else if (byte === 0x22) return index + 1
    }
    return 0
  }
  if (
    token === TokenType.LEFT_BRACE ||
    token === TokenType.RIGHT_BRACE ||
    token === TokenType.LEFT_BRACKET ||
    token === TokenType.RIGHT_BRACKET ||
    token === TokenType.COLON ||
    token === TokenType.COMMA
  ) {
    return 1
  }
  if (token === TokenType.TRUE || token === TokenType.NULL) return 4
  if (token === TokenType.FALSE) return 5
  if (token === TokenType.NUMBER) {
    let index = 0
    while (index < bytes.byteLength) {
      const byte = bytes[index]
      if (
        byte === 0x20 ||
        byte === 0x09 ||
        byte === 0x0a ||
        byte === 0x0d ||
        byte === 0x2c ||
        byte === 0x5d ||
        byte === 0x7d
      ) {
        break
      }
      index += 1
    }
    return index
  }
  return 0
}

function objectFrame(role: FrameRole): ObjectFrame {
  return {
    mode: 'object',
    state: 'key-or-end',
    role,
    typeSeen: false,
    seenType: false,
    seenName: false,
    seenContent: false,
    seenContentBlock: false,
    seenKeys: new Set(),
    retainedKeyBytes: 0,
  }
}

function isPrimitive(token: TokenType): boolean {
  return (
    token === TokenType.STRING ||
    token === TokenType.NUMBER ||
    token === TokenType.TRUE ||
    token === TokenType.FALSE ||
    token === TokenType.NULL
  )
}

export function createBoundedJsonToolNameStream(
  body: ReadableStream<Uint8Array>,
  toolPrefix: string,
  rewriteName: (name: string) => string | undefined,
): ReadableStream<Uint8Array> {
  const raw = new ByteQueue()
  const stack: Frame[] = []
  let absoluteOffset = 0
  let rootComplete = false
  let pending: PendingToken | undefined
  let outputController: TransformStreamDefaultController<Uint8Array>
  let objectKeys = 0
  let retainedKeyBytes = 0
  let nodes = 0
  let holdingOutput = false
  let heldLength = 0
  let heldChunks: Uint8Array[] = []
  let deferredNames: DeferredName[] = []

  const top = (): Frame | undefined => stack.at(-1)

  const countNode = (): void => {
    nodes += 1
    if (nodes > MAX_JSON_NODES) {
      throw new Error('Anthropic response JSON exceeds traversal limits')
    }
  }

  const rootFrame = (): ObjectFrame | undefined => {
    const root = stack[0]
    return root?.mode === 'object' && root.role === 'root' ? root : undefined
  }

  const emit = (bytes: Uint8Array): void => {
    if (bytes.byteLength === 0) return
    if (!holdingOutput) {
      outputController.enqueue(bytes)
      return
    }
    if (heldLength + bytes.byteLength > MAX_JSON_PENDING_BLOCK_BYTES) {
      throw new Error(
        `Anthropic response JSON exceeds ${MAX_JSON_PENDING_BLOCK_BYTES} byte pending-block limit`,
      )
    }
    heldChunks.push(bytes)
    heldLength += bytes.byteLength
  }

  const isSemanticToolUse = (frame: ObjectFrame, root: ObjectFrame): boolean =>
    frame.objectType === 'tool_use' &&
    ((frame.role === 'message-block' && root.objectType === 'message') ||
      (frame.role === 'content-block' &&
        root.objectType === 'content_block_start'))

  const validateToolName = (name: string): void => {
    assertWellFormedUtf16(name)
    if (encoder.encode(name).byteLength > MAX_JSON_TOOL_NAME_BYTES) {
      throw new Error(
        `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`,
      )
    }
  }

  const resolveDeferredNames = (root: ObjectFrame): void => {
    if (!holdingOutput) return
    const held = new Uint8Array(heldLength)
    let copied = 0
    for (const chunk of heldChunks) {
      held.set(chunk, copied)
      copied += chunk.byteLength
    }

    const edits: Array<{
      start: number
      end: number
      replacement: Uint8Array
    }> = []
    for (const deferred of deferredNames) {
      if (deferred.root !== root || !isSemanticToolUse(deferred.frame, root)) {
        continue
      }
      validateToolName(deferred.name)
      if (!deferred.name.startsWith(toolPrefix)) continue
      const rewritten = rewriteName(deferred.name)
      if (rewritten === undefined) continue
      edits.push({
        start: deferred.offset,
        end: deferred.offset + deferred.tokenLength,
        replacement: encoder.encode(JSON.stringify(rewritten)),
      })
    }

    let outputLength = held.byteLength
    for (const edit of edits) {
      outputLength += edit.replacement.byteLength - (edit.end - edit.start)
    }
    if (outputLength > MAX_JSON_PENDING_BLOCK_BYTES) {
      throw new Error(
        `Anthropic response JSON exceeds ${MAX_JSON_PENDING_BLOCK_BYTES} byte pending-block limit`,
      )
    }

    const output = new Uint8Array(outputLength)
    let sourceOffset = 0
    let outputOffset = 0
    for (const edit of edits.sort((left, right) => left.start - right.start)) {
      output.set(held.subarray(sourceOffset, edit.start), outputOffset)
      outputOffset += edit.start - sourceOffset
      output.set(edit.replacement, outputOffset)
      outputOffset += edit.replacement.byteLength
      sourceOffset = edit.end
    }
    output.set(held.subarray(sourceOffset), outputOffset)
    outputController.enqueue(output)
    holdingOutput = false
    heldLength = 0
    heldChunks = []
    deferredNames = []
  }

  const expectingConfirmedToolName = (): boolean => {
    const frame = top()
    const root = rootFrame()
    return (
      frame?.mode === 'object' &&
      root !== undefined &&
      isSemanticToolUse(frame, root) &&
      frame.state === 'value' &&
      frame.key === 'name'
    )
  }

  const finishPending = (nextOffset: number): void => {
    if (!pending) {
      emit(raw.takeTo(nextOffset))
      return
    }
    const segmentStart = raw.start
    const segment = raw.takeTo(nextOffset)
    const tokenStart = pending.offset - segmentStart
    if (tokenStart < 0 || tokenStart > segment.byteLength) throw malformedJson()
    if (!pending.replacement) {
      emit(segment)
      pending = undefined
      return
    }
    const tokenLength = rawTokenLength(
      segment.subarray(tokenStart),
      pending.token,
    )
    if (tokenLength === 0) throw malformedJson('missing replacement token')
    const outputLength =
      segment.byteLength - tokenLength + pending.replacement.byteLength
    if (outputLength > MAX_JSON_PENDING_BLOCK_BYTES) {
      throw new Error(
        `Anthropic response JSON exceeds ${MAX_JSON_PENDING_BLOCK_BYTES} byte rewritten-segment limit`,
      )
    }
    const output = new Uint8Array(outputLength)
    output.set(segment.subarray(0, tokenStart))
    output.set(pending.replacement, tokenStart)
    output.set(
      segment.subarray(tokenStart + tokenLength),
      tokenStart + pending.replacement.byteLength,
    )
    emit(output)
    pending = undefined
  }

  const completeValue = (): void => {
    const frame = top()
    if (!frame) {
      if (rootComplete) throw malformedJson('multiple root values')
      rootComplete = true
      return
    }
    if (frame.mode === 'object') {
      if (frame.state !== 'value') throw malformedJson('unexpected value')
      frame.state = 'comma-or-end'
      frame.key = undefined
    } else {
      if (frame.state !== 'value' && frame.state !== 'value-or-end') {
        throw malformedJson('unexpected array value')
      }
      frame.state = 'comma-or-end'
    }
  }

  const requireValuePosition = (): Frame | undefined => {
    const frame = top()
    if (!frame) {
      if (rootComplete) throw malformedJson('multiple root values')
      return undefined
    }
    if (frame.mode === 'object' && frame.state !== 'value') {
      throw malformedJson('object value is out of place')
    }
    if (
      frame.mode === 'array' &&
      frame.state !== 'value' &&
      frame.state !== 'value-or-end'
    ) {
      throw malformedJson('array value is out of place')
    }
    return frame
  }

  const containerRole = (
    parent: Frame | undefined,
    token: TokenType.LEFT_BRACE | TokenType.LEFT_BRACKET,
  ): FrameRole => {
    if (!parent) return 'root'
    if (
      parent.mode === 'array' &&
      parent.role === 'content-array' &&
      token === TokenType.LEFT_BRACE
    ) {
      return 'message-block'
    }
    if (parent.mode !== 'object' || parent.role !== 'root') return 'other'
    if (parent.key === 'content' && token === TokenType.LEFT_BRACKET) {
      return 'content-array'
    }
    if (parent.key === 'content_block' && token === TokenType.LEFT_BRACE) {
      return 'content-block'
    }
    return 'other'
  }

  const startContainer = (
    token: TokenType.LEFT_BRACE | TokenType.LEFT_BRACKET,
  ): void => {
    const parent = requireValuePosition()
    countNode()
    if (stack.length >= MAX_JSON_DEPTH) {
      throw new Error('Anthropic response JSON exceeds traversal limits')
    }
    const role = containerRole(parent, token)
    stack.push(
      token === TokenType.LEFT_BRACE
        ? objectFrame(role)
        : { mode: 'array', state: 'value-or-end', role },
    )
  }

  const recordKey = (frame: ObjectFrame, key: string): void => {
    objectKeys += 1
    if (objectKeys > MAX_JSON_OBJECT_KEYS) {
      throw new Error('Anthropic response JSON exceeds object-key limit')
    }
    if (frame.seenKeys.has(key)) {
      throw malformedJson('duplicate object key')
    }
    const keyBytes = encoder.encode(key).byteLength
    if (keyBytes > MAX_JSON_RETAINED_KEY_BYTES - retainedKeyBytes) {
      throw new Error('Anthropic response JSON exceeds retained-key byte limit')
    }
    frame.seenKeys.add(key)
    frame.retainedKeyBytes += keyBytes
    retainedKeyBytes += keyBytes
    if (frame.role === 'root') {
      if (key === 'type') {
        if (frame.seenType) throw malformedJson('duplicate root type')
        frame.seenType = true
      } else if (key === 'content') {
        if (frame.seenContent) throw malformedJson('duplicate root content')
        frame.seenContent = true
      } else if (key === 'content_block') {
        if (frame.seenContentBlock) {
          throw malformedJson('duplicate root content_block')
        }
        frame.seenContentBlock = true
      }
    } else if (
      frame.role === 'message-block' ||
      frame.role === 'content-block'
    ) {
      if (key === 'type') {
        if (frame.seenType) throw malformedJson('duplicate block type')
        frame.seenType = true
      } else if (key === 'name') {
        if (frame.seenName) throw malformedJson('duplicate block name')
        frame.seenName = true
      }
    }
    frame.key = key
    frame.state = 'colon'
  }

  const processPrimitive = (info: ParsedTokenInfo): Uint8Array | undefined => {
    const frame = requireValuePosition()
    countNode()
    let replacement: Uint8Array | undefined
    if (frame?.mode === 'object') {
      if (
        frame.key === 'type' &&
        (frame.role === 'root' ||
          frame.role === 'message-block' ||
          frame.role === 'content-block')
      ) {
        frame.typeSeen = true
        frame.objectType =
          info.token === TokenType.STRING ? String(info.value) : undefined
      }
      if (
        (frame.role === 'message-block' || frame.role === 'content-block') &&
        frame.key === 'name'
      ) {
        if (info.token === TokenType.STRING) {
          const name = String(info.value)
          const root = rootFrame()
          if (!root) throw malformedJson('tool block has no object root')
          if (frame.typeSeen && root.typeSeen) {
            if (isSemanticToolUse(frame, root)) {
              validateToolName(name)
              if (name.startsWith(toolPrefix)) {
                const rewritten = rewriteName(name)
                if (rewritten !== undefined) {
                  replacement = encoder.encode(JSON.stringify(rewritten))
                }
              }
            }
          } else {
            if (!holdingOutput) holdingOutput = true
            const source = raw.bytesFrom(info.offset)
            const tokenLength = rawTokenLength(source, info.token)
            if (tokenLength === 0) {
              throw malformedJson('missing deferred name token')
            }
            deferredNames.push({
              frame,
              root,
              offset: heldLength,
              tokenLength,
              name,
            })
          }
        }
      }
    }
    completeValue()
    return replacement
  }

  const closeContainer = (token: TokenType): void => {
    const frame = top()
    if (!frame) throw malformedJson('unexpected container close')
    const expectedMode =
      token === TokenType.RIGHT_BRACE
        ? 'object'
        : token === TokenType.RIGHT_BRACKET
          ? 'array'
          : undefined
    if (frame.mode !== expectedMode) throw malformedJson('mismatched close')
    const canClose =
      frame.mode === 'object'
        ? frame.state === 'key-or-end' || frame.state === 'comma-or-end'
        : frame.state === 'value-or-end' || frame.state === 'comma-or-end'
    if (!canClose) throw malformedJson('incomplete container')
    stack.pop()
    if (frame.mode === 'object') {
      retainedKeyBytes -= frame.retainedKeyBytes
      frame.retainedKeyBytes = 0
      frame.seenKeys.clear()
    }
    if (frame.mode === 'object' && frame.role === 'root') {
      resolveDeferredNames(frame)
    }
    completeValue()
  }

  const onToken = (info: ParsedTokenInfo): void => {
    if (info.partial) {
      const sourceBytes = absoluteOffset - info.offset
      const candidateNameBytes = expectingConfirmedToolName()
        ? encoder.encode(String(info.value)).byteLength
        : 0
      if (
        info.token === TokenType.STRING &&
        (expectingConfirmedToolName()
          ? candidateNameBytes > MAX_JSON_TOOL_NAME_BYTES
          : sourceBytes > MAX_JSON_STRING_BYTES)
      ) {
        throw new Error(
          expectingConfirmedToolName()
            ? `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`
            : `Anthropic response JSON exceeds ${MAX_JSON_STRING_BYTES} byte string limit`,
        )
      }
      if (
        info.token === TokenType.NUMBER &&
        sourceBytes > MAX_JSON_NUMBER_BYTES
      ) {
        throw new Error(
          `Anthropic response JSON exceeds ${MAX_JSON_NUMBER_BYTES} byte number limit`,
        )
      }
      return
    }

    const source = raw.bytesFrom(info.offset)
    const sourceLength = rawTokenLength(source, info.token)
    if (sourceLength === 0) throw malformedJson('incomplete token')
    if (
      info.token === TokenType.STRING &&
      sourceLength > MAX_JSON_STRING_BYTES
    ) {
      throw new Error(
        `Anthropic response JSON exceeds ${MAX_JSON_STRING_BYTES} byte string limit`,
      )
    }
    if (
      info.token === TokenType.NUMBER &&
      sourceLength > MAX_JSON_NUMBER_BYTES
    ) {
      throw new Error(
        `Anthropic response JSON exceeds ${MAX_JSON_NUMBER_BYTES} byte number limit`,
      )
    }

    finishPending(info.offset)
    pending = { offset: info.offset, token: info.token }
    const frame = top()

    if (
      info.token === TokenType.STRING &&
      frame?.mode === 'object' &&
      (frame.state === 'key-or-end' || frame.state === 'key')
    ) {
      recordKey(frame, String(info.value))
      return
    }

    if (
      info.token === TokenType.LEFT_BRACE ||
      info.token === TokenType.LEFT_BRACKET
    ) {
      startContainer(info.token)
    } else if (isPrimitive(info.token)) {
      pending.replacement = processPrimitive(info)
    } else if (info.token === TokenType.COLON) {
      if (frame?.mode !== 'object' || frame.state !== 'colon') {
        throw malformedJson('unexpected colon')
      }
      frame.state = 'value'
    } else if (info.token === TokenType.COMMA) {
      if (frame?.state !== 'comma-or-end') {
        throw malformedJson('unexpected comma')
      }
      frame.state = frame.mode === 'object' ? 'key' : 'value'
    } else if (
      info.token === TokenType.RIGHT_BRACE ||
      info.token === TokenType.RIGHT_BRACKET
    ) {
      closeContainer(info.token)
    } else {
      throw malformedJson('unexpected token')
    }
  }

  const tokenizer = new Tokenizer({
    emitPartialTokens: true,
    numberBufferSize: MAX_JSON_NUMBER_BYTES,
    stringBufferSize: 64 * 1024,
  })
  tokenizer.onToken = onToken

  const preamble: number[] = []
  let preambleChecked = false
  const feed = (chunk: Uint8Array): void => {
    for (
      let offset = 0;
      offset < chunk.byteLength;
      offset += TOKENIZER_SLICE_BYTES
    ) {
      const slice = chunk.subarray(
        offset,
        Math.min(offset + TOKENIZER_SLICE_BYTES, chunk.byteLength),
      )
      raw.append(slice)
      absoluteOffset += slice.byteLength
      tokenizer.write(slice)
      if (raw.size > MAX_JSON_STRING_BYTES + TOKENIZER_SLICE_BYTES * 2) {
        throw new Error('Anthropic response JSON exceeds bounded token buffer')
      }
    }
  }
  const rejectBom = (): void => {
    if (preamble[0] === 0xef && preamble[1] === 0xbb && preamble[2] === 0xbf) {
      throw malformedJson('UTF-8 BOM is not accepted')
    }
  }
  const accept = (chunk: Uint8Array): void => {
    let offset = 0
    if (!preambleChecked) {
      while (preamble.length < 3 && offset < chunk.byteLength) {
        preamble.push(chunk[offset++] ?? 0)
      }
      if (preamble.length < 3) return
      rejectBom()
      preambleChecked = true
      feed(Uint8Array.from(preamble))
      preamble.length = 0
    }
    feed(chunk.subarray(offset))
  }

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        outputController = controller
      },
      transform(chunk) {
        accept(chunk)
      },
      flush() {
        if (!preambleChecked) {
          rejectBom()
          preambleChecked = true
          feed(Uint8Array.from(preamble))
          preamble.length = 0
        }
        tokenizer.end()
        if (!rootComplete || stack.length > 0 || !pending) {
          throw new Error('Malformed or truncated Anthropic response JSON')
        }
        finishPending(absoluteOffset)
        if (raw.size !== 0) throw malformedJson('unflushed bytes')
      },
    }),
  )
}
