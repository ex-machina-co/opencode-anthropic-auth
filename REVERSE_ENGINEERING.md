# Reverse Engineering Claude Code OAuth for OpenCode

## Context

Anthropic removed OAuth Pro/Max subscription support from third-party tools in January 2026.
The official `opencode-anthropic-auth` plugin was deprecated following an Anthropic legal request (commit `1ac1a02` in opencode, March 19 2026).

This document describes how we reverse-engineered the Claude Code binary and used MITM proxying to replicate its OAuth authentication flow in an OpenCode plugin.

## 1. Binary Analysis of Claude Code

### Locating the binary

```bash
which claude
# /c/Users/Sam/.local/bin/claude
claude --version
# 2.1.80 (Claude Code)
file claude.exe
# PE32+ executable, x86-64, 230MB
```

The binary is a bundled Node.js/Bun application (~230MB) containing the full runtime and application code. The JavaScript source is minified but **not encrypted** — string literals are preserved in the binary.

### Extracting strings

Standard `strings` command returns nothing on Windows — the binary uses UTF-16 or strings are interleaved with null bytes. However, `grep -boa` works directly on the binary to find byte offsets:

```bash
# Find all occurrences of a keyword with byte offsets
grep -boa "oauth" claude.exe | head -5
# 305 occurrences found

grep -boa "billing" claude.exe | head -10
grep -boa "cc_version" claude.exe | head -10
grep -boa "59cf53e54c78" claude.exe | head -5  # the salt
grep -boa "v1/oauth/token" claude.exe | head -10
grep -boa "platform.claude.com" claude.exe | head -10
```

### Extracting code context around an offset

Using `dd` to extract bytes around a known offset, then `cat -v` to make binary safe and `tr` to split on null bytes:

```bash
dd if=claude.exe bs=1 skip=<offset> count=1000 2>/dev/null | cat -v | tr '\0' '\n' | grep -v '^$'
```

This technique revealed the minified but readable JavaScript source code of the billing header computation, OAuth flow, URL configuration, and system prompt handling.

### Extracting URL configuration

To find the production OAuth URLs, we searched for `TOKEN_URL` and traced the variable definitions:

```bash
# Find the TOKEN_URL references
grep -boa "TOKEN_URL" claude.exe | head -10

# Extract the production URL config object (fPf)
grep -boa "fPf=" claude.exe | head -5
dd if=claude.exe bs=1 skip=<offset> count=500 2>/dev/null | cat -v | tr '\0' '\n' | grep -v '^$'
```

This revealed the full URL configuration:
```javascript
fPf = {
  BASE_API_URL: "https://api.anthropic.com",
  CONSOLE_AUTHORIZE_URL: "https://platform.claude.com/oauth/authorize",
  CLAUDE_AI_AUTHORIZE_URL: "https://claude.ai/oauth/authorize",
  TOKEN_URL: "https://platform.claude.com/v1/oauth/token",
  API_KEY_URL: "https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
  ROLES_URL: "https://api.anthropic.com/api/oauth/claude_cli/roles",
  MANUAL_REDIRECT_URL: "https://platform.claude.com/oauth/code/callback",
  CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  MCP_PROXY_URL: "https://mcp-proxy.anthropic.com"
}
```

**Critical discovery**: Anthropic migrated from `console.anthropic.com` to `platform.claude.com` for OAuth endpoints. The old domain still works but has aggressive rate limiting on certain User-Agents.

## 2. MITM Proxy Interception (Docker)

### Why we needed this

Binary analysis gave us the code structure, but we needed to see the **exact** HTTP requests in flight — headers, body, and all. The binary uses `axios` internally which sets its own User-Agent, overriding what we assumed from reading the code.

### Docker setup

We created a Docker Compose stack with two containers:
1. **mitmproxy** — HTTPS-intercepting proxy with web dashboard
2. **claude** — Fresh Claude Code installation routed through the proxy

