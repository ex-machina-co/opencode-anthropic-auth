import { describe, expect, test } from 'bun:test'
import {
  BodyLimitError,
  contentLength,
  InvalidUtf8Error,
  readBoundedText,
} from '../bounded'

const encoder = new TextEncoder()

function body(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

describe('contentLength', () => {
  test('accepts safe decimal lengths only', () => {
    expect(contentLength(new Headers({ 'content-length': '42' }))).toBe(42)
    expect(
      contentLength(new Headers({ 'content-length': '-1' })),
    ).toBeUndefined()
    expect(
      contentLength(new Headers({ 'content-length': '1.5' })),
    ).toBeUndefined()
    expect(contentLength(new Headers())).toBeUndefined()
  })
})

describe('readBoundedText', () => {
  test('decodes UTF-8 split across chunks', async () => {
    const bytes = encoder.encode('Привет 🚀')
    expect(
      await readBoundedText(
        body([bytes.slice(0, 3), bytes.slice(3, 11), bytes.slice(11)]),
        bytes.byteLength,
        'test body',
      ),
    ).toBe('Привет 🚀')
  })

  test('rejects a chunked body above the byte limit', async () => {
    await expect(
      readBoundedText(
        body([encoder.encode('123'), encoder.encode('45')]),
        4,
        'test body',
      ),
    ).rejects.toEqual(new BodyLimitError('test body', 4))
  })

  test('rejects malformed UTF-8', async () => {
    await expect(
      readBoundedText(body([Uint8Array.of(0xc3, 0x28)]), 10, 'test body'),
    ).rejects.toEqual(new InvalidUtf8Error('test body'))
  })

  test('cancels the source after malformed UTF-8', async () => {
    let cancelled = false
    const malformed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(0xc3, 0x28))
      },
      cancel() {
        cancelled = true
      },
    })

    await expect(readBoundedText(malformed, 10, 'test body')).rejects.toEqual(
      new InvalidUtf8Error('test body'),
    )
    expect(cancelled).toBe(true)
  })
})
