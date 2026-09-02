import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore, computeCooldownUntil } from '../accounts'
import { isFailoverStatus } from '../failover'

let dir: string
let storePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-test-'))
  storePath = join(dir, 'accounts.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('AccountStore', () => {
  test('starts empty when file does not exist', () => {
    const store = new AccountStore(storePath)
    expect(store.list()).toEqual([])
    expect(store.available()).toEqual([])
  })

  test('add creates a file with the account', () => {
    const store = new AccountStore(storePath)
    const account = store.add({
      refresh: 'r1',
      access: 'a1',
      expires: 123,
    })
    expect(existsSync(storePath)).toBe(true)
    expect(account.id).toBeString()
    expect(account.label).toBe('Account 1')
    expect(store.list()).toHaveLength(1)
  })

  test('add dedupes by refresh token and updates tokens', () => {
    const store = new AccountStore(storePath)
    const first = store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    const second = store.add({ refresh: 'r1', access: 'a2', expires: 2 })
    expect(store.list()).toHaveLength(1)
    expect(second.id).toBe(first.id)
    expect(store.list()[0]!.access).toBe('a2')
    expect(store.list()[0]!.expires).toBe(2)
  })

  test('add assigns incrementing default labels', () => {
    const store = new AccountStore(storePath)
    store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    const second = store.add({ refresh: 'r2', access: 'a2', expires: 2 })
    expect(second.label).toBe('Account 2')
  })

  test('add uses email as the label when provided', () => {
    const store = new AccountStore(storePath)
    const account = store.add({
      refresh: 'r1',
      access: 'a1',
      expires: 1,
      email: 'me@example.com',
    })
    expect(account.email).toBe('me@example.com')
    expect(account.label).toBe('me@example.com')
  })

  test('add backfills email + label on an existing account', () => {
    const store = new AccountStore(storePath)
    store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    const updated = store.add({
      refresh: 'r1',
      access: 'a2',
      expires: 2,
      email: 'me@example.com',
    })
    expect(store.list()).toHaveLength(1)
    expect(updated.email).toBe('me@example.com')
    expect(updated.label).toBe('me@example.com')
  })

  test('add dedupes by email: re-login with same account, new token → one entry', () => {
    const store = new AccountStore(storePath)
    store.add({
      refresh: 'r1',
      access: 'a1',
      expires: 1,
      email: 'me@example.com',
    })
    // Same account logs in again → different refresh token, same email.
    store.add({
      refresh: 'r2-new',
      access: 'a2',
      expires: 2,
      email: 'me@example.com',
    })
    const list = store.list()
    expect(list).toHaveLength(1)
    // The single entry has the newest tokens.
    expect(list[0]!.refresh).toBe('r2-new')
    expect(list[0]!.access).toBe('a2')
    expect(list[0]!.email).toBe('me@example.com')
  })

  test('add keeps distinct emails as separate accounts', () => {
    const store = new AccountStore(storePath)
    store.add({ refresh: 'r1', access: 'a1', expires: 1, email: 'a@x.com' })
    store.add({ refresh: 'r2', access: 'a2', expires: 2, email: 'b@x.com' })
    expect(store.list()).toHaveLength(2)
  })

  test('addIfAbsent inserts a new account when none matches', () => {
    const store = new AccountStore(storePath)
    expect(
      store.addIfAbsent({ refresh: 'r1', access: 'a1', expires: 123 }),
    ).toBe(true)
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.refresh).toBe('r1')
    expect(list[0]!.cooldownUntil).toBe(0)
  })

  test('addIfAbsent leaves an existing entry (and its tokens) untouched', () => {
    const store = new AccountStore(storePath)
    store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    // Unlike add()'s upsert, this must NOT overwrite the stored tokens.
    expect(
      store.addIfAbsent({ refresh: 'r1', access: 'a2-new', expires: 999 }),
    ).toBe(false)
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.access).toBe('a1')
    expect(list[0]!.expires).toBe(1)
  })

  test('addIfAbsent preserves an existing cooldown (never revives it)', () => {
    const store = new AccountStore(storePath)
    const account = store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    const until = Date.now() + 100_000
    store.markCooldown(account.id, until, 'HTTP 429')
    // Re-persisting the same credential must keep the account cooling down.
    expect(store.addIfAbsent({ refresh: 'r1', access: 'a1', expires: 1 })).toBe(
      false,
    )
    const updated = store.list()[0]!
    expect(updated.cooldownUntil).toBe(until)
    expect(updated.lastError).toBe('HTTP 429')
    expect(store.available()).toHaveLength(0)
  })

  test('addIfAbsent dedupes by email when the email is known', () => {
    const store = new AccountStore(storePath)
    store.add({ refresh: 'r1', access: 'a1', expires: 1, email: 'me@x.com' })
    // Same account (same email), rotated refresh token → no new entry.
    expect(
      store.addIfAbsent({
        refresh: 'r2-rotated',
        access: 'a2',
        expires: 2,
        email: 'me@x.com',
      }),
    ).toBe(false)
    expect(store.list()).toHaveLength(1)
  })

  test('addIfAbsent ignores an empty refresh token', () => {
    const store = new AccountStore(storePath)
    expect(store.addIfAbsent({ refresh: '', access: 'a', expires: 1 })).toBe(
      false,
    )
    expect(store.list()).toHaveLength(0)
  })

  test('setEmail collapses a newly-discovered duplicate into the existing one', () => {
    const store = new AccountStore(storePath)
    const a = store.add({ refresh: 'r1', access: 'a1', expires: 10 })
    const b = store.add({ refresh: 'r2', access: 'a2', expires: 20 })
    // Label a first with the email.
    store.setEmail(a.id, 'dup@example.com')
    // Now b turns out to be the SAME account.
    store.setEmail(b.id, 'dup@example.com')
    const list = store.list()
    expect(list).toHaveLength(1)
    // Freshest (larger expires) wins when neither is primary.
    expect(list[0]!.expires).toBe(20)
    expect(list[0]!.email).toBe('dup@example.com')
  })

  test('dedupe() collapses pre-existing duplicates and reports the count', () => {
    const store = new AccountStore(storePath)
    // Two logins of the same account already labeled (e.g. from an older
    // version that did not dedupe).
    store.add({ refresh: 'r1', access: 'a1', expires: 10, email: 'x@x.com' })
    // Bypass add()'s dedupe by writing a second same-email entry via setEmail
    // on a distinct refresh, simulating legacy data.
    const b = store.add({ refresh: 'r2', access: 'a2', expires: 20 })
    // Manually give b the same email WITHOUT collapsing by editing the file.
    const fs = require('node:fs')
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'))
    for (const acc of raw.accounts) {
      if (acc.id === b.id) acc.email = 'x@x.com'
    }
    fs.writeFileSync(storePath, JSON.stringify(raw))

    expect(store.list()).toHaveLength(2)
    const removed = store.dedupe()
    expect(removed).toBe(1)
    expect(store.list()).toHaveLength(1)
    expect(store.dedupe()).toBe(0)
  })

  test('collapse keeps the primary account when duplicates exist', () => {
    const store = new AccountStore(storePath)
    const a = store.add({ refresh: 'r1', access: 'a1', expires: 100 })
    const b = store.add({ refresh: 'r2', access: 'a2', expires: 5 })
    // Mark the OLDER-token account primary.
    store.setPrimaryByRefresh('r2')
    store.setEmail(a.id, 'dup@example.com')
    store.setEmail(b.id, 'dup@example.com')
    const list = store.list()
    expect(list).toHaveLength(1)
    // Primary wins even though its token expires sooner.
    expect(list[0]!.refresh).toBe('r2')
    expect(list[0]!.primary).toBe(true)
  })

  test('setEmail updates email + label by id', () => {
    const store = new AccountStore(storePath)
    const account = store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    store.setEmail(account.id, 'x@example.com')
    const updated = store.list()[0]!
    expect(updated.email).toBe('x@example.com')
    expect(updated.label).toBe('x@example.com')
    // Empty email is ignored.
    store.setEmail(account.id, '')
    expect(store.list()[0]!.email).toBe('x@example.com')
  })

  test('setEmailByRefresh updates the matching account', () => {
    const store = new AccountStore(storePath)
    store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    store.add({ refresh: 'r2', access: 'a2', expires: 2 })
    store.setEmailByRefresh('r2', 'second@example.com')
    expect(store.list().find((a) => a.refresh === 'r2')!.label).toBe(
      'second@example.com',
    )
    expect(store.list().find((a) => a.refresh === 'r1')!.email).toBeUndefined()
    // Unknown refresh is a no-op (no throw).
    store.setEmailByRefresh('missing', 'x@example.com')
  })

  test('setPrimaryByRefresh flags exactly one account', () => {
    const store = new AccountStore(storePath)
    store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    store.add({ refresh: 'r2', access: 'a2', expires: 2 })

    store.setPrimaryByRefresh('r1')
    expect(store.list().find((a) => a.refresh === 'r1')!.primary).toBe(true)
    expect(
      store.list().find((a) => a.refresh === 'r2')!.primary,
    ).toBeUndefined()

    // Switching primary clears the previous one.
    store.setPrimaryByRefresh('r2')
    expect(
      store.list().find((a) => a.refresh === 'r1')!.primary,
    ).toBeUndefined()
    expect(store.list().find((a) => a.refresh === 'r2')!.primary).toBe(true)

    // Exactly one primary at all times.
    expect(store.list().filter((a) => a.primary)).toHaveLength(1)
  })

  test('updateTokensByRefresh rotates tokens for the matching account', () => {
    const store = new AccountStore(storePath)
    store.add({ refresh: 'old', access: 'a1', expires: 1 })
    store.updateTokensByRefresh('old', {
      refresh: 'new',
      access: 'a2',
      expires: 2,
    })
    const updated = store.list()[0]!
    expect(updated.refresh).toBe('new')
    expect(updated.access).toBe('a2')
    expect(updated.expires).toBe(2)
    // Unknown refresh is a no-op.
    store.updateTokensByRefresh('missing', {
      refresh: 'x',
      access: 'x',
      expires: 9,
    })
    expect(store.list()[0]!.refresh).toBe('new')
  })

  test('remove deletes an account by id', () => {
    const store = new AccountStore(storePath)
    const account = store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    expect(store.remove(account.id)).toBe(true)
    expect(store.list()).toHaveLength(0)
    expect(store.remove('missing')).toBe(false)
  })

  test('updateTokens rotates tokens and clears cooldown', () => {
    const store = new AccountStore(storePath)
    const account = store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    store.markCooldown(account.id, Date.now() + 100_000, 'rate limited')
    store.updateTokens(account.id, {
      refresh: 'r2',
      access: 'a2',
      expires: 999,
    })
    const updated = store.list()[0]!
    expect(updated.refresh).toBe('r2')
    expect(updated.access).toBe('a2')
    expect(updated.expires).toBe(999)
    expect(updated.cooldownUntil).toBe(0)
    expect(updated.lastError).toBeUndefined()
  })

  test('markCooldown removes account from available until it expires', () => {
    const store = new AccountStore(storePath)
    const account = store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    const now = Date.now()
    store.markCooldown(account.id, now + 60_000, 'HTTP 429')

    expect(store.available(now)).toHaveLength(0)
    // After cooldown elapses it becomes available again.
    expect(store.available(now + 61_000)).toHaveLength(1)
  })

  test('tolerates corrupt json without throwing', () => {
    const store = new AccountStore(storePath)
    store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    // Corrupt the file.
    require('node:fs').writeFileSync(storePath, '{ not json', 'utf8')
    expect(store.list()).toEqual([])
  })
})

