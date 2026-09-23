import { contentLength, readBoundedText } from './bounded.ts'
import {
  compareClaudeCodeVersions,
  isValidClaudeCodeVersion,
} from './config.ts'

const VERSION_TOO_OLD_CODE = 'claude_code_version_too_old'
const MAX_REJECTION_BODY_BYTES = 16 * 1024
const MAX_REJECTION_MESSAGE_LENGTH = 1024
const VERSION_REJECTION_PATTERN =
  /^Claude Code ([0-9.]{1,64}) does not support this model; version ([0-9.]{1,64}) or newer is required\./

export interface ClaudeCodeVersionRejection {
  readonly rejectedVersion: string
  readonly requiredVersion: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Parse only Anthropic's structured minimum-version rejection.
 *
 * The error code is authoritative; the bounded message supplies the versions.
 * Requiring the rejected version to equal what this setup actually sent keeps
 * an unrelated or stale response from changing later requests.
 */
export function parseClaudeCodeVersionRejection(
  body: string,
  reportedVersion: string,
): ClaudeCodeVersionRejection | undefined {
  if (body.length > MAX_REJECTION_BODY_BYTES) return undefined

  let decoded: unknown
  try {
    decoded = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(decoded) || decoded.type !== 'error') return undefined

  const error = decoded.error
  if (!isRecord(error) || error.type !== 'invalid_request_error') {
    return undefined
  }
  const details = error.details
  if (!isRecord(details) || details.error_code !== VERSION_TOO_OLD_CODE) {
    return undefined
  }
  if (
    typeof error.message !== 'string' ||
    error.message.length > MAX_REJECTION_MESSAGE_LENGTH
  ) {
    return undefined
  }

  const match = VERSION_REJECTION_PATTERN.exec(error.message)
  if (!match) return undefined
  const rejectedVersion = match[1]
  const requiredVersion = match[2]
  if (
    !rejectedVersion ||
    !requiredVersion ||
    !isValidClaudeCodeVersion(rejectedVersion) ||
    !isValidClaudeCodeVersion(requiredVersion) ||
    rejectedVersion !== reportedVersion ||
    compareClaudeCodeVersions(requiredVersion, reportedVersion) !== 1
  ) {
    return undefined
  }

  return { rejectedVersion, requiredVersion }
}

/**
 * Inspect a clone so the provider still receives the original response body.
 * Any malformed, oversized, non-JSON, or non-400 response is ignored.
 */
export async function detectClaudeCodeVersionRejection(
  response: Response,
  reportedVersion: string,
): Promise<ClaudeCodeVersionRejection | undefined> {
  if (response.status !== 400) return undefined
  const declaredLength = contentLength(response.headers)
  if (
    declaredLength !== undefined &&
    declaredLength > MAX_REJECTION_BODY_BYTES
  ) {
    return undefined
  }

  try {
    const body = await readBoundedText(
      response.clone().body,
      MAX_REJECTION_BODY_BYTES,
      'Anthropic version rejection',
    )
    return parseClaudeCodeVersionRejection(body, reportedVersion)
  } catch {
    return undefined
  }
}
