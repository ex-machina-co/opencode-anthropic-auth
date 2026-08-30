---
"@ex-machina/claude-subscription-server": minor
---

Add `@ex-machina/claude-subscription-server`: a standalone Bun server that impersonates Claude Code on the wire so a Claude Pro/Max OAuth subscription can back an OpenAI-compatible API (`POST /v1/chat/completions` with streaming, tool calling, and request-scoped `reasoning_effort`; live `GET /v1/models`). All upstream models are accepted by default, with an optional `CLAUDE_MODELS` restriction and static fallback. Ships its own PKCE `login` subcommand and reuses the plugin's OAuth machinery (`src/auth.ts`, `src/pkce.ts`).
