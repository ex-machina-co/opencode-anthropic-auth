import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CLIENT_ID, TOKEN_URL } from '../../../src/constants.ts'

export const DEFAULT_CREDENTIALS_PATH = join(
  homedir(),
  '.config',
  'claude-subscription-server',
  'auth.json',
)

export const REFRESH_TIMEOUT_MS = 10_000

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type CredentialStoreOptions = {
  fetchFn?: FetchLike
  refreshTimeoutMs?: number
  sleep?: (delayMs: number) => Promise<void>
}

export type Credentials = {
  access: string
  refresh: string
  expires: number
  device_id: string
  account_uuid: string
}

export async function loadCredentials(
  path: string,
): Promise<Credentials | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const json = JSON.parse(raw) as Partial<Credentials>
    if (
      typeof json.access !== 'string' ||
      typeof json.refresh !== 'string' ||
      typeof json.expires !== 'number' ||
      typeof json.device_id !== 'string' ||
      typeof json.account_uuid !== 'string'
    ) {
      throw new Error(`credentials file at ${path} is malformed`)
    }
    return json as Credentials
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function saveCredentials(
  path: string,
  credentials: Credentials,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    // Keep the temporary file beside the target so rename is atomic. Readers
    // then see either the complete old credentials or the complete rotated
    // credentials, never a file truncated by an in-place write.
    await writeFile(temporaryPath, JSON.stringify(credentials, null, 2), {
      flag: 'wx',
      mode: 0o600,
    })
    // `mode` can be narrowed by umask; explicit chmod guarantees exactly 600.
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

export class CredentialStore {
  private cached: Credentials | null = null
  private refreshPromise: Promise<string> | null = null

  constructor(
    private path: string,
    private options: CredentialStoreOptions = {},
  ) {}

  async load(): Promise<Credentials | null> {
    this.cached = await loadCredentials(this.path)
    return this.cached
  }

  /** Requires getAccessToken() (or load()) to have run first. */
  getCached(): Credentials {
    if (!this.cached) {
      throw new Error('credentials not loaded')
    }
    return this.cached
  }

  /**
   * Returns a usable access token, refreshing (single-flight) when expired.
   * Refresh logic ported from the OpenCode plugin (src/index.ts): 2 retries,
   * 500ms exponential backoff, re-read the latest refresh token each attempt
   * (rotation-safe), persist rotated tokens to the credentials file.
   */
  async getAccessToken(): Promise<string> {
    if (!this.cached) {
      const loaded = await this.load()
      if (!loaded) {
        throw new Error(
          `no credentials at ${this.path} — run \`claude-subscription-server login\` first`,
        )
      }
    }

    const creds = this.cached as Credentials
    if (creds.expires > Date.now() + 60_000) {
      return creds.access
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshWithRetry().finally(() => {
        this.refreshPromise = null
      })
    }
    return this.refreshPromise
  }

  private async refreshWithRetry(): Promise<string> {
    const maxRetries = 2
    const baseDelayMs = 500

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = baseDelayMs * 2 ** (attempt - 1)
          await (
            this.options.sleep ??
            ((delayMs) =>
              new Promise((resolve) => setTimeout(resolve, delayMs)))
          )(delay)
        }

        // Re-read from disk to get the latest refresh token — it may have
        // been rotated by another process since we cached it.
        const latest = (await this.load()) as Credentials

        const response = await (this.options.fetchFn ?? fetch)(TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*',
            'User-Agent': 'axios/1.13.6',
          },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: latest.refresh,
            client_id: CLIENT_ID,
          }),
          signal: AbortSignal.timeout(
            this.options.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS,
          ),
        })

        if (!response.ok) {
          if (response.status >= 500 && attempt < maxRetries) {
            await response.body?.cancel()
            continue
          }
          const body = await response.text().catch(() => '')
          throw new Error(`Token refresh failed: ${response.status} — ${body}`)
        }

        const json = (await response.json()) as {
          refresh_token: string
          access_token: string
          expires_in: number
        }

        this.cached = {
          ...latest,
          access: json.access_token,
          refresh: json.refresh_token,
          expires: Date.now() + json.expires_in * 1000,
        }
        await saveCredentials(this.path, this.cached)

        return json.access_token
      } catch (error) {
        const isNetworkError =
          error instanceof Error &&
          (error.name === 'TimeoutError' ||
            error.message.includes('fetch failed') ||
            ('code' in error &&
              (error.code === 'ECONNRESET' ||
                error.code === 'ECONNREFUSED' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'UND_ERR_CONNECT_TIMEOUT')))

        if (attempt < maxRetries && isNetworkError) {
          continue
        }

        throw error
      }
    }
    // Unreachable — each iteration either returns or throws.
    throw new Error('Token refresh exhausted all retries')
  }
}
