import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * A single stored Claude OAuth account.
 *
 * The token fields (`refresh`, `access`, `expires`) mirror the shape produced
 * by the OAuth exchange/refresh flow and stored by OpenCode for the `anthropic`
 * provider, so the existing refresh logic works unchanged per account.
 */
export type Account = {
  /** Stable unique id (used for dedup + as a stable handle). */
  id: string
  /** Human-friendly label shown in logs/UI (e.g. "Account 1" or the email). */
  label: string
  /** The account's email address, once resolved from the OAuth profile. */
  email?: string
  refresh: string
  access: string
  /** Epoch ms when the access token expires. */
  expires: number
  /**
   * True for the single account currently held in OpenCode's credential slot
   * (the one tried first). Exactly one account has this set at a time.
   */
  primary?: boolean
  /**
   * Epoch ms until which this account is skipped for selection because it hit
   * a rate limit / usage limit. `0` (or absent) means available.
   */
  cooldownUntil?: number
  /** Last error message recorded for this account (diagnostics only). */
  lastError?: string
}

type AccountStoreFile = {
  version: 1
  accounts: Account[]
}

const ENV_STORE_PATH = 'ANTHROPIC_ACCOUNTS_PATH'

/**
 * Resolve the accounts file path.
 *
 * Precedence:
 *  1. `ANTHROPIC_ACCOUNTS_PATH` env var (used by tests and power users)
 *  2. `$XDG_DATA_HOME/opencode-anthropic-auth/accounts.json`
 *  3. `~/.local/share/opencode-anthropic-auth/accounts.json`
 */
export function resolveStorePath(): string {
  const override = process.env[ENV_STORE_PATH]?.trim()
  if (override) return override

  const xdg = process.env.XDG_DATA_HOME?.trim()
  const base = xdg || join(homedir(), '.local', 'share')
  return join(base, 'opencode-anthropic-auth', 'accounts.json')
}

function emptyStore(): AccountStoreFile {
  return { version: 1, accounts: [] }
}

function readStore(path: string): AccountStoreFile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // Missing file (or unreadable) → treat as empty store.
    return emptyStore()
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AccountStoreFile>
    if (!parsed || !Array.isArray(parsed.accounts)) return emptyStore()
    // Keep well-formed entries and normalize the (required) label so it's
    // always a string, even for entries written by older/hand-edited stores.
    const accounts = parsed.accounts
      .filter(
        (a): a is Account =>
          !!a &&
          typeof a.id === 'string' &&
          typeof a.refresh === 'string' &&
          typeof a.access === 'string' &&
          typeof a.expires === 'number',
      )
      .map((a) => ({
        ...a,
        label:
          typeof a.label === 'string' && a.label ? a.label : (a.email ?? a.id),
      }))
    return { version: 1, accounts }
  } catch {
    // Corrupt JSON → don't crash the plugin; start fresh.
    return emptyStore()
  }
}

function writeStore(path: string, store: AccountStoreFile): void {
  mkdirSync(dirname(path), { recursive: true })
  // Use a per-writer unique temp name so two concurrent writers can't clobber
  // the same temp file between write and rename.
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  const data = JSON.stringify(store, null, 2)
  writeFileSync(tmp, data, { mode: 0o600 })
  // node:fs renameSync is atomic on the same filesystem.
  renameSync(tmp, path)
}

/**
 * Collapse multiple stored logins of the SAME Claude account (same email) down
 * to a single entry, in place. Multiple token pairs for one account share that
 * account's usage quota, so keeping them provides no real failover — we keep
 * just one per email. The kept ("winner") entry is the primary if one is
 * flagged, otherwise the one with the freshest (latest-expiring) access token.
 * Accounts without a known email are left untouched (can't be compared).
 */
function collapseDuplicates(store: AccountStoreFile): boolean {
  const groups = new Map<string, Account[]>()
  for (const account of store.accounts) {
    if (!account.email) continue
    const group = groups.get(account.email)
    if (group) group.push(account)
    else groups.set(account.email, [account])
  }

  const removeIds = new Set<string>()
  for (const group of groups.values()) {
    if (group.length <= 1) continue
    const winner =
      group.find((a) => a.primary) ??
      group.reduce((best, a) => (a.expires > best.expires ? a : best))
    for (const a of group) {
      if (a.id !== winner.id) removeIds.add(a.id)
    }
  }

  if (removeIds.size > 0) {
    store.accounts = store.accounts.filter((a) => !removeIds.has(a.id))
    return true
  }
  return false
}

