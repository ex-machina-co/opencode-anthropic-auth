---
'@ex-machina/opencode-anthropic-auth': patch
---

Update the bundled Claude Code version to 2.1.280. When Anthropic returns the exact structured `claude_code_version_too_old` rejection with a newer real minimum, OpenCode v2 now uses that version consistently in the User-Agent and billing metadata and retries the initial request once. Explicit version overrides, malformed responses, unrelated HTTP 400 errors, and rate limits do not activate recovery.
