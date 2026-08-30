# Claude Code subscription protocol mapping

This document records the wire behavior observed from **Claude Code 2.1.236 in
`claude -p` (`sdk-cli`) mode on 2026-08-29**, plus direct request-bisection
results against Anthropic's OAuth-backed subscription API. It is empirical,
not a public Anthropic contract; re-trace after Claude Code or upstream API
changes.

The server implementation lives in:

- [`../src/claude/wire.ts`](../src/claude/wire.ts) — traced request envelope and
  subscription-gate markers
- [`../src/claude/client.ts`](../src/claude/client.ts) — message transport
- [`../src/openai/translate.ts`](../src/openai/translate.ts) — OpenAI request to
  Anthropic message translation
- [`../src/openai/stream.ts`](../src/openai/stream.ts) — Anthropic SSE to OpenAI
  response translation

## Executive findings

1. **The OAuth access token selects subscription billing.** The Claude-looking
   headers are not what associates usage with a Pro/Max subscription.
2. **There is a separate system-prompt admission gate.** A request must contain
   either:
   - a well-formed billing marker shaped like
     `x-anthropic-billing-header: cc_version=...; cc_entrypoint=...;`, or
   - the exact identity string
     `You are a Claude agent, built on Anthropic's Claude Agent SDK.`
3. Missing both markers repeatedly returned an opaque `429 rate_limit_error`
   whose message was only `Error` and whose headers included
   `x-should-retry: true`. An empty billing-marker value instead returned a
   `400 invalid_request_error` saying the marker is a reserved keyword.
4. The tested billing-marker values were not validated. Alternate version and
   entrypoint values passed as long as the marker retained an accepted shape.
5. The Claude-looking user agent, `x-app`, beta header, Stainless headers,
   Claude session ID, `?beta=true`, and `metadata.user_id` were individually
   unnecessary for admission in the tested request. The server keeps the
   traced envelope for camouflage and feature compatibility, but both system
   markers are the important defensive invariant.

These findings distinguish **billing/authentication** (the OAuth token) from
the **subscription client gate** (system-prompt content). They do not imply
that every beta header is irrelevant to every optional API feature.

## Message request wire format

### Endpoint

```text
POST https://api.anthropic.com/v1/messages?beta=true
```

The `?beta=true` query was present in every Claude Code trace. Removing it did
not change the small bisection request's result.

### Observed headers

| Header | Claude Code 2.1.236 value | Bisection result / role |
|---|---|---|
| `authorization` | `Bearer <OAuth access token>` | Credential that selects the subscription; not camouflage. |
| `anthropic-version` | `2023-06-01` | Normal Anthropic API version header; not removed in the bisection. |
| `content-type` | `application/json` | Normal POST transport header. |
| `accept` | `application/json` | Normal response negotiation. |
| `anthropic-beta` | See the exact list below. | Removing it, or reducing it to `oauth-2025-04-20`, still passed the tested request. Individual features may still depend on their beta. |
| `anthropic-dangerous-direct-browser-access` | `true` | Observed on the wire; not independently removed in the bisection. |
| `user-agent` | `claude-cli/2.1.236 (external, sdk-cli)` | Generic or absent user agent passed. |
| `x-app` | `cli` | Absence passed. |
| `x-claude-code-session-id` | UUID | Absence passed. |
| `x-stainless-*` | SDK/runtime metadata | Removing the whole family passed. |

The observed beta header contained 12 comma-separated flags:

```text
claude-code-20250219,
oauth-2025-04-20,
context-1m-2025-08-07,
interleaved-thinking-2025-05-14,
thinking-token-count-2026-05-13,
context-management-2025-06-27,
prompt-caching-scope-2026-01-05,
mid-conversation-system-2026-04-07,
advisor-tool-2026-03-01,
effort-2025-11-24,
fallback-credit-2026-06-01,
extended-cache-ttl-2025-04-11
```

The observed Stainless fields were:

```text
x-stainless-arch: arm64
x-stainless-lang: js
x-stainless-os: MacOS
x-stainless-package-version: 0.112.1
x-stainless-retry-count: 0
x-stainless-runtime: node
x-stainless-runtime-version: v26.3.0
x-stainless-timeout: 600
```

They describe the traced machine/runtime, not values required by the
subscription gate.

### Three-block system prompt

Claude Code sent three text blocks in this order:

```json
[
  {
    "type": "text",
    "text": "x-anthropic-billing-header: cc_version=2.1.236.2f1; cc_entrypoint=sdk-cli;"
  },
  {
    "type": "text",
    "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    "cache_control": { "type": "ephemeral", "ttl": "1h" }
  },
  {
    "type": "text",
    "text": "<main Claude Code system prompt>",
    "cache_control": { "type": "ephemeral", "ttl": "1h" }
  }
]
```

The `.2f1` suffix above is what the saved wire requests contained. Other
instrumentation and the server implementation used a `.761` suffix, and direct
bisection accepted unrelated version and entrypoint values. Treat the field
shape—not that suffix—as the stable observation.

The first block had no `cache_control`. The identity and main-prompt blocks used
one-hour ephemeral caching. The server emits the first two blocks even when an
OpenAI caller supplies no system message; it adds the third only when there is
caller system content.

### Body fields and extras

The traced top-level body contained:

| Field | Observed value / shape | Server behavior |
|---|---|---|
| `model` | `claude-opus-5` | Uses any non-empty OpenAI request model by default; an explicit `CLAUDE_MODELS` list restricts it. |
| `messages` | Anthropic user/assistant/system messages with content blocks | Translated from OpenAI messages. |
| `system` | Three blocks described above | Always sends billing + identity; appends caller system prompt when present. |
| `tools` | `{name, description, input_schema}` objects with ordinary Claude Code tool names | Translated from OpenAI function tools; no plugin-specific `mcp_` prefix. |
| `metadata.user_id` | JSON **string** containing `device_id`, `account_uuid`, and `session_id` | Reproduced for trace compatibility; bisection showed it was not needed for admission. |
| `max_tokens` | `64000` | Same default, overridable by the OpenAI request. |
| `thinking` | `{ "type": "adaptive", "display": "omitted" }` | Reproduced. |
| `context_management` | `{ "edits": [{ "type": "clear_thinking_20251015", "keep": "all" }] }` | Claude Code internal behavior; intentionally not emitted by this server. |
| `output_config` | `{ "effort": "xhigh" }` in the trace | OpenAI `reasoning_effort` overrides the request; otherwise the server uses `CC_EFFORT` (`high` by default). |
| `stream` | `true` | Always requests Anthropic SSE, then either streams or collects for the OpenAI caller. |

Claude Code also emitted mid-conversation `role: "system"` messages. The server
preserves OpenAI system messages that occur after the first non-system message,
using the `mid-conversation-system-2026-04-07` behavior. Anthropic constrains a
mid-conversation system section to immediately follow a user turn (or an
assistant turn ending in a server-tool result) and to be either final or
immediately followed by an assistant turn. Consecutive system messages are
treated as one system section. Because the OpenAI input translated here has no
representation for Anthropic server-tool-result assistant turns, the server
implements the user-turn subset and rejects unsupported ordering with a 400.
See Anthropic's
[mid-conversation system-message documentation](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)
for the upstream contract.

### Thinking effort levels

The OpenAI-compatible request field is `reasoning_effort`. The server maps it
directly to Anthropic `output_config.effort`. The accepted intersection for this
provider is:

```text
low, medium, high, xhigh, max
```

The field name follows the
[OpenAI Chat Completions request shape](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2),
while the accepted values follow Anthropic's current
[`OutputConfig.effort` type](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts).