/**
 * File-backed store for multiple Claude OAuth accounts.
 *
 * Every mutation re-reads the file immediately before writing (so it operates
 * on the latest on-disk snapshot) and writes atomically via a unique temp file
 * + rename. This narrows — but does not fully eliminate — the read-modify-write
 * window between concurrent OpenCode sessions; there is no cross-process lock,
 * so a last-writer-wins update is still theoretically possible. In practice
 * mutations are small and infrequent, and the atomic rename guarantees readers
 * never observe a partially written file.
 */
export class AccountStore {
  private readonly path: string

  constructor(path: string = resolveStorePath()) {
    this.path = path
  }

  /** Return all accounts (as stored). */
  list(): Account[] {
    return readStore(this.path).accounts
  }

  /**
   * Add or replace an account. Dedupes by EMAIL (same Claude account) when the
   * email is known, otherwise by refresh token, so re-authenticating the same
   * Claude account updates the existing entry instead of creating a duplicate
   * that shares the same usage quota. Returns the stored account.
   */
  add(input: {
    refresh: string
    access: string
    expires: number
    label?: string
    email?: string
  }): Account {
    const store = readStore(this.path)

    // Same Claude account = same email. Fall back to refresh-token match when
    // the email isn't known yet.
    let existing = input.email
      ? store.accounts.find((a) => a.email === input.email)
      : undefined
    if (!existing) {
      existing = store.accounts.find((a) => a.refresh === input.refresh)
    }

    if (existing) {
      existing.access = input.access
      existing.refresh = input.refresh
      existing.expires = input.expires
      existing.cooldownUntil = 0
      existing.lastError = undefined
      if (input.email) {
        existing.email = input.email
        existing.label = input.email
      } else if (input.label) {
        existing.label = input.label
      }
      collapseDuplicates(store)
      writeStore(this.path, store)
      return existing
    }

    const account: Account = {
      id: crypto.randomUUID(),
      label:
        input.email ?? input.label ?? `Account ${store.accounts.length + 1}`,
      email: input.email,
      refresh: input.refresh,
      access: input.access,
      expires: input.expires,
      cooldownUntil: 0,
    }
    store.accounts.push(account)
    collapseDuplicates(store)
    writeStore(this.path, store)
    return account
  }

  /**
   * Insert an account ONLY if the pool doesn't already know it, leaving any
   * existing entry completely untouched. Unlike `add` (an upsert that also
   * resets the matched account's tokens, cooldown and `lastError`), this never
   * disturbs a stored account — crucially, it preserves a live cooldown, so it
   * is safe to call on every request without accidentally reviving a
   * rate-limited account.
   *
   * A match is by email when `input.email` is known, otherwise by refresh
   * token. Used to persist OpenCode's current credential (the "primary") into
   * the pool the first time it's seen, so a later login (which overwrites
   * OpenCode's slot) or a failover promotion (which demotes it) can't silently
   * drop it. Returns true only when a new account was inserted.
   */
  addIfAbsent(input: {
    refresh: string
    access: string
    expires: number
    email?: string
  }): boolean {
    if (!input.refresh) return false
    const store = readStore(this.path)

    const exists = store.accounts.some((a) => {
      if (a.refresh === input.refresh) return true
      if (input.email && a.email === input.email) return true
      return false
    })
    if (exists) return false

    store.accounts.push({
      id: crypto.randomUUID(),
      label: input.email ?? `Account ${store.accounts.length + 1}`,
      email: input.email,
      refresh: input.refresh,
      access: input.access,
      expires: input.expires,
      cooldownUntil: 0,
    })
    writeStore(this.path, store)
    return true
  }

  /**
   * Set (or update) an account's email, and use it as the display label. Also
   * collapses any other stored logins of the same Claude account. No-op if the
   * account no longer exists.
   */
  setEmail(id: string, email: string): void {
    if (!email) return
    const store = readStore(this.path)
    const account = store.accounts.find((a) => a.id === id)
    if (!account) return
    account.email = email
    account.label = email
    collapseDuplicates(store)
    writeStore(this.path, store)
  }

  /**
   * Set an account's email by matching its refresh token, and use it as the
   * display label. Lets us label the account currently held in OpenCode's
   * primary slot (which we address by token, not by store id). Also collapses
   * duplicate logins of the same Claude account. No-op if no account matches.
   */
  setEmailByRefresh(refresh: string, email: string): void {
    if (!refresh || !email) return
    const store = readStore(this.path)
    const account = store.accounts.find((a) => a.refresh === refresh)
    if (!account) return
    account.email = email
    account.label = email
    collapseDuplicates(store)
    writeStore(this.path, store)
  }