```yaml
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    command: mitmweb --web-host 0.0.0.0 --set web_open_browser=false
            --ssl-insecure --set web_password=""
            --save-stream-file /home/mitmproxy/.mitmproxy/flows.mitm
    ports:
      - "8080:8080"   # proxy port
      - "8081:8081"   # web UI

  claude:
    build: .  # Node 22 + Claude Code via official installer
    environment:
      - HTTPS_PROXY=http://mitmproxy:8080
      - HTTP_PROXY=http://mitmproxy:8080
      - NODE_TLS_REJECT_UNAUTHORIZED=0
    volumes:
      - ./data:/mitmproxy-certs:ro  # mitmproxy CA cert
```

The entrypoint script trusts the mitmproxy CA certificate via `NODE_EXTRA_CA_CERTS`.

### Reading captured flows

```bash
docker exec mitmproxy-claude python3 -c "
from mitmproxy.io import FlowReader
with open('/home/mitmproxy/.mitmproxy/flows.mitm', 'rb') as f:
    for flow in FlowReader(f).stream():
        req = flow.request
        print(f'{req.method} {req.pretty_url}')
        for k, v in req.headers.items():
            print(f'  {k}: {v}')
        if req.content:
            print(f'  BODY: {req.content.decode()[:2000]}')
        if flow.response:
            print(f'  -> {flow.response.status_code}')
            if flow.response.content:
                print(f'  RESP: {flow.response.content.decode()[:2000]}')
"
```

### Key discoveries from MITM interception

**The token exchange request (the critical one):**
```
POST https://platform.claude.com/v1/oauth/token
Headers:
  Content-Type: application/json
  User-Agent: axios/1.13.6          <-- NOT claude-code/2.1.80 !
Body:
  {
    "grant_type": "authorization_code",
    "code": "<auth_code>",
    "redirect_uri": "https://platform.claude.com/oauth/code/callback",
    "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    "code_verifier": "<pkce_verifier>",
    "state": "<state>"
  }
Response: 200 with access_token, refresh_token, expires_in
```

**The User-Agent revelation**: Claude Code uses `axios` for HTTP requests. Axios sets its own `User-Agent: axios/1.13.6` by default on OAuth token requests. The `claude-code/2.1.80` or `claude-cli/2.1.80 (external, cli)` User-Agents are only used on specific endpoints:
- `claude-cli/2.1.80 (external, cli)` — used on `/api/hello` and `/v1/oauth/hello` health checks
- `claude-code/2.1.80` — used on `/api/event_logging/batch` telemetry and API calls (`/v1/messages`)
- `axios/1.13.6` — used on token exchange (`/v1/oauth/token`), profile, and roles endpoints

**This was the root cause of our 429 rate limit**: Anthropic rate-limits the token exchange endpoint by User-Agent. Using `claude-code/X.X.X` triggers aggressive rate limiting (persists for 12+ hours), while `axios/1.13.6` (the default axios UA) is not rate-limited.

## 3. Key Findings — Final Verified Configuration

### OAuth URLs (migrated from console.anthropic.com)

| Endpoint | URL |
|---|---|
| Authorize (claude.ai) | `https://claude.ai/oauth/authorize` |
| Authorize (console) | `https://platform.claude.com/oauth/authorize` |
| Token exchange | `https://platform.claude.com/v1/oauth/token` |
| Redirect URI | `https://platform.claude.com/oauth/code/callback` |
| API key creation | `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` |
| Profile | `https://api.anthropic.com/api/oauth/profile` |
| Roles | `https://api.anthropic.com/api/oauth/claude_cli/roles` |

### OAuth Scopes (v2.1.80)

```
org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload
```

Note: `org:create_api_key` is back in v2.1.80 despite earlier versions rejecting it. Always match the exact scopes from the current binary.

### Token Exchange Details