`CC_EFFORT` supplies the default when a request omits the field. Both startup
configuration and request overrides are validated. Values such as `none` and
`minimal`, which some OpenAI models accept, are deliberately rejected rather
than silently changing their meaning because they are not Anthropic
`OutputConfig.effort` values. The server continues to send
`thinking: {type: "adaptive", display: "omitted"}` at every level. Anthropic
may still enforce model-specific effort constraints; the compatibility layer
does not pretend that every model supports every level.

## Bisection matrix

The baseline used a fresh OAuth access token, `claude-opus-5`, `max_tokens: 16`,
a tiny user message, the full Claude Code-style headers, and the three system
blocks. Most cases used `stream: false` to make status/body comparison simple.
Requests were spaced to avoid accidental burst behavior.

| Variant | Result | Finding |
|---|---:|---|
| Full baseline | `200` | Known-good control. |
| Remove `?beta=true` | `200` | Query marker was not required for this request. |
| Keep only `oauth-2025-04-20` beta | `200` | Full beta list was not required for this request. |
| Remove `anthropic-beta` | `200` | Beta header was not part of the admission gate. |
| Generic user agent | `200` | Claude CLI user agent was not required. |
| Remove user agent | `200` | Same conclusion. |
| Remove `x-app` | `200` | Not required. |
| Remove all `x-stainless-*` | `200` | Not required. |
| Remove `x-claude-code-session-id` | `200` | Not required. |
| Remove `metadata` | `200` | `metadata.user_id` was not required. |
| Remove `thinking` and `output_config` | `200` | Neither field was part of the gate. |
| Identity + plain prompt; no billing block | `200` | Exact identity alone satisfies the gate. |
| Billing block + plain prompt; no identity | `200` | Well-formed billing block alone satisfies the gate. |
| Billing block only | `200` | A main prompt and identity were not required for admission. |
| Exact identity only | `200` | Billing block was not required when exact identity was present. |
| Plain system prompt only | `429`, repeated 3/3 | Missing both accepted markers deterministically failed. |
| No `system` field | `429` | Missing both accepted markers failed. |
| Empty system array | `429` | Missing both accepted markers failed. |
| Shortened `You are a Claude agent.` phrase | `429` | A partial identity did not match. |
| Older/general Claude Code identity wording | `429` | The tested alternate identity did not match. |
| Empty `x-anthropic-billing-header:` value | `400` | Reserved keyword is recognized and malformed use is rejected. |
| Version changed to `9.9.9.999` | `200` | Version value was not validated. |
| Entrypoint changed to `cli` | `200` | Entrypoint value was not validated. |
| Alternate shaped version `1.0.0.0` | `200` | Values may vary; retain the key/value/semicolon structure. |
| Billing marker supplied as a string system prompt | `200` | Gate searches system content, not only the traced block array layout. |

The opaque failing response was:

```json
{
  "type": "error",
  "error": { "type": "rate_limit_error", "message": "Error" },
  "request_id": "req_REDACTED"
}
```

It included `x-should-retry: true`, even though repeating the same invalid
system prompt did not fix it. The OpenAI server rewrites only this exact opaque
shape into a gate-oriented diagnostic; informative upstream errors are kept.

## Tool calls and tool results

### Tool definitions

Claude Code sent tools directly as Anthropic definitions:

```json
{
  "name": "Bash",
  "description": "<description>",
  "input_schema": { "type": "object", "properties": {} }
}
```

The `mcp_` name rewriting in the root OpenCode plugin is specific to disguising
OpenCode's tool set. It is not part of Claude Code's native subscription wire
format and is not used by this server.

### Parallel calls

A traced parallel turn used one assistant message containing two `tool_use`
blocks:

```json
{
  "role": "assistant",
  "content": [
    { "type": "tool_use", "id": "toolu_REDACTED_1", "name": "Bash", "input": {} },
    { "type": "tool_use", "id": "toolu_REDACTED_2", "name": "Bash", "input": {} }
  ]
}
```

