import {
  CLAUDE_EFFORT_DESCRIPTION,
  type ClaudeEffort,
  isClaudeEffort,
} from './claude/effort.ts'
import { CC_VERSION } from './claude/wire.ts'
import { DEFAULT_CREDENTIALS_PATH } from './credentials.ts'

export const DEFAULT_CLAUDE_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
] as const

export type ServerConfig = {
  port: number
  host: string
  /** null is allowed only for the login subcommand. */
  apiKey: string | null
  anthropicBaseUrl: string
  credentialsPath: string
  /** Static list used only when live model discovery is unavailable. */
  fallbackModels: string[]
  /** null means accept every model ID and let Anthropic validate it. */
  modelAllowlist: string[] | null
  ccVersion: string
  effort: ClaudeEffort
}

export type LoadConfigOptions = {
  /** The login subcommand does not open a server and therefore needs no key. */
  requireApiKey?: boolean
}

function parseModelList(value: string | undefined): string[] | null {
  if (value === undefined) return null
  const models = value
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
  return models.length ? models : null
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  )
}

export function normalizeAnthropicBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('ANTHROPIC_BASE_URL must be a valid URL')
  }

  if (url.username || url.password) {
    throw new Error('ANTHROPIC_BASE_URL must not contain credentials')
  }
  if (url.search || url.hash) {
    throw new Error('ANTHROPIC_BASE_URL must not contain a query or fragment')
  }

  const secure = url.protocol === 'https:'
  const loopbackDebugProxy =
    url.protocol === 'http:' && isLoopbackHostname(url.hostname)
  if (!secure && !loopbackDebugProxy) {
    throw new Error(
      'ANTHROPIC_BASE_URL must use HTTPS (plaintext HTTP is allowed only for localhost or IP loopback debug proxies)',
    )
  }

  return url.href.replace(/\/$/, '')
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadConfigOptions = {},
): ServerConfig {
  const modelAllowlist = parseModelList(env.CLAUDE_MODELS)
  const effort = env.CC_EFFORT ?? 'high'
  if (!isClaudeEffort(effort)) {
    throw new Error(`CC_EFFORT must be one of: ${CLAUDE_EFFORT_DESCRIPTION}`)
  }
  const apiKey = env.SERVER_API_KEY?.trim() || null
  if ((options.requireApiKey ?? true) && !apiKey) {
    throw new Error(
      'SERVER_API_KEY is required when starting the server; set it to a strong local bearer secret',
    )
  }

  return {
    port: Number(env.PORT ?? 8080),
    host: '127.0.0.1',
    apiKey,
    anthropicBaseUrl: normalizeAnthropicBaseUrl(
      env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    ),
    credentialsPath: env.CREDENTIALS_PATH ?? DEFAULT_CREDENTIALS_PATH,
    fallbackModels: modelAllowlist ?? [...DEFAULT_CLAUDE_MODELS],
    modelAllowlist,
    ccVersion: env.CC_VERSION ?? CC_VERSION,
    effort,
  }
}
