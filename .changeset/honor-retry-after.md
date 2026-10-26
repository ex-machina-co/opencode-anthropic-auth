---
'@ex-machina/opencode-anthropic-auth': patch
---

Honor Anthropic's `retry-after` beyond OpenCode v2's 15-minute retry cap. OpenCode clamps a provider-requested retry delay to 15 minutes, so a rate limit that clears later was retried too early, failed again, and exhausted its attempts without the turn ever recovering. The v2 plugin now registers a `session.retry` hook for the Anthropic provider and raises the delay to `retryAfterMs` from the recorded 429, bounded to the same 24 hours the rate-limit diagnostic accepts. A delay that is already longer, a non-retry decision, and another provider are left unchanged.