The results returned together in one user message, preserving order and IDs:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_REDACTED_1",
      "content": "<result 1>",
      "is_error": false
    },
    {
      "type": "tool_result",
      "tool_use_id": "toolu_REDACTED_2",
      "content": "<result 2>",
      "is_error": false
    }
  ]
}
```

This matches the server translator: consecutive OpenAI `role: "tool"` messages
are merged into one Anthropic user message with multiple `tool_result` blocks.

## Anthropic SSE taxonomy

Claude Code requested `stream: true`. The observed event order was:

```text
message_start
  content_block_start
  content_block_delta ...
  content_block_stop
  [more content blocks]
message_delta
message_stop
```

`ping` events could appear between semantic events.

| Anthropic event | Relevant payload | OpenAI server mapping |
|---|---|---|
| `message_start` | Message ID, model, initial usage | First chunk with `delta.role = "assistant"`; captures ID/model. |
| `content_block_start` (`text`) | Block index | No chunk until text arrives. |
| `content_block_start` (`thinking`) | Block index | No chunk until thinking arrives. |
| `content_block_start` (`tool_use`) | Block index, tool ID/name; response may include `caller: {type: "direct"}` | Starts an indexed OpenAI `tool_calls` delta; `caller` is ignored. |
| `content_block_delta` / `text_delta` | `text` | `delta.content`. |
| `content_block_delta` / `thinking_delta` | `thinking` | Non-standard `delta.reasoning_content`. |
| `content_block_delta` / `input_json_delta` | `partial_json` string | Forwarded unchanged as function-argument string fragments. |
| `content_block_delta` / `signature_delta` | Thinking signature | Ignored by the OpenAI compatibility layer. |
| `content_block_stop` | Block index | No OpenAI chunk required. |
| `message_delta` | `stop_reason`, usage | Final semantic chunk with finish reason and mapped usage. |
| `message_stop` | End marker | No payload chunk; the server emits OpenAI `data: [DONE]`. |
| `ping` | Keepalive | Ignored. |
| `error` | Anthropic error type/message | OpenAI-style error object, then stream termination. |

Finish reasons map as follows:

| Anthropic | OpenAI |
|---|---|
| `end_turn`, `stop_sequence` | `stop` |
| `tool_use` | `tool_calls` |
| `max_tokens` | `length` |

Tool-call array indexes are assigned by tool block, rather than reusing the raw
Anthropic content-block index. This matters when a thinking or text block comes
before two parallel tool blocks.

OpenAI usage totals include every Anthropic input-token category:

```text
prompt_tokens = input_tokens
              + cache_creation_input_tokens
              + cache_read_input_tokens
total_tokens  = prompt_tokens + output_tokens
```

`prompt_tokens_details.cached_tokens` reports
`cache_read_input_tokens`. Cache-creation tokens remain part of the prompt
total but do not have a standard OpenAI detail field.

If the downstream OpenAI client cancels its response stream, the compatibility
stream aborts its parser and cancels the upstream Anthropic reader. This keeps
a disconnected client from leaving a subscription request running until the
model finishes.

## OAuth and token refresh

The standalone server reuses the repository's PKCE flow:

1. Authorize at `https://claude.ai/oauth/authorize` with the Claude client ID,
   PKCE challenge, callback URI, and scopes including `user:inference` and
   `user:sessions:claude_code`.
2. Exchange the callback code at
   `https://platform.claude.com/v1/oauth/token`.
3. Store access token, refresh token, expiry, generated device ID, and stable
   account UUID in `~/.config/claude-subscription-server/auth.json` with mode
   `0600`.
4. Before an upstream call, refresh when expiry is within 60 seconds.

The refresh request is a JSON POST:

```http
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json
Accept: application/json, text/plain, */*

{
  "grant_type": "refresh_token",
  "refresh_token": "<refresh token>",
  "client_id": "<Claude OAuth client ID>"
}
```

