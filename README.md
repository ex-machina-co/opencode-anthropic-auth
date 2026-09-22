# OpenCode Anthropic Auth Plugin

[![OpenCode v1 — npm latest tag](https://img.shields.io/npm/v/%40ex-machina%2Fopencode-anthropic-auth/latest?label=OpenCode%20v1%20(latest))](https://www.npmjs.com/package/@ex-machina/opencode-anthropic-auth?activeTab=versions)
[![OpenCode v2 — npm next tag](https://img.shields.io/npm/v/%40ex-machina%2Fopencode-anthropic-auth/next?label=OpenCode%20v2%20(next))](https://www.npmjs.com/package/@ex-machina/opencode-anthropic-auth?activeTab=versions)

> [!WARNING]
> This plugin comes with no guarantees. You might be banned for breaking the TOS, you might not be. I don't work at Anthropic, nor am I an attorney.
>
> Use your best judgment and don't try to abuse the subscriptions. Plugins like oh-my-openagent are _known_ to trigger bans. Please be careful when using Ralph loops or insanely heavy usage patterns.

> [!IMPORTANT]
> If you are seeing issues, try `rm -rf ~/.cache/opencode/packages/@ex-machina` and confirm that your `opencode.json` uses the plugin release line for your OpenCode version.
>
> Try this FIRST before making an Issue. Thanks!

An [OpenCode](https://github.com/anomalyco/opencode) plugin that provides Anthropic OAuth authentication, enabling Claude Pro/Max users to use their subscription directly with OpenCode.

> [!NOTE]
> This repository uses [Agent Facets](https://agentfacets.io) to manage agent capabilities. See the [quickstart](https://docs.agentfacets.io/quickstart) to install the CLI and get started.

## Version support

| OpenCode version | Plugin release | Support branch | npm dist-tag | Configuration key |
|------------------|----------------|----------------|--------------|-------------------|
| OpenCode v1 | 1.x | [`main`](https://github.com/ex-machina-co/opencode-anthropic-auth/tree/main) | `latest` | `plugin` |
| OpenCode v2 | 2.x prereleases | [`v2/main`](https://github.com/ex-machina-co/opencode-anthropic-auth/tree/v2/main) | `next` | `plugins` |

Both release lines use the same npm package. They are not cross-compatible: the v1 plugin does not load in OpenCode v2, and the v2 plugin does not load in OpenCode v1. OpenCode v2's plugin API is still beta, so review the changelog before upgrading either side.

## Usage

> [!TIP]
> Pin an exact plugin version for a stable setup that changes only when you choose to upgrade. If you intentionally want automatic updates, use the moving npm tag for your OpenCode release line.
>
> This applies to every OpenCode plugin: an unpinned or moving-tag dependency can install new code on startup, so only track automatic updates from publishers you trust.

### OpenCode v1 (`latest`)

OpenCode v1 uses the singular `plugin` configuration key. A bare package spec tracks npm's `latest` tag:

```json
{
  "plugin": ["@ex-machina/opencode-anthropic-auth"]
}
```

You can also write the moving tag explicitly as `@ex-machina/opencode-anthropic-auth@latest`.

For a stable setup, look up the exact version currently published on `latest`:

```bash
npm view @ex-machina/opencode-anthropic-auth dist-tags.latest
```

Substitute the command output for `<version>`:

```json
{
  "plugin": ["@ex-machina/opencode-anthropic-auth@<version>"]
}
```

### OpenCode v2 (`next`)

OpenCode v2 uses the plural `plugins` configuration key. Because npm's default tag points to the v1 line, specify `@next` if you want to track the newest v2 prerelease:

```json
{
  "plugins": ["@ex-machina/opencode-anthropic-auth@next"]
}
```

For a stable setup, look up the exact version currently published on `next`:

```bash
npm view @ex-machina/opencode-anthropic-auth dist-tags.next
```

Substitute the command output for `<version>`:

```json
{
  "plugins": ["@ex-machina/opencode-anthropic-auth@<version>"]
}
```

## Authentication Methods

### OpenCode v1

OpenCode v1 provides three authentication options:

- **Claude Pro/Max** — OAuth flow via `claude.ai` for Pro/Max subscribers. Uses your existing subscription at no additional API cost.
    - Run `/connect`, select `Anthropic (API key)` -> `Claude Pro/Max`, and complete OAuth.
- **Create an API Key** — OAuth flow via `console.anthropic.com` that creates an API key on your behalf.
- **Manually enter API Key** — Standard API-key entry for users who already have one.

### OpenCode v2

OpenCode v2 provides:

- **Claude Pro/Max** — OAuth flow via `claude.ai` for Pro/Max subscribers. Uses your existing subscription at no additional API cost.
    - Run `/connect`, select `Anthropic` -> `Claude Pro/Max`, and complete OAuth.
- **Manually enter API Key / `ANTHROPIC_API_KEY`** — Handled by OpenCode's built-in Anthropic integration, not by this plugin.

> [!NOTE]
> OpenCode v1 also offers a "Create an API Key" OAuth flow that mints and stores an API key. OpenCode v2's plugin API cannot yet complete an OAuth flow by storing a generated API key, so that option is unavailable in v2. Use manual API-key entry or `ANTHROPIC_API_KEY` in the meantime; see [issue #203](https://github.com/ex-machina-co/opencode-anthropic-auth/issues/203) for status.

## Configuration

The plugin reads the following environment variables:

- **`ANTHROPIC_BASE_URL`** — Overrides the Anthropic API endpoint for both release lines, such as when using a proxy. Must be a valid HTTP(S) URL.
- **`ANTHROPIC_INSECURE`** — Skips TLS certificate verification. Behavior differs by OpenCode version:
    - **OpenCode v1** — Set to `1` or `true` to skip verification. Only effective when `ANTHROPIC_BASE_URL` is also set.
    - **OpenCode v2** — Not supported. OpenCode v2 plugin request hooks cannot disable TLS verification. If set, the plugin logs a warning and leaves verification enabled; requests to an untrusted or self-signed `ANTHROPIC_BASE_URL` will fail.
- **`ANTHROPIC_CLAUDE_CODE_VERSION`** — Overrides the Claude Code version reported to Anthropic for both release lines. Must be `major.minor.patch` (for example, `2.1.280`). Defaults to the bundled version; a malformed value is logged and the bundled version is used instead. A value older than the bundled version is honored but logs a warning, since reporting an older version can make newer models reject the request. Read once when the plugin loads, so restart OpenCode after changing it.

Anthropic gates model access on the reported Claude Code version server-side, returning a 400 `claude_code_version_too_old` error for models that require a newer client. `ANTHROPIC_CLAUDE_CODE_VERSION` lets you raise the reported version without waiting for a plugin release.

## How It Works

For Claude Pro/Max authentication, both release lines:

1. Initiate a PKCE OAuth flow against Anthropic's authorization endpoint
2. Exchange the authorization code for access and refresh tokens
3. Automatically refresh expired tokens
4. Inject the required OAuth headers and beta flags into API requests
5. Sanitize the system prompt for compatibility (see below)

Model-cost display differs by OpenCode version:

- **OpenCode v1** — The plugin zeros out displayed model costs because usage is covered by the subscription.
- **OpenCode v2** — OpenCode continues to display Anthropic's API prices even though requests authenticated through Claude Pro/Max use the subscription. Dynamic cost display is deferred until the beta plugin API can safely cancel the required connection event subscription.

### System Prompt Sanitization

The Anthropic API for Max subscriptions has specific requirements for the system prompt to identify as Claude Code. The plugin rewrites the system prompt on each request using an **anchor-based** approach that minimizes what gets changed:

1. **Identity swap** — The OpenCode identity line is removed and replaced with the Claude Code identity.
2. **Paragraph removal by anchor** — Any paragraph containing a known URL anchor (e.g. `github.com/anomalyco/opencode`, `opencode.ai/docs`) is removed entirely. This is resilient to upstream rewording — as long as the anchor URL appears somewhere in the paragraph, the removal works regardless of surrounding text changes.
3. **Inline text replacements** — Short branded strings inside paragraphs we want to keep are replaced (e.g. "OpenCode" → "the assistant" in the professional objectivity section).

Everything else in the system prompt is preserved: tone/style guidance, task management instructions, tool usage policy, environment info, skills, user/project instructions, and file paths containing "opencode". The sanitized system prompt is structured as three blocks in `system[]`: the billing header, the Claude Code identity line, and the remaining system content.

## Development

### Local Testing

Use `bun run dev` to test plugin changes locally without publishing to npm:

```bash
bun run dev
```

This does three things:

1. Builds the plugin
2. Symlinks the build output into `.opencode/plugins/` so OpenCode loads it as a local plugin
3. Starts `tsc --watch` for automatic rebuilds on source changes

After starting the dev script:

- On the `main` branch, restart OpenCode in this project directory.
- On the `v2/main` branch, restart OpenCode v2 (`opencode2`) in this project directory.

Edits to `src/` trigger a rebuild; restart the corresponding OpenCode version again to load the new build.

You can confirm that the v2 plugin loaded through the OpenCode v2 API:

```bash
opencode2 api get /api/plugin        # should list "ex-machina.anthropic-auth"
opencode2 api get /api/integration   # anthropic should offer a "Claude Pro/Max" OAuth method
```

Ctrl+C stops the watcher and cleans up the symlink. If the process was killed without cleanup (e.g. `kill -9`), you can manually remove the symlink:

```bash
bun run dev:clean
```

> [!NOTE]
> If you have the npm version of this plugin in your global OpenCode config, both will load. The local version takes precedence for auth handling.

### Publishing

This project uses [changesets](https://github.com/changesets/changesets) for versioning and publishing. See the [changeset README](.changeset/README.md) for contributor details.

```bash
bun change          # create a changeset describing your changes
```

Changesets merged to a release branch cause CI to open a release PR; merging that PR publishes to npm. The repository has two release trains:

- `main` publishes plugin v1 for OpenCode v1 to npm's `latest` tag.
- `v2/main` publishes plugin v2 prereleases for OpenCode v2 to npm's `next` tag.

Maintainers can find the complete two-train release and branch-sync process in the [release runbook](https://github.com/ex-machina-co/opencode-anthropic-auth/blob/v2/main/RELEASING.md).

## License

MIT