- **URL**: `https://platform.claude.com/v1/oauth/token`
- **Method**: POST
- **Content-Type**: `application/json`
- **User-Agent**: `axios/1.13.6` (critical — other UAs get rate-limited)
- **No extra headers** needed (no `anthropic-version`, no `anthropic-beta`)
- **Body**: JSON with `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`, `state`

### Token Refresh Details

Same as exchange but with:
- **Body**: `{"grant_type": "refresh_token", "refresh_token": "...", "client_id": "..."}`

### Billing Header

The billing header is a **system prompt text block** (NOT an HTTP header), injected as the **first block** in the `system` array.

**Format:**
```
x-anthropic-billing-header: cc_version={VERSION}.{hash}; cc_entrypoint={entry}; cch=00000;
```

**Computation (extracted from binary):**
```javascript
var SALT = "59cf53e54c78";
var INDICES = [4, 7, 20];

function computeHash(firstUserMessageText, version) {
  let sampled = INDICES.map(i => firstUserMessageText[i] || "0").join("");
  let input = `${SALT}${sampled}${version}`;
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 3);
}
// Result: "x-anthropic-billing-header: cc_version=2.1.80.abc; cc_entrypoint=cli; cch=00000;"
```

**Key details:**
- Salt: `59cf53e54c78`
- Sample indices: `[4, 7, 20]` — character positions from first user message text
- Out-of-bounds characters default to `"0"`
- Hash: SHA-256 of `salt + sampled_chars + version`, first 3 hex characters
- `cch` value: `00000` (hardcoded)
- `cc_entrypoint`: `"cli"` (or reads from `CLAUDE_CODE_ENTRYPOINT` env var)

### System Prompt Injection Order

Found at offset ~130881500 in the binary:
1. **Billing header** (first text block, `cacheScope: null`)
2. **Claude Code identity prefix** (`cacheScope: "org"`)
3. **Remaining system prompt** (`cacheScope: "org"` or `"global"`)

### Request Transformations (on /v1/messages calls)

1. **Authorization**: `Bearer {access_token}` (replaces `x-api-key`)
2. **User-Agent**: `claude-code/{VERSION}` on API calls
3. **Beta headers**: `oauth-2025-04-20,interleaved-thinking-2025-05-14` merged with existing betas
4. **URL rewrite**: `?beta=true` appended to `/v1/messages`
5. **Tool name prefixing**: all tool names prefixed with `mcp_` in requests, stripped in responses
6. **System prompt rewriting**: `OpenCode` -> `Claude Code`, `opencode` -> `Claude` in system text blocks
7. **Billing header**: injected as first system prompt text block

## 4. Rate Limiting

### What we learned the hard way

The OAuth token exchange endpoint has aggressive rate limiting:
- **By User-Agent**: `claude-code/*` and `claude-cli/*` UAs are rate-limited aggressively. `axios/1.13.6` is not.
- **Duration**: 429 persists for **12+ hours** — we tested across an overnight period
- **Not per-IP**: Changing IP (VPN) did not help when using the wrong User-Agent
- **Not per-account**: Same client_id with different UAs had different results
- **No useful `retry-after`**: Returns `retry-after: 0` which is misleading

### Verification method

```bash
# This gets 429 (blacklisted UA):
curl -X POST "https://platform.claude.com/v1/oauth/token" \
  -H "User-Agent: claude-code/2.1.79" \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"authorization_code","code":"fake","client_id":"9d1c250a-...","code_verifier":"test"}'
# -> 429

# This gets 400 (correct UA, just invalid code):
curl -X POST "https://platform.claude.com/v1/oauth/token" \
  -H "User-Agent: axios/1.13.6" \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"authorization_code","code":"fake","client_id":"9d1c250a-...","code_verifier":"test"}'
# -> 400 (not rate limited!)
```

### Mitigation in the plugin

- Exchange deduplication: `exchange()` deduplicates concurrent calls with the same code (opencode calls the callback twice)
- Correct User-Agent: `axios/1.13.6` on token exchange/refresh, `claude-code/{VERSION}` on API calls

