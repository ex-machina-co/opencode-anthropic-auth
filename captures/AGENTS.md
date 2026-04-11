# Captured System Prompts

This directory contains system prompts captured from Claude Code and OpenCode via HTTPS traffic interception. These are useful for understanding what each tool actually sends to the Anthropic API, comparing differences, and ensuring our proxy transforms are accurate.

## What's here

| File                      | Description                                                                      |
|---------------------------|----------------------------------------------------------------------------------|
| `claude-code-v2.1.87.txt` | Claude Code v2.1.87 system prompt (captured 2026-04-08)                          |
| `opencode-v1.4.0.txt`     | OpenCode v1.4.0 system prompt, as transformed by the proxy (captured 2026-04-08) |

Naming convention: `<tool>-v<version>.txt`

All files have PII redacted with obvious `REDACTED` placeholders.

## How to capture new prompts

### Prerequisites

1. Install mitmproxy:

```bash
brew install mitmproxy
```

2. Generate the CA certificate (run once, then Ctrl-C):

```bash
mitmdump
```

3. Optionally trust the cert in the macOS system keychain (needed for browser-based OAuth flows):

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  ~/.mitmproxy/mitmproxy-ca-cert.pem
```

The capture script sets `NODE_EXTRA_CA_CERTS` automatically, so Node-based CLIs (Claude Code, OpenCode) will trust the cert without the system keychain step.

### Capturing traffic

Use `scripts/capture-with-mitmproxy.sh` to run a CLI command through the proxy:

```bash
# Capture OpenCode traffic
./scripts/capture-with-mitmproxy.sh -o opencode.flow -- opencode run "say hello"

# Capture Claude Code traffic
./scripts/capture-with-mitmproxy.sh -o claude.flow -- claude -p "say hello"
```

This starts a local mitmproxy instance, routes the child command's HTTPS traffic through it, and writes captured flows to a `.flow` file. The proxy shuts down when the child command exits.

### Extracting the system prompt

Use `scripts/extract-system-prompt.ts` to pull the system prompt text from a `.flow` file:

```bash
bun run scripts/extract-system-prompt.ts opencode.flow -o captures/opencode-v1.4.0.txt
bun run scripts/extract-system-prompt.ts claude.flow -o captures/claude-code-v2.1.87.txt
```

The script finds the `/v1/messages` request with the largest system prompt (skipping title generators and other small requests), concatenates all system text blocks, and writes the result.

### PII redaction

Before committing, redact personal info with obvious placeholders:

| Pattern | Replacement |
|---------|-------------|
| `/Users/<username>` | `/Users/REDACTED` |
| OAuth tokens (`sk-ant-oat01-...`) | `sk-ant-REDACTED` |
| Session IDs (`ses_...`) | `ses_REDACTED` |
| Org/account UUIDs | `00000000-0000-0000-0000-000000000000` |
| Branch names containing usernames | `REDACTED/example-branch` |
| Memory paths with encoded usernames | Replace username with `REDACTED` |

The goal is to make redactions obviously fake so nobody mistakes them for real credentials.

## Inspecting raw flows

If you still have the `.flow` files (they're gitignored), you can inspect them with mitmproxy's tools:

```bash
# Web UI
mitmweb -r claude.flow

# Text dump filtered to /v1/messages, full detail
mitmdump -nr claude.flow --flow-detail 4 "~u /v1/messages"

# Side-by-side diff of two captures
diff <(mitmdump -nr claude.flow --flow-detail 4 "~u /v1/messages" 2>/dev/null) \
     <(mitmdump -nr opencode.flow --flow-detail 4 "~u /v1/messages" 2>/dev/null)
```
