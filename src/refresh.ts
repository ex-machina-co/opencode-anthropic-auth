import { CLIENT_ID, TOKEN_URL } from './constants.ts'

export type RefreshedTokens = {
  refresh: string
  access: string
  expires: number
}

/**
 * Exchange a refresh token for a fresh access token, retrying transient
 * failures (5xx and network errors) with exponential backoff.
 *
 * Throws on non-transient failures (e.g. 401/403 — an invalidated refresh
 * token) so callers can fail over to another account.
 */
export async function refreshAccessToken(
  refreshToken: string,
  options: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<RefreshedTokens> {
  const maxRetries = options.maxRetries ?? 2
  const baseDelayMs = options.baseDelayMs ?? 500

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }

      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'axios/1.13.6',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }),
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

      return {
        refresh: json.refresh_token,
        access: json.access_token,
        expires: Date.now() + json.expires_in * 1000,
      }
    } catch (error) {
      const isNetworkError =
        error instanceof Error &&
        (error.message.includes('fetch failed') ||
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
