---
"@ex-machina/opencode-anthropic-auth": minor
---

Add system prompt sanitization and CCH hash computation for Max subscription compatibility. Moves system prompt handling from the plugin hook into the request body layer, surgically removing the OpenCode identity section and prepending Claude Code identity. Computes a content-binding fingerprint (CCH) from the first user message to include in the cc_version string.
