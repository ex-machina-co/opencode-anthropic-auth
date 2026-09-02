# OpenCode Anthropic Auth Plugin

> [!WARNING]
> This plugin comes with no guarantees. You might be banned for breaking the TOS, you might not be. I don't work at Anthropic, nor am I an attorney.
>
> Use your best judgment and don't try to abuse the subscriptions. Plugins like oh-my-openagent are _known_ to trigger bans. Please be careful when using Ralph loops or insanely heavy usage patterns.

> [!IMPORTANT]
> If you are seeing issues, please try to `rm -rf ~/.cache/opencode/packages/@ex-machina` and check your `opencode.json` config to make sure you're on the latest version.
>
> Try this FIRST before making an Issue. Thanks!

An [OpenCode](https://github.com/anomalyco/opencode) plugin that provides Anthropic OAuth authentication, enabling Claude Pro/Max users to use their subscription directly with OpenCode.

## Usage

Add the plugin to your OpenCode configuration:

```json
{
  "plugin": ["@ex-machina/opencode-anthropic-auth"]
}
```

> [!TIP]
> It is STRONGLY advised that you pin the plugin to a version. This will keep you from getting automatic updates; however, this will protect you from nefarious updates.
>
> This holds true for ANY OpenCode plugin. If you do not pin them, OpenCode will automatically update them on startup. It's a massive vulnerability waiting to happen.

#### Example of pinned version

```json
{
  "plugin": ["@ex-machina/opencode-anthropic-auth@1.8.2"]
}
```

## Authentication Methods

The plugin provides three authentication options:

- **Claude Pro/Max** - OAuth flow via `claude.ai` for Pro/Max subscribers. Uses your existing subscription at no additional API cost.
    - run the `/connect` command, select `Anthropic (API key)` -> `Claude Pro/Max` and do OAuth
- **Create an API Key** - OAuth flow via `console.anthropic.com` that creates an API key on your behalf.
- **Manually enter API Key** - Standard API key entry for users who already have one.

## Multiple Accounts & Automatic Failover

You can authenticate multiple Claude Pro/Max accounts and have the plugin
automatically switch between them when one hits a usage/rate limit — so a long
session keeps going instead of stopping when a single account is exhausted.

### Adding accounts

Sign in with **Claude Pro/Max** more than once, each time with a **different**
Claude account. Every login is saved to a plugin-owned account pool (labeled by
email, deduplicated by account) and becomes the current primary. There is no
separate "add account" step — failover is transparent.

> Failover only helps across **distinct** Claude accounts. Multiple logins of
> the *same* account share one usage quota, so the plugin deduplicates by email.

### How it works

On every request the plugin builds an ordered list of candidate accounts:

1. The primary (OpenCode's) account first.
2. Then each additional account that isn't currently cooling down.
3. Then, as a last resort, accounts that *are* cooling down.

Failover triggers on an HTTP error status (`429`, `401`, `403`, `529`) **or** an
error event inside a `200 OK` streaming response (Claude Pro/Max usage limits
often arrive as a `rate_limit_error` SSE event, not a `429`). The exhausted
account is put on a cooldown (respecting `Retry-After`) and the same request is
transparently retried on the next account; an error is only surfaced once every
account has failed. When a non-primary account serves a request, it is promoted
into OpenCode's credential slot so later requests start from a healthy account.

### Where accounts are stored

Accounts live in a plugin-owned JSON file (mode `0600`):

- `$ANTHROPIC_ACCOUNTS_PATH` if set, otherwise
- `$XDG_DATA_HOME/opencode-anthropic-auth/accounts.json`, otherwise
- `~/.local/share/opencode-anthropic-auth/accounts.json`

Each entry records the account `email` (its label), OAuth tokens, any
`cooldownUntil` timestamp, and a `primary: true` flag on the active account.
Set `ANTHROPIC_FAILOVER_DEBUG=1` to log candidate selection and failover
decisions to stderr.

## Configuration

The plugin supports the following environment variables:

| Variable                          | Description                                                                                                                                                                                 |
|-----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ANTHROPIC_BASE_URL`              | Override the API endpoint URL (e.g. for proxying). Must be a valid HTTP(S) URL.                                                                                                             |
| `ANTHROPIC_INSECURE`              | Set to `1` or `true` to skip TLS certificate verification. Only effective when `ANTHROPIC_BASE_URL` is also set.                                                                            |
| `ANTHROPIC_ACCOUNTS_PATH`         | Override the path to the multi-account store file. Defaults to `$XDG_DATA_HOME/opencode-anthropic-auth/accounts.json` (or `~/.local/share/...`).                                            |
| `ANTHROPIC_FAILOVER_DEBUG`        | Set to `1` or `true` to log multi-account candidate selection and failover decisions to stderr.                                                                                             |

## How It Works

For Claude Pro/Max authentication, the plugin:

1. Initiates a PKCE OAuth flow against Anthropic's authorization endpoint
2. Exchanges the authorization code for access and refresh tokens
3. Automatically refreshes expired tokens
4. Injects the required OAuth headers and beta flags into API requests
5. Sanitizes the system prompt for compatibility (see below)
6. Zeros out model costs (since usage is covered by the subscription)

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

After starting the dev script, restart OpenCode in this project directory to pick up the local build. Any edits to `src/` will trigger a rebuild — restart OpenCode again to load the new version.

Ctrl+C stops the watcher and cleans up the symlink. If the process was killed without cleanup (e.g. `kill -9`), you can manually remove the symlink:

```bash
bun run dev:clean
```

> [!NOTE]
> If you have the npm version of this plugin in your global OpenCode config, both will load. The local version takes precedence for auth handling.

### Publishing

This project uses [changesets](https://github.com/changesets/changesets) for versioning and publishing. See the [changeset README](.changeset/README.md) for more details.

```bash
bun change          # create a changeset describing your changes
```

When changesets are merged to `main`, CI will automatically open a release PR. Merging that PR publishes to npm.

## License

MIT
