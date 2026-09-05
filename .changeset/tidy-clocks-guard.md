---
'@ex-machina/opencode-anthropic-auth': patch
---

Harden OAuth refresh rotation, request and response body handling, reversible tool-name aliases, and privacy-safe HTTP 429 diagnostics. Refresh requests are single-attempt and deduplicated across plugin instances so a potentially consumed rotating token is never replayed after an ambiguous failure.
