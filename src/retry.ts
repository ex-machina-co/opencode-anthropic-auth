export type RetryDecision = { retry: false } | { retry: true; delay: number }

/** Matches the bound the 429 diagnostic applies before it trusts a `retry-after`. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * OpenCode caps a provider-requested retry delay at 15 minutes, so a limit that
 * clears later can never recover. Wait as long as Anthropic asked instead.
 */
export function honorRetryAfter(
  decision: RetryDecision,
  retryAfterMs: number | undefined,
): RetryDecision {
  if (!decision.retry || retryAfterMs === undefined) return decision
  if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) return decision
  const delay = Math.min(Math.ceil(retryAfterMs), MAX_RETRY_AFTER_MS)
  return delay > decision.delay ? { retry: true, delay } : decision
}
