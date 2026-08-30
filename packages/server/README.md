# @ex-machina/claude-subscription-server

Turn a Claude Pro/Max subscription into an OpenAI-compatible API server. Any agent
framework that speaks the OpenAI chat-completions API (with tool calling and
streaming) can run on your subscription instead of API keys.

> [!WARNING]
> This comes with no guarantees. You might be banned for breaking the TOS, you might
> not be. The author doesn't work at Anthropic, nor is an attorney. Use your best
> judgment and don't abuse the subscription (no Ralph loops, no heavy batch usage).

## How it works

The OAuth token ties usage to your Pro/Max subscription. The server also
reproduces Claude Code 2.1.236's wire envelope — headers, beta flags, and a
3-block system prompt containing both accepted subscription-gate markers. It
accepts OpenAI `/v1/chat/completions` requests, translates them to Anthropic
`/v1/messages`, and translates the streamed response back (including `thinking`
blocks → `reasoning_content` and streamed tool-call argument fragments).

See [docs/protocol-mapping.md](docs/protocol-mapping.md) for the traced wire
format, subscription-gate bisection matrix, SSE taxonomy, OAuth refresh flow,
and the cert-free re-tracing procedure.

## Setup

Requires [Bun](https://bun.sh) >= 1.3.14.

```bash
# from the repo root (bun workspaces links the package)
bun install

# log in with your Claude Pro/Max account (browser OAuth, PKCE)
bun run --cwd packages/server login
# or, once linked/installed:
claude-subscription-server login
```

Credentials are stored at `~/.config/claude-subscription-server/auth.json`
(file mode 600): access/refresh tokens, expiry, a generated `device_id`, and a
stable `account_uuid`. Tokens rotate on refresh and are persisted automatically.

## Run

```bash
export SERVER_API_KEY="$(openssl rand -hex 32)"

claude-subscription-server
# or
bun run --cwd packages/server start
```

`SERVER_API_KEY` is required when starting the HTTP server. It is never
generated or printed by the process; keep the same value available to each
local client that needs to authenticate. The `login` subcommand does not
require this variable.

Then point any OpenAI SDK at the server:

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8080/v1",
    api_key=os.environ["SERVER_API_KEY"],
)
resp = client.chat.completions.create(
    model="claude-opus-5",
    messages=[{"role": "user", "content": "hello"}],
)
```

## Endpoints

- `POST /v1/chat/completions` — chat, tool calling, `stream: true/false`
  (`reasoning_content` is populated from interleaved thinking blocks)
- `GET /v1/models` — live upstream OAuth model catalog, with `CLAUDE_MODELS`
  fallback
- `GET /healthz` — unauthenticated liveness check

All upstream model IDs are accepted by default. Set `CLAUDE_MODELS` only when
you want an explicit comma-separated restriction; the same restriction is then
applied to `/v1/models`.

## Thinking effort

Use the OpenAI Chat Completions `reasoning_effort` field to override thinking
effort for one request. Supported values are `low`, `medium`, `high`, `xhigh`,
and `max`:

```bash
curl -sS http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $SERVER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-fable-5",
    "reasoning_effort": "xhigh",
    "messages": [{"role": "user", "content": "Solve this carefully: ..."}],
    "stream": false
  }'
```

If the request omits `reasoning_effort`, the server uses `CC_EFFORT` (`high` by
default). Unsupported values return an OpenAI-style 400 before any upstream
request. Anthropic can still impose model-specific effort constraints; those
upstream errors are returned in the normal OpenAI error envelope.

## Pi coding agent

[Pi](https://github.com/earendil-works/pi) can use the server as a custom
OpenAI Chat Completions provider. Pi's model registry is static, so its
`~/.pi/agent/models.json` must name each model that should appear in `/model`,
even though this server itself accepts every non-empty upstream model ID.

First use one shared local bearer key in the server process:

```bash
export CLAUDE_SUBSCRIPTION_SERVER_API_KEY='replace-with-a-local-secret'
SERVER_API_KEY="$CLAUDE_SUBSCRIPTION_SERVER_API_KEY" \
  bun run --cwd packages/server start
```

If port `8080` is already occupied, choose another port in both places—for
example, start with `PORT=18081` and change the Pi provider's `baseUrl` to
`http://127.0.0.1:18081/v1`.

Then add the `claude-subscription` provider from
[`docs/pi-models.example.json`](docs/pi-models.example.json) under the existing
top-level `providers` object in `~/.pi/agent/models.json`. The complete example
contains all 10 models observed in the upstream catalog and preserves Pi's
model-specific context/output limits. On a new Pi installation with no custom
models yet, it can be installed directly:

