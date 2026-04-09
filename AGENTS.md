# Agent Notes

## Captured system prompts

The `captures/` directory contains system prompts captured from Claude Code and OpenCode via mitmproxy HTTPS interception. These are useful for verifying proxy transform accuracy and understanding what each tool sends to the Anthropic API.

- **Capture traffic**: `./scripts/capture-with-mitmproxy.sh -o <name>.flow -- <command>`
- **Extract prompt**: `bun run extract <name>.flow -o captures/<tool>-v<version>.txt`

See [captures/AGENTS.md](captures/AGENTS.md) for prerequisites, full workflow, and PII redaction rules.
