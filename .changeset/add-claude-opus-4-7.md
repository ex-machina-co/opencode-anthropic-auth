---
"@ex-machina/opencode-anthropic-auth": minor
---

Add Claude Opus 4.7 to the model selection list via a new `provider` hook. The plugin now injects `claude-opus-4-7` into the Anthropic provider's model map if it's not already present in OpenCode's bundled models.dev snapshot, so users can select the newly released model without waiting for an OpenCode update.
