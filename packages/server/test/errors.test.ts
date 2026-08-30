import { describe, expect, test } from 'bun:test'
import {
  SUBSCRIPTION_GATE_ERROR_MESSAGE,
  translateUpstreamError,
} from '../src/openai/errors.ts'

describe('translateUpstreamError', () => {
  test('turns Anthropic opaque subscription-gate 429 into an actionable error', () => {
    expect(
      translateUpstreamError(
        429,
        JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Error' },
        }),
      ),
    ).toEqual({
      error: {
        message: SUBSCRIPTION_GATE_ERROR_MESSAGE,
        type: 'rate_limit_error',
        code: 'rate_limit_error',
      },
    })
  })

  test('preserves informative upstream errors and handles non-JSON bodies', () => {
    expect(
      translateUpstreamError(
        400,
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: 'reserved keyword',
          },
        }),
      ),
    ).toEqual({
      error: {
        message: 'reserved keyword',
        type: 'invalid_request_error',
        code: 'invalid_request_error',
      },
    })
    expect(translateUpstreamError(502, 'proxy exploded')).toEqual({
      error: {
        message: 'proxy exploded',
        type: 'upstream_error',
        code: 'upstream_error',
      },
    })
  })
})
