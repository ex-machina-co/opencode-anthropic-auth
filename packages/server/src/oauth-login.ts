import { createInterface } from 'node:readline/promises'
import { authorize, exchange } from '../../../src/auth.ts'
import {
  type Credentials,
  DEFAULT_CREDENTIALS_PATH,
  loadCredentials,
  saveCredentials,
} from './credentials.ts'

function generateDeviceId(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * `claude-subscription-server login` — PKCE OAuth against claude.ai
 * (reuses the plugin's src/auth.ts), then persists tokens plus a generated
 * device_id and a stable account UUID used in metadata.user_id.
 */
export async function login(
  credentialsPath: string = DEFAULT_CREDENTIALS_PATH,
): Promise<void> {
  const result = await authorize('max')

  console.log('Open this URL in your browser to authorize:')
  console.log()
  console.log(`  ${result.url}`)
  console.log()
  console.log(
    'After authorizing, paste the full callback URL (or the code#state pair) here:',
  )

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let input: string
  try {
    input = await rl.question('> ')
  } finally {
    rl.close()
  }

  const tokens = await exchange(
    input,
    result.verifier,
    result.redirectUri,
    result.state,
  )
  if (tokens.type === 'failed') {
    throw new Error('OAuth exchange failed — check the callback URL and retry')
  }

  // Keep stable identity fields across re-logins when the file already
  // exists (device_id/account_uuid feed metadata.user_id upstream).
  const existing = await loadCredentials(credentialsPath)
  const credentials: Credentials = {
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    device_id: existing?.device_id ?? generateDeviceId(),
    account_uuid: existing?.account_uuid ?? crypto.randomUUID(),
  }

  await saveCredentials(credentialsPath, credentials)
  console.log(`Credentials saved to ${credentialsPath}`)
}
