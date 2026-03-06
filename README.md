# OpenCode Anthropic Auth Plugin

An [OpenCode](https://github.com/anomalyco/opencode) plugin that provides Anthropic OAuth authentication, enabling Claude Pro/Max users to use their subscription directly with OpenCode.

<details>
  <summary>This solves the ".opencode" -> ".Claude" issues too!</summary>

  ![renaming.jpg](images/renaming.jpg)
</details>

## Installation

```bash
npm install @ex-machina/opencode-anthropic-auth
```

## Usage

Add the plugin to your OpenCode configuration:

```json
{
  "plugins": ["@ex-machina/opencode-anthropic-auth"]
}
```

## Authentication Methods

The plugin provides three authentication options:

- **Claude Pro/Max** - OAuth flow via `claude.ai` for Pro/Max subscribers. Uses your existing subscription at no additional API cost.
- **Create an API Key** - OAuth flow via `console.anthropic.com` that creates an API key on your behalf.
- **Manually enter API Key** - Standard API key entry for users who already have one.

## How It Works

For Claude Pro/Max authentication, the plugin:

1. Initiates a PKCE OAuth flow against Anthropic's authorization endpoint
2. Exchanges the authorization code for access and refresh tokens
3. Automatically refreshes expired tokens
4. Injects the required OAuth headers and beta flags into API requests
5. Zeros out model costs (since usage is covered by the subscription)

## Development

### Publishing

Bump the version and push to `main` -- CI will publish to npm automatically:

```bash
bun bump            # patch bump (0.0.13 -> 0.0.14)
bun bump minor      # minor bump (0.0.13 -> 0.1.0)
bun bump major      # major bump (0.0.13 -> 1.0.0)
bun bump -- --dry-run  # preview without changes
```

## License

MIT