describe('computeCooldownUntil', () => {
  test('uses retry-after seconds', () => {
    const now = 1_000_000
    expect(computeCooldownUntil('30', now)).toBe(now + 30_000)
  })

  test('uses retry-after http-date', () => {
    const now = Date.parse('2030-01-01T00:00:00Z')
    const future = new Date(now + 45_000).toUTCString()
    expect(computeCooldownUntil(future, now)).toBe(Date.parse(future))
  })

  test('falls back to default when absent', () => {
    const now = 1_000_000
    expect(computeCooldownUntil(null, now, 60_000)).toBe(now + 60_000)
  })

  test('falls back to default when unparseable', () => {
    const now = 1_000_000
    expect(computeCooldownUntil('not-a-number', now, 60_000)).toBe(now + 60_000)
  })
})

describe('isFailoverStatus', () => {
  test('treats 429/401/403/529 as failover', () => {
    expect(isFailoverStatus(429)).toBe(true)
    expect(isFailoverStatus(401)).toBe(true)
    expect(isFailoverStatus(403)).toBe(true)
    expect(isFailoverStatus(529)).toBe(true)
  })

  test('treats 200/400/500 as non-failover', () => {
    expect(isFailoverStatus(200)).toBe(false)
    expect(isFailoverStatus(400)).toBe(false)
    expect(isFailoverStatus(500)).toBe(false)
  })
})
