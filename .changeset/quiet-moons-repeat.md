---
'@ex-machina/opencode-anthropic-auth': patch
---

Carry the reported Claude Code version bump (`2.1.87` → `2.1.258`) into the v2 release line. Anthropic gates model access on this value server-side, so newer models were rejected with a 400 `claude_code_version_too_old`: "Claude Code 2.1.87 does not support this model; version 2.1.251 or newer is required". `USER_AGENT` is derived from `CLAUDE_CODE_VERSION` instead of repeating the version in a second literal, so future bumps only need to change one constant.

The code already reached `v2/main`, but its original changeset was consumed by the v1.8.2 release on `main`, so this restates the release note for the v2 changelog.
