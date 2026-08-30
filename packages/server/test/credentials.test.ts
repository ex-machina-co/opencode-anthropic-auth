import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, open, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialStore,
  type Credentials,
  loadCredentials,
  saveCredentials,
} from '../src/credentials.ts'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

async function expiredCredentialPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-server-creds-'))
  tempDirectories.push(directory)
  const path = join(directory, 'auth.json')
  const credentials: Credentials = {
    access: 'expired-access',
    refresh: 'refresh-token',
    expires: 0,
    device_id: 'device-id',
    account_uuid: 'account-uuid',
  }
  await saveCredentials(path, credentials)
  return path
}

describe('credential persistence', () => {
  test('atomically replaces the shared file with mode 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-server-creds-'))
    tempDirectories.push(directory)
    const path = join(directory, 'auth.json')
    const original: Credentials = {
      access: 'original-access',
      refresh: 'original-refresh',
      expires: 1,
      device_id: 'device-id',
      account_uuid: 'account-uuid',
    }
    const rotated: Credentials = {
      ...original,
      access: 'rotated-access',
      refresh: 'rotated-refresh',
      expires: 2,
    }

    await saveCredentials(path, original)
    const originalHandle = await open(path, 'r')
    try {
      await saveCredentials(path, rotated)

      // An open handle continues to reference the complete old inode. An
      // in-place truncate/write would instead expose the replacement bytes.
      const oldSnapshot = JSON.parse(
        await originalHandle.readFile('utf8'),
      ) as Credentials
      expect(oldSnapshot).toEqual(original)
    } finally {
      await originalHandle.close()
    }

    expect(await loadCredentials(path)).toEqual(rotated)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).toEqual(['auth.json'])
  })
})

describe('CredentialStore refresh timeout', () => {
  test('retries TimeoutError and persists rotated credentials', async () => {
    const path = await expiredCredentialPath()
    const signals: AbortSignal[] = []
    const delays: number[] = []
    let attempts = 0
    const store = new CredentialStore(path, {
      refreshTimeoutMs: 1_000,
      sleep: async (delay) => {
        delays.push(delay)
      },
      fetchFn: async (_input, init) => {
        attempts++
        if (init?.signal) signals.push(init.signal)
        if (attempts < 3) {
          throw new DOMException('The operation timed out.', 'TimeoutError')
        }
        return Response.json({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        })
      },
    })

    await expect(store.getAccessToken()).resolves.toBe('new-access')
    expect(attempts).toBe(3)
    expect(delays).toEqual([500, 1_000])
    expect(signals).toHaveLength(3)
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true)
    expect(await loadCredentials(path)).toMatchObject({
      access: 'new-access',
      refresh: 'new-refresh',
    })
  })

  test('aborts every stalled token request within a bounded timeout', async () => {
    const path = await expiredCredentialPath()
    let attempts = 0
    const store = new CredentialStore(path, {
      refreshTimeoutMs: 10,
      sleep: async () => {},
      fetchFn: (_input, init) => {
        attempts++
        const signal = init?.signal
        if (!signal) throw new Error('missing refresh timeout signal')
        return new Promise((_resolve, reject) => {
          const rejectWithReason = () => reject(signal.reason)
          if (signal.aborted) rejectWithReason()
          else
            signal.addEventListener('abort', rejectWithReason, { once: true })
        })
      },
    })

    const started = Date.now()
    await expect(store.getAccessToken()).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    expect(attempts).toBe(3)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
