---
"@ex-machina/opencode-anthropic-auth": patch
---

Re-read auth before token refresh to avoid using a stale refresh token snapshot when token rotation occurs between requests.
