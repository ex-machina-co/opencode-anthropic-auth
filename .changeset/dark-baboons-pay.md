---
"@ex-machina/opencode-anthropic-auth": minor
---

Add system prompt sanitization for Max subscription compatibility. Moves system prompt handling from the plugin hook into the request body layer, surgically removing the OpenCode identity section and prepending Claude Code identity. Preserves user-configured instructions from config.json.
