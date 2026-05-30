# opencode-anthropic-auth

> [!WARNING]
> This plugin comes with no guarantees. You might be banned for breaking the TOS, you might not be. I don't work at Anthropic, nor am I an attorney.
>
> Use your best judgment and don't abuse your subscription.

Fork of [ex-machina-co/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth).

An [OpenCode](https://github.com/anomalyco/opencode) plugin that provides Anthropic OAuth authentication, enabling Claude Pro/Max users to use their subscription directly with OpenCode.

## Install

Add to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@sahiljassal/opencode-anthropic-auth"]
}
```

## Authentication Methods

- **Claude Pro/Max** — OAuth flow via `claude.ai`. Uses your existing subscription at no additional API cost.
- **Create an API Key** — OAuth flow via `console.anthropic.com` that creates an API key on your behalf.
- **Manually enter API Key** — Standard API key entry.

## Prompt Caching

This fork applies **hybrid 1-hour ephemeral prompt caching** on every request:

- Strips any existing `cache_control` blocks from the request
- Anchors a `1h` ephemeral cache on the last system block (after identity) and the first two user messages

This reduces token usage and latency on repeated requests by reusing cached prompt prefixes.

## Configuration

| Variable | Description |
|---|---|
| `ANTHROPIC_BASE_URL` | Override API endpoint URL (e.g. for proxying). Must be a valid HTTP(S) URL. |
| `ANTHROPIC_INSECURE` | Set to `1` or `true` to skip TLS verification. Only effective with `ANTHROPIC_BASE_URL`. |

## License

MIT
