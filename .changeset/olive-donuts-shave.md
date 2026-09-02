---
'@ex-machina/opencode-anthropic-auth': patch
---

Bump the reported Claude Code version from `2.1.87` to `2.1.258`. Anthropic gates model access on this value server-side, so newer models were rejected with a 400 `claude_code_version_too_old`: "Claude Code 2.1.87 does not support this model; version 2.1.251 or newer is required". `USER_AGENT` is now derived from `CLAUDE_CODE_VERSION` instead of repeating the version in a second literal, so future bumps only need to change one constant.
