---
"@ex-machina/opencode-anthropic-auth": minor
---

Add multiple Claude Pro/Max account support with automatic failover.

You can now authenticate several Claude accounts (sign in with **Claude Pro/Max**
repeatedly, each with a different account). Logins are saved to a plugin-owned
account pool (`accounts.json`), labeled by email (resolved from the OAuth token
response or the `/api/oauth/profile` endpoint) and deduplicated by account so the
same account logged in twice doesn't create a useless duplicate that shares one
quota.

On every request the plugin tries the primary account first, then other
available accounts, then cooling-down ones as a last resort. Failover triggers on
an HTTP error status (`429`/`401`/`403`/`529`) **or** an error event inside a
`200 OK` SSE stream (Claude Pro/Max usage limits often arrive as a
`rate_limit_error` event, not a `429`). Exhausted accounts are cooled down
(respecting `Retry-After`) and the request is transparently retried on the next
account; an error is only surfaced once every account has failed. A working
non-primary account is promoted into OpenCode's credential slot so subsequent
requests start healthy. The active account is recorded via a `primary` flag in
the store. New env vars: `ANTHROPIC_ACCOUNTS_PATH` (store location) and
`ANTHROPIC_FAILOVER_DEBUG` (log failover decisions).
