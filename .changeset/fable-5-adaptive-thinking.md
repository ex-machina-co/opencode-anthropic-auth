---
"@ex-machina/opencode-anthropic-auth": minor
---

Add support for Claude Fable 5 / Mythos 5 (adaptive-thinking-only models). These models reject `thinking: { type: "disabled" }` with a `400 invalid_request_error`, which OpenCode (or a user's "no-thinking" model variant) can send — breaking every request. The plugin now drops the unsupported disabled `thinking` block for models matching the `claude-fable-` / `claude-mythos-` ID prefixes so the request succeeds with the model's default adaptive thinking. Enabled thinking and unset thinking are passed through unchanged, and non-adaptive models (Opus/Sonnet/Haiku) are never touched.
