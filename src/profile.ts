import { PROFILE_URL, USER_AGENT } from './constants.ts'

/**
 * The OAuth-specific beta flag. The profile endpoint is an OAuth metadata
 * endpoint, so we send only this — not the `/v1/messages` inference betas.
 */
const OAUTH_BETA = 'oauth-2025-04-20'

export type AccountProfile = {
  email?: string
  organizationName?: string
}

/**
 * Fetch the signed-in account's profile (including email) using an OAuth access
 * token. Returns `undefined` on any failure — this is best-effort enrichment
 * and must never break auth or the request flow.
 *
 * Endpoint: `GET https://api.anthropic.com/api/oauth/profile`
 * Response shape (subset):
 *   { account: { email_address, uuid, ... }, organization: { name, ... } }
 */
export async function fetchAccountProfile(
  accessToken: string,
): Promise<AccountProfile | undefined> {
  if (!accessToken) return undefined

  try {
    const response = await fetch(PROFILE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    })

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return undefined
    }

    const json = (await response.json()) as {
      account?: { email?: string; email_address?: string }
      organization?: { name?: string }
    }

    // The profile endpoint returns `account.email`; some OAuth responses use
    // `account.email_address`. Accept either.
    const email = json.account?.email ?? json.account?.email_address
    const organizationName = json.organization?.name

    if (!email && !organizationName) return undefined
    return {
      email: typeof email === 'string' ? email : undefined,
      organizationName:
        typeof organizationName === 'string' ? organizationName : undefined,
    }
  } catch {
    return undefined
  }
}