Successful responses carry a new `access_token`, `refresh_token`, and
`expires_in`. Refresh tokens rotate, so the server re-reads the credentials file
before each attempt and atomically persists both returned tokens together with
a same-directory temporary file and rename. Concurrent in-process callers share
one in-flight refresh, while readers in other processes see either the complete
old file or the complete rotated file. Network errors and retryable 5xx
responses receive up to two retries with exponential backoff. Each
token-endpoint fetch has a hard 10-second deadline via `AbortSignal.timeout`;
Bun's `TimeoutError` is treated as a retryable network error. Thus a stalled
endpoint gets at most three timed attempts, separated by 500 ms and 1,000 ms
backoffs, instead of leaving the shared refresh promise pending indefinitely.

## Model discovery

The same OAuth token successfully called:

```text
GET https://api.anthropic.com/v1/models?beta=true
```

The catalog observed on 2026-08-29 was:

```text
claude-opus-5
claude-sonnet-5
claude-fable-5
claude-opus-4-8
claude-opus-4-7
claude-sonnet-4-6
claude-opus-4-6
claude-opus-4-5-20251101
claude-haiku-4-5-20251001
claude-sonnet-4-5-20250929
```

Catalog contents are expected to drift. `GET /v1/models` on the OpenAI server
fetches the live list and maps it to OpenAI model objects. With
`CLAUDE_MODELS` unset, chat accepts every non-empty model ID and lets Anthropic
perform authoritative model validation, so newly advertised models work
without a server update. If discovery fails, the server returns the 10 IDs
observed above as its static fallback.

Setting `CLAUDE_MODELS` opts into a local restriction. That list then filters
both chat requests and a successfully discovered `/v1/models` catalog, and is
also the fallback during discovery failure. This keeps advertised and callable
models under the same policy.

## How to re-trace

For a quick local capture, use a loopback reverse proxy instead of TLS
interception. The Claude CLI connects to the proxy over plaintext localhost;
the proxy makes the normal TLS connection to Anthropic. No mitmproxy CA is
needed.

1. Create or reuse a Bun proxy that:
   - binds only to `127.0.0.1` (the investigation helper used port `8400`),
   - forwards the incoming path and query to `https://api.anthropic.com`,
   - preserves method, headers, status, and SSE response bytes,
   - removes hop-by-hop headers,
   - redacts `authorization` **before** writing request logs, and
   - writes captures outside the repository until they are sanitized.
2. Start it. The investigation helper accepted:

   ```bash
   bun /tmp/trace-proxy.ts --port 8400 --out /tmp/trace3
   ```

3. Point Claude Code at the plaintext loopback URL:

   ```bash
   ANTHROPIC_BASE_URL=http://127.0.0.1:8400 \
     claude -p "Reply with exactly: hello" --output-format json
   ```

   The server applies the same safety boundary to its configurable
   `ANTHROPIC_BASE_URL`: non-loopback upstreams must use HTTPS. Plaintext HTTP
   is accepted only for `localhost`, IPv4 loopback, or `[::1]` debugging.

4. For tool-call structure, use an authorized prompt that requires two
   independent tools, then inspect both the assistant `tool_use` request turn
   and the following user `tool_result` turn.
5. Compare method/path, header names, system-block shapes, top-level body keys,
   content-block types, and SSE event taxonomy before changing constants.
6. Before moving any artifact into the repository, apply every redaction rule
   in [`../../../captures/AGENTS.md`](../../../captures/AGENTS.md): OAuth tokens,
   session/tool/request IDs, UUIDs, usernames, personal paths, branch names,
   customer data, and other PII must use obvious `REDACTED` placeholders.

The proxy process can read the full OAuth bearer token even though the first hop
is local. Do not bind it to a non-loopback interface, share raw logs, or commit
the temporary request/response files.

For the mitmproxy alternative and the repository capture workflow, see
[`../../../captures/AGENTS.md`](../../../captures/AGENTS.md).
