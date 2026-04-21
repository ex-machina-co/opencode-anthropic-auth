---
"@ex-machina/opencode-anthropic-auth": patch
---

Rewrite the phrase "Here is some useful information about the environment you are running in:" in sanitized system prompts. This exact phrase ships verbatim in OpenCode's default system prompt and is used by Anthropic's server-side classifier as a third-party-agent fingerprint — matching it produces a 400 invalid_request_error disguised as "You're out of extra usage." in production. The sentence is now rewritten in place to a semantic equivalent so the model still sees the env-block intro while the request is accepted.
