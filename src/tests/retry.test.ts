import { describe, expect, test } from 'bun:test'
import {
  honorRetryAfter,
  MAX_RETRY_AFTER_MS,
  type RetryDecision,
} from '../retry'

const hostDelay: RetryDecision = { retry: true, delay: 15 * 60_000 }

describe('provider retry-after', () => {
  test('waits longer than the host cap when the provider asks for it', () => {
    expect(honorRetryAfter(hostDelay, 3_995_000)).toEqual({
      retry: true,
      delay: 3_995_000,
    })
  })

  test('keeps a host delay that is already longer', () => {
    expect(honorRetryAfter(hostDelay, 60_000)).toBe(hostDelay)
  })

  test('keeps a non-retry decision', () => {
    const stop: RetryDecision = { retry: false }
    expect(honorRetryAfter(stop, 3_995_000)).toBe(stop)
  })

  test('ignores a missing, invalid, or negative retry-after', () => {
    expect(honorRetryAfter(hostDelay, undefined)).toBe(hostDelay)
    expect(honorRetryAfter(hostDelay, Number.NaN)).toBe(hostDelay)
    expect(honorRetryAfter(hostDelay, Number.POSITIVE_INFINITY)).toBe(hostDelay)
    expect(honorRetryAfter(hostDelay, -1)).toBe(hostDelay)
  })

  test('bounds the wait at the 429 diagnostic bound', () => {
    expect(honorRetryAfter(hostDelay, MAX_RETRY_AFTER_MS + 1)).toEqual({
      retry: true,
      delay: MAX_RETRY_AFTER_MS,
    })
  })

  test('rounds a fractional delay up', () => {
    expect(honorRetryAfter(hostDelay, 900_000.4)).toEqual({
      retry: true,
      delay: 900_001,
    })
  })
})
