import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR,
  resolveClaudeCodeVersion,
} from '../config'
import { CLAUDE_CODE_VERSION } from '../constants'

describe('resolveClaudeCodeVersion', () => {
  const originalEnv = process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]

  beforeEach(() => {
    delete process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]
    } else {
      process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = originalEnv
    }
  })

  test('uses the bundled version when unset', () => {
    expect(resolveClaudeCodeVersion()).toEqual({
      type: 'success',
      version: CLAUDE_CODE_VERSION,
    })
  })

  test('reads the override from the environment', () => {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = '2.9.99'

    expect(resolveClaudeCodeVersion()).toEqual({
      type: 'success',
      version: '2.9.99',
    })
  })

  test('reads and trims a valid override', () => {
    expect(resolveClaudeCodeVersion('  2.9.99\n')).toEqual({
      type: 'success',
      version: '2.9.99',
    })
  })

  // Fixtures are written relative to the bundled version, so a bundled bump
  // that changes their ordering is meant to fail loudly here.
  test.each([
    ['lower major', '1.9.999'],
    ['lower minor', '2.0.999'],
    ['lower patch', '2.1.279'],
    ['lower patch that sorts higher lexically', '2.1.99'],
  ])('flags an outdated override (%s)', (_label, raw) => {
    const result = resolveClaudeCodeVersion(raw)

    expect(result.type).toBe('outdated')
    if (result.type === 'outdated') {
      // An outdated override was still set deliberately, so it stays usable.
      expect(result.version).toBe(raw)
      expect(result.warning).toContain(ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR)
      expect(result.warning).toContain(raw)
      expect(result.warning).toContain(CLAUDE_CODE_VERSION)
    }
  })

  test.each([
    ['equal to the bundled version', CLAUDE_CODE_VERSION],
    ['higher patch', '2.1.281'],
    ['higher minor', '2.2.0'],
    ['higher major that sorts lower lexically', '10.0.0'],
    ['component beyond Number.MAX_SAFE_INTEGER', '9007199254740993.0.0'],
  ])('accepts an override that is not outdated (%s)', (_label, raw) => {
    expect(resolveClaudeCodeVersion(raw)).toEqual({
      type: 'success',
      version: raw,
    })
  })

  test.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['two components', '2.9'],
    ['four components', '2.9.99.1'],
    ['prerelease suffix', '2.9.99-beta.1'],
    ['v prefix', 'v2.9.99'],
    ['leading-zero component', '02.1.280'],
    ['leading-zero component below the bundled version', '02.1.279'],
    ['non-numeric component', '2.x.99'],
    ['tag', 'latest'],
    ['over the bounded input length', `2.${'9'.repeat(64)}.0`],
  ])('rejects a malformed override (%s)', (_label, raw) => {
    const result = resolveClaudeCodeVersion(raw)

    expect(result.type).toBe('invalid')
    if (result.type === 'invalid') {
      // The message has to be actionable on its own: it is the only thing the
      // user sees in the server log.
      expect(result.error).toContain(ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR)
      expect(result.error).toContain('major.minor.patch')
      expect(result.error).toContain(CLAUDE_CODE_VERSION)
    }
  })

  test('never throws on malformed input', () => {
    expect(() => resolveClaudeCodeVersion('nonsense')).not.toThrow()
  })

  test('does not echo malformed environment contents', () => {
    const raw = 'credential-like-private-value'
    const result = resolveClaudeCodeVersion(raw)

    expect(result.type).toBe('invalid')
    if (result.type === 'invalid') {
      expect(result.error).not.toContain(raw)
    }
  })

  test('does not expose a version on the invalid arm', () => {
    expect(resolveClaudeCodeVersion('nonsense')).not.toHaveProperty('version')
  })
})