```bash
mkdir -p ~/.pi/agent
install -m 600 packages/server/docs/pi-models.example.json \
  ~/.pi/agent/models.json
```

If `models.json` already contains providers, merge only the example's
`claude-subscription` entry instead of replacing the file. One safe `jq` flow
is:

```bash
cp -p ~/.pi/agent/models.json \
  ~/.pi/agent/models.json.backup-$(date +%Y%m%d-%H%M%S)

tmp="$(mktemp)"
jq --slurpfile addition packages/server/docs/pi-models.example.json \
  '.providers = ((.providers // {}) + $addition[0].providers)' \
  ~/.pi/agent/models.json > "$tmp" &&
  install -m 600 "$tmp" ~/.pi/agent/models.json
rm -f "$tmp"
```

The example uses Pi's environment-variable interpolation:

```json
{
  "apiKey": "$CLAUDE_SUBSCRIPTION_SERVER_API_KEY"
}
```

Therefore the same variable must also be available to the Pi process. Start Pi
from a shell that exports it, then select a model and thinking level:

```bash
export CLAUDE_SUBSCRIPTION_SERVER_API_KEY='replace-with-the-same-local-secret'

pi --model claude-subscription/claude-sonnet-5 --thinking high

# Equivalent shorthand, including extended effort where the model supports it:
pi --model claude-subscription/claude-sonnet-5:xhigh

# Non-interactive smoke test:
pi --no-session \
  --model claude-subscription/claude-sonnet-5 \
  --thinking low \
  -p 'Reply with exactly: PI_OK'
```

The provider configuration deliberately sets:

- `api: "openai-completions"` for `/v1/chat/completions` streaming;
- `supportsDeveloperRole: false` so Pi sends the system prompt with the role
  this compatibility server understands;
- `supportsReasoningEffort: true` so `--thinking` becomes
  `reasoning_effort`;
- `maxTokensField: "max_tokens"` to match the request schema; and
- zero monetary cost metadata because Pi cannot infer subscription pricing
  (requests still consume subscription quota).

`off` and `minimal` are hidden because the server uses adaptive thinking and
Anthropic's effort field does not accept those values. Every configured model
offers `low`, `medium`, and `high`; `xhigh`/`max` are exposed only where Pi's
current Anthropic catalog marks them supported. Opening Pi's `/model` picker
reloads `models.json`; a Pi restart is not required after edits. See Pi's
[custom-model documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
for the full configuration schema.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `SERVER_API_KEY` | required | Bearer key clients must send; server startup fails when it is missing or blank |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | HTTPS upstream API base; plaintext HTTP is accepted only for loopback debug proxies (`localhost`, `127.0.0.0/8`, or `[::1]`) |
| `CREDENTIALS_PATH` | `~/.config/claude-subscription-server/auth.json` | Credentials file path |
| `CLAUDE_MODELS` | unset (allow all) | Optional restriction and static `/v1/models` fallback override |
| `CC_VERSION` | `2.1.236` | Claude Code version to impersonate |
| `CC_EFFORT` | `high` | Default effort: `low`, `medium`, `high`, `xhigh`, or `max` |

The server binds to `127.0.0.1` only. If you expose it beyond localhost, protect
it — anyone with the key burns your subscription quota.

## Notes

- `parallel_tool_calls: false` maps to Anthropic `disable_parallel_tool_use`.
- OpenAI `reasoning_effort` maps to Anthropic `output_config.effort` and
  overrides `CC_EFFORT` for that request.
- Consecutive OpenAI `role: "tool"` messages are merged into a single Anthropic
  user message with `tool_result` blocks.
- System messages after the first non-system message are sent as mid-conversation
  `role: "system"` messages (via the `mid-conversation-system-2026-04-07` beta).
  Such a system section must immediately follow a user turn and must be final
  or immediately followed by an assistant turn; unsupported ordering and
  unsupported message roles return an OpenAI-style 400.
- Anthropic cache-creation and cache-read input tokens are included in
  `prompt_tokens` and `total_tokens`; cache reads are also reported as
  `prompt_tokens_details.cached_tokens`.
- Cancelling a streaming response cancels its upstream Anthropic reader, so a
  disconnected client does not leave the subscription request running.
- Anthropic's opaque `429 rate_limit_error` with message `Error` is reported as
  a subscription system-prompt gate diagnostic instead of being passed through
  without context.

## License

MIT
