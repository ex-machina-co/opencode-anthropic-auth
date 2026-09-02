import { describe, expect, test } from 'bun:test'
import {
  inspectStream,
  isFailoverStatus,
  textIndicatesContent,
  textIndicatesFailover,
} from '../failover'

describe('isFailoverStatus', () => {
  test('429/401/403/529 trigger failover', () => {
    for (const s of [429, 401, 403, 529]) {
      expect(isFailoverStatus(s)).toBe(true)
    }
  })
  test('200/400/500 do not', () => {
    for (const s of [200, 400, 500]) {
      expect(isFailoverStatus(s)).toBe(false)
    }
  })
})

describe('textIndicatesFailover', () => {
  test('detects SSE rate_limit_error event', () => {
    const sse =
      'event: error\n' +
      'data: {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your limit"}}\n\n'
    expect(textIndicatesFailover(sse)).toBe(true)
  })

  test('detects overloaded_error', () => {
    const sse =
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
    expect(textIndicatesFailover(sse)).toBe(true)
  })

  test('detects bare JSON rate limit body', () => {
    const body =
      '{"type":"error","error":{"type":"rate_limit_error","message":"quota exceeded"}}'
    expect(textIndicatesFailover(body)).toBe(true)
  })

  test('detects usage-limit message even with generic type', () => {
    const body =
      '{"type":"error","error":{"type":"api_error","message":"You have reached your usage limit. Try again later."}}'
    expect(textIndicatesFailover(body)).toBe(true)
  })

  test('does NOT flag a normal message_start event', () => {
    const sse =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}\n\n'
    expect(textIndicatesFailover(sse)).toBe(false)
  })

  test('does NOT flag empty text', () => {
    expect(textIndicatesFailover('')).toBe(false)
  })

  test('handles a truncated first chunk with a limit type', () => {
    // Simulates only the first bytes of an error event arriving.
    const partial =
      'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","mess'
    expect(textIndicatesFailover(partial)).toBe(true)
  })
})

describe('textIndicatesContent', () => {
  test('true for content_block events', () => {
    expect(
      textIndicatesContent('event: content_block_start\ndata: {}\n\n'),
    ).toBe(true)
    expect(
      textIndicatesContent(
        'event: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\n',
      ),
    ).toBe(true)
  })
  test('false for message_start alone (an error may still follow)', () => {
    expect(
      textIndicatesContent(
        'event: message_start\ndata: {"type":"message_start"}\n\n',
      ),
    ).toBe(false)
  })
})

describe('inspectStream', () => {
  function streamFrom(parts: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let i = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < parts.length) {
          controller.enqueue(encoder.encode(parts[i]!))
          i += 1
        } else {
          controller.close()
        }
      },
    })
  }

  test('flags an error that appears AFTER message_start (mid-stream)', async () => {
    // The critical case: a good-looking start, then a rate-limit error before
    // any content is produced.
    const body = streamFrom([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n',
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"usage limit reached"}}\n\n',
    ])
    const { isError, stream } = await inspectStream(body)
    expect(isError).toBe(true)
    // Stream is still fully replayable (we didn't lose bytes).
    const full = await new Response(stream).text()
    expect(full).toContain('message_start')
    expect(full).toContain('rate_limit_error')
  })

  test('commits (no error) once content starts and replays everything', async () => {
    const body = streamFrom([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n',
    ])
    const { isError, stream } = await inspectStream(body)
    expect(isError).toBe(false)
    const full = await new Response(stream).text()
    expect(full).toContain('content_block_delta')
    expect(full).toContain('hello')
  })

  test('flags an immediate error event', async () => {
    const body = streamFrom([
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ])
    const { isError } = await inspectStream(body)
    expect(isError).toBe(true)
  })
})