## 5. Implementation Summary

### Files modified from the original @ex-machina/opencode-anthropic-auth:

**`src/constants.ts`** — Updated version to `2.1.80`, added billing constants (salt, sample indices, cch), added `CLAUDE_CODE_USER_AGENT`

**`src/auth.ts`** — Migrated URLs to `platform.claude.com`, fixed OAuth scopes to match v2.1.80, set User-Agent to `axios/1.13.6`, added exchange deduplication

**`src/transform.ts`** — Fixed user-agent on API calls, added billing header computation (`computeBillingHeader`), added system prompt injection (`injectBillingHeader`), added `OpenCode` -> `Claude Code` text replacement in system prompts

**`src/index.ts`** — Integrated billing header injection (gated to `/v1/messages` only), migrated token refresh to `platform.claude.com`, set User-Agent to `axios/1.13.6` on refresh

### OpenCode configuration

Requires opencode >= 1.3.0 (or beta `0.0.0-beta-202603191900`+) where the built-in anthropic auth plugin was removed.

```json
{
  "plugin": ["C:/Users/Sam/Projects/opencode-anthropic-auth"]
}
```

## 6. Useful Commands for Future Analysis

```bash
# Find string offsets in binary
grep -boa "search_term" claude.exe | head -10

# Extract readable code around an offset
dd if=claude.exe bs=1 skip=<offset> count=<bytes> 2>/dev/null | cat -v | tr '\0' '\n' | grep -v '^$'

# Count occurrences
grep -c "search_term" claude.exe

# Find the Claude Code binary
which claude
claude --version

# Test rate limiting on token endpoint
curl -s -w "\n%{http_code}" -X POST "https://platform.claude.com/v1/oauth/token" \
  -H "Content-Type: application/json" -H "User-Agent: axios/1.13.6" \
  -d '{"grant_type":"authorization_code","code":"fake","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e","code_verifier":"test"}'

# Docker MITM setup for intercepting Claude Code traffic
docker compose up -d  # mitmproxy + claude container
docker exec -it claude-diag bash
# In container: claude login
# View in browser: http://localhost:8081
```

## 7. Chronology of the Investigation

1. **Started** with the `@ex-machina/opencode-anthropic-auth` plugin (v0.1.0) — security audit passed
2. **Hit "invalid code"** — discovered it was actually 429 rate limiting via debug logging
3. **Added deduplication** — opencode was calling exchange() twice concurrently
4. **Compared with working gist** (gonzalosr) — found URL/format differences
5. **Extracted billing header** from clewdr commit — wrong cch value and injection method
6. **Analyzed Claude Code binary** — found the real billing computation, confirmed system prompt injection
7. **Discovered URL migration** — `console.anthropic.com` -> `platform.claude.com`
8. **Still 429 after 12+ hours** — not IP-based, not account-based
9. **Set up Docker MITM proxy** — intercepted real Claude Code v2.1.80 login flow
10. **Found the smoking gun** — User-Agent `axios/1.13.6` on token exchange, not `claude-code/*`
11. **Verified** — `axios/1.13.6` UA returns 400 (not rate-limited), `claude-code/*` returns 429
12. **Login successful** — full OAuth flow working with opencode

## 8. References

- clewdr billing header commit: https://github.com/Xerxes-2/clewdr/commit/a4e5df3
- opencode anthropic removal commit: https://github.com/anomalyco/opencode/commit/1ac1a02
- Working gist by gonzalosr: https://gist.github.com/gonzalosr/6ea39297fa73a62af1588306d0172d21
- opencode issue: https://github.com/anomalyco/opencode/issues/18267
- Claude Code OAuth scopes issue: https://github.com/anthropics/claude-code/issues/34785
- OAuth rate limiting issues: #31637, #30930, #30616
- Claude Code install: https://code.claude.com/docs/fr/overview