  /** Remove an account by id. Returns true if something was removed. */
  remove(id: string): boolean {
    const store = readStore(this.path)
    const before = store.accounts.length
    store.accounts = store.accounts.filter((a) => a.id !== id)
    if (store.accounts.length === before) return false
    writeStore(this.path, store)
    return true
  }

  /**
   * Collapse any duplicate logins of the same Claude account (same email) into
   * a single entry. Returns the number of duplicate entries removed.
   */
  dedupe(): number {
    const store = readStore(this.path)
    const before = store.accounts.length
    if (collapseDuplicates(store)) {
      writeStore(this.path, store)
    }
    return before - store.accounts.length
  }

  /**
   * Persist rotated tokens for an account after a successful refresh.
   * No-op if the account no longer exists.
   */
  updateTokens(
    id: string,
    tokens: { refresh: string; access: string; expires: number },
  ): void {
    const store = readStore(this.path)
    const account = store.accounts.find((a) => a.id === id)
    if (!account) return
    account.refresh = tokens.refresh
    account.access = tokens.access
    account.expires = tokens.expires
    account.cooldownUntil = 0
    account.lastError = undefined
    writeStore(this.path, store)
  }

  /**
   * Persist rotated tokens for the account whose CURRENT refresh token is
   * `oldRefresh`. Used to keep the stored copy of the primary account in sync
   * when OpenCode rotates its token (so the account can still be used after it
   * is later demoted from primary). No-op if nothing matches.
   */
  updateTokensByRefresh(
    oldRefresh: string,
    tokens: { refresh: string; access: string; expires: number },
  ): void {
    if (!oldRefresh) return
    const store = readStore(this.path)
    const account = store.accounts.find((a) => a.refresh === oldRefresh)
    if (!account) return
    account.refresh = tokens.refresh
    account.access = tokens.access
    account.expires = tokens.expires
    account.cooldownUntil = 0
    account.lastError = undefined
    writeStore(this.path, store)
  }

  /**
   * Flag the account matching `refresh` as the primary (OpenCode's current
   * credential) and clear the flag on all others. Writes only when the flags
   * actually change, so it's cheap to call on every request.
   */
  setPrimaryByRefresh(refresh: string): void {
    if (!refresh) return
    const store = readStore(this.path)
    let changed = false
    for (const account of store.accounts) {
      const shouldBePrimary = account.refresh === refresh
      if (shouldBePrimary && account.primary !== true) {
        account.primary = true
        changed = true
      } else if (!shouldBePrimary && account.primary) {
        account.primary = undefined
        changed = true
      }
    }
    if (changed) writeStore(this.path, store)
  }

  /**
   * Mark an account as cooling down (rate-limited / usage-limited) until the
   * given epoch-ms timestamp. Selection skips it until then.
   */
  markCooldown(id: string, until: number, reason?: string): void {
    const store = readStore(this.path)
    const account = store.accounts.find((a) => a.id === id)
    if (!account) return
    account.cooldownUntil = until
    if (reason) account.lastError = reason
    writeStore(this.path, store)
  }

  /**
   * Cool down the account matching `refresh`. Used to cool the store entry that
   * mirrors OpenCode's primary slot (addressed by token, not store id) so a
   * rate-limited primary is skipped after it's demoted. No-op if none matches.
   */
  markCooldownByRefresh(refresh: string, until: number, reason?: string): void {
    if (!refresh) return
    const store = readStore(this.path)
    const account = store.accounts.find((a) => a.refresh === refresh)
    if (!account) return
    account.cooldownUntil = until
    if (reason) account.lastError = reason
    writeStore(this.path, store)
  }

  /**
   * Return accounts eligible for use right now (cooldown expired), ordered so
   * the caller can try them in sequence. Accounts whose cooldown has naturally
   * elapsed are considered available again.
   */
  available(now: number = Date.now()): Account[] {
    return readStore(this.path).accounts.filter(
      (a) => !a.cooldownUntil || a.cooldownUntil <= now,
    )
  }
}

/**
 * Parse a `retry-after` header (seconds or HTTP-date) into an epoch-ms
 * timestamp. Falls back to `defaultMs` from `now` when absent/unparseable.
 */
export function computeCooldownUntil(
  retryAfter: string | null,
  now: number = Date.now(),
  defaultMs = 60_000,
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return now + seconds * 1000
    }
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) {
      return Math.max(date, now)
    }
  }
  return now + defaultMs
}
