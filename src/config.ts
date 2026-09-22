import { CLAUDE_CODE_VERSION } from './constants.ts'

/**
 * Environment variable that overrides the reported Claude Code version.
 *
 * Anthropic gates model access on the reported version server-side, and that
 * gate moves on Anthropic's schedule rather than this plugin's release
 * schedule. The override lets users unblock a newly-gated model without
 * waiting for a published bump.
 */
export const ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR =
  'ANTHROPIC_CLAUDE_CODE_VERSION'

/**
 * Claude Code releases are `major.minor.patch` with numeric components.
 *
 * Leading zeros are rejected: `02.1.280` is not a release Anthropic publishes,
 * so accepting it would report a version string no server-side gate expects.
 */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MAX_VERSION_LENGTH = 64

/**
 * Is `candidate` an older Claude Code release than `baseline`?
 *
 * Both arguments must already match `VERSION_PATTERN`. Components are compared
 * numerically rather than lexically — `2.1.99` sorts after `2.1.280` as a
 * string but is the older release — and as `BigInt`, so an unbounded component
 * cannot silently lose precision the way `Number` would.
 */
function isOlderVersion(candidate: string, baseline: string): boolean {
  // The `0n` defaults are unreachable — `VERSION_PATTERN` guarantees exactly
  // three components — but they keep the destructuring free of assertions.
  const [major = 0n, minor = 0n, patch = 0n] = candidate
    .split('.')
    .map((part) => BigInt(part))
  const [baseMajor = 0n, baseMinor = 0n, basePatch = 0n] = baseline
    .split('.')
    .map((part) => BigInt(part))

  if (major !== baseMajor) return major < baseMajor
  if (minor !== baseMinor) return minor < baseMinor
  return patch < basePatch
}

/**
 * Outcome of reading the version override.
 *
 * The invalid arm carries no version: a malformed override must never reach
 * the request path, so callers cannot accidentally report one. The outdated
 * arm does carry one — an explicit older version is still honoured — but pairs
 * it with the warning explaining why reporting it is risky.
 */
export type ClaudeCodeVersionResolution =
  | { readonly type: 'success'; readonly version: string }
  | {
      readonly type: 'outdated'
      readonly version: string
      readonly warning: string
    }
  | { readonly type: 'invalid'; readonly error: string }

/**
 * Resolve the Claude Code version to report to Anthropic.
 *
 * Returns the bundled version when the override is unset. A set override is
 * trimmed and must look like a Claude Code release; anything else resolves to
 * `invalid` with a message describing how to correct it. An override older
 * than the bundled version resolves to `outdated`: it is still reported, since
 * it was set deliberately, but it can lock the user out of newer models.
 * Never throws.
 */
export function resolveClaudeCodeVersion(
  raw: string | undefined = process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR],
): ClaudeCodeVersionResolution {
  if (raw === undefined) {
    return { type: 'success', version: CLAUDE_CODE_VERSION }
  }

  const trimmed = raw.length <= MAX_VERSION_LENGTH ? raw.trim() : ''
  if (!VERSION_PATTERN.test(trimmed)) {
    return {
      type: 'invalid',
      error:
        `${ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR} is not a valid Claude Code version. ` +
        `Expected major.minor.patch (for example, ${CLAUDE_CODE_VERSION}). ` +
        `Reporting the bundled version ${CLAUDE_CODE_VERSION} instead; correct or unset ` +
        `${ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR} and restart OpenCode to use the override.`,
    }
  }

  if (isOlderVersion(trimmed, CLAUDE_CODE_VERSION)) {
    return {
      type: 'outdated',
      version: trimmed,
      warning:
        `${ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR} is set to ${JSON.stringify(trimmed)}, which is older ` +
        `than the bundled Claude Code version ${CLAUDE_CODE_VERSION}. Anthropic gates model access on ` +
        `the reported version, so reporting an older one can make newer models reject the request. ` +
        `Set ${ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR} to ${CLAUDE_CODE_VERSION} or newer — or unset it ` +
        `to use the bundled version — and restart OpenCode.`,
    }
  }

  return { type: 'success', version: trimmed }
}
