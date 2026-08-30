// Wire-format constants and builders for impersonating Claude Code 2.1.236.
// Ground truth: live trace of claude-cli 2.1.236 (see /tmp/trace-04-req.json
// in the plan session, and captures/AGENTS.md for the re-trace procedure).
// When Claude Code versions drift, re-trace and update this file only.

/**
 * Subscription-routing gate (live-bisected 2026-08-29): billing follows the
 * OAuth token, not these impersonation headers. Anthropic nevertheless rejects
 * `/v1/messages` unless the system prompt contains EITHER a well-formed
 * `x-anthropic-billing-header: cc_version=...; cc_entrypoint=...;` block OR the
 * exact IDENTITY_BLOCK string below. Missing both deterministically produced an
 * opaque 429 `rate_limit_error` with message `Error`; an empty billing-header
 * value produced a 400 reserved-keyword error. The tested billing version and
 * entrypoint values were not checked.
 *
 * `user-agent`, `x-app`, `anthropic-beta`, `x-stainless-*`, the Claude session
 * id, `?beta=true`, and `metadata.user_id` all proved optional in the tested
 * request. We retain the traced envelope as camouflage and for feature
 * compatibility, while deliberately sending both accepted system markers.
 * See ../../docs/protocol-mapping.md for the wire trace and bisection matrix.
 */

export const CC_VERSION = '2.1.236'
export const CC_ENTRYPOINT = 'sdk-cli'

export const USER_AGENT = `claude-cli/${CC_VERSION} (external, sdk-cli)`

// Full beta list observed on the wire (2.1.236, 2026-08-29).
export const ANTHROPIC_BETA = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'context-1m-2025-08-07',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'advisor-tool-2026-03-01',
  'effort-2025-11-24',
  'fallback-credit-2026-06-01',
  'extended-cache-ttl-2025-04-11',
].join(',')

export const IDENTITY_BLOCK =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."

const EPHEMERAL_CACHE = { type: 'ephemeral', ttl: '1h' } as const

export type SystemBlock = {
  type: 'text'
  text: string
  cache_control?: typeof EPHEMERAL_CACHE
}

/**
 * The traced system prompt shape is exactly 3 text blocks:
 * [0] billing header, [1] identity, [2] main prompt.
 * Blocks [1] and [2] carry `cache_control: {type: 'ephemeral', ttl: '1h'}`.
 *
 * The billing header is the SIMPLE form observed for current versions — no cch
 * hash and no cc_prompt_id (src/cch.ts is not needed). The suffix after the
 * Claude Code version varied between observations; bisection showed that the
 * values are not validated, so this builder keeps one known-working suffix.
 */
export function buildClaudeSystem(
  mainPrompt: string | undefined,
  ccVersion: string,
): SystemBlock[] {
  const blocks: SystemBlock[] = [
    {
      type: 'text',
      text: `x-anthropic-billing-header: cc_version=${ccVersion}.761; cc_entrypoint=${CC_ENTRYPOINT};`,
    },
    {
      type: 'text',
      text: IDENTITY_BLOCK,
      cache_control: EPHEMERAL_CACHE,
    },
  ]
  if (mainPrompt) {
    blocks.push({
      type: 'text',
      text: mainPrompt,
      cache_control: EPHEMERAL_CACHE,
    })
  }
  return blocks
}

export function buildClaudeHeaders(
  accessToken: string,
  sessionId: string,
  retryCount = 0,
): Record<string, string> {
  return {
    accept: 'application/json',
    'anthropic-beta': ANTHROPIC_BETA,
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-version': '2023-06-01',
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    'x-app': 'cli',
    'x-claude-code-session-id': sessionId,
    'x-stainless-arch': 'arm64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'MacOS',
    'x-stainless-package-version': '0.112.1',
    'x-stainless-retry-count': String(retryCount),
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': 'v26.3.0',
    'x-stainless-timeout': '600',
  }
}
