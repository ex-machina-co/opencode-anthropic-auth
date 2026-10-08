---
"@ex-machina/opencode-anthropic-auth": patch
---

Raise the request body limit from 10 MiB to 32 MiB to match the Anthropic Messages API, so image-heavy sessions are no longer rejected before they reach Anthropic.
