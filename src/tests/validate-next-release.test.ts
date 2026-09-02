import { describe, expect, test } from 'bun:test'
import {
  checkNextRelease,
  EXPECTED_PACKAGE_NAME,
  type PreStateSource,
} from '../../scripts/validate-next-release'

const PRE_NEXT: PreStateSource = {
  kind: 'present',
  raw: {
    mode: 'pre',
    tag: 'next',
    initialVersions: { [EXPECTED_PACKAGE_NAME]: '1.8.1' },
    changesets: [],
  },
}

function check(version: string, preState: PreStateSource = PRE_NEXT) {
  return checkNextRelease({
    packageJson: { name: EXPECTED_PACKAGE_NAME, version },
    preState,
  })
}

describe('next-channel release guard', () => {
  test('allows the first v2 prerelease', () => {
    expect(check('2.0.0-next.0')).toEqual({
      status: 'allowed',
      version: '2.0.0-next.0',
      tag: 'next',
    })
  })

  test('allows later v2 prereleases', () => {
    expect(check('2.3.1-next.12')).toEqual({
      status: 'allowed',
      version: '2.3.1-next.12',
      tag: 'next',
    })
  })

  test('blocks the interim 1.x prerelease that changesets prepares before the v2 major lands', () => {
    const verdict = check('1.8.2-next.0')

    expect(verdict.status).toBe('blocked')
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('major 1'),
    })
  })

  test('blocks a stable 2.x release', () => {
    const verdict = check('2.0.0')

    expect(verdict.status).toBe('blocked')
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('prerelease'),
    })
  })

  test('blocks a prerelease that is not tagged next', () => {
    const verdict = check('2.0.0-beta.0')

    expect(verdict.status).toBe('blocked')
  })

  test('blocks when changesets is in pre mode under a different tag', () => {
    const verdict = check('2.0.0-next.0', {
      kind: 'present',
      raw: { mode: 'pre', tag: 'beta' },
    })

    expect(verdict.status).toBe('blocked')
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('pre tag'),
    })
  })

  test('blocks when pre mode has been exited', () => {
    const verdict = check('2.0.0-next.0', {
      kind: 'present',
      raw: { mode: 'exit', tag: 'next' },
    })

    expect(verdict.status).toBe('blocked')
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('not in pre mode'),
    })
  })

  test('blocks when pre.json is absent', () => {
    const verdict = check('2.0.0-next.0', { kind: 'absent' })

    expect(verdict.status).toBe('blocked')
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('pre.json is missing'),
    })
  })

  test('blocks when pre.json cannot be parsed', () => {
    const verdict = check('2.0.0-next.0', {
      kind: 'unreadable',
      detail: 'SyntaxError: Unexpected end of JSON input',
    })

    expect(verdict.status).toBe('blocked')
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('could not be parsed'),
    })
  })

  test('blocks when pre.json is not an object', () => {
    const verdict = check('2.0.0-next.0', { kind: 'present', raw: 'pre' })

    expect(verdict.status).toBe('blocked')
  })

  test('blocks a different package', () => {
    const verdict = checkNextRelease({
      packageJson: { name: '@someone-else/plugin', version: '2.0.0-next.0' },
      preState: PRE_NEXT,
    })

    expect(verdict.status).toBe('blocked')
    expect(verdict).toMatchObject({
      reason: expect.stringContaining(EXPECTED_PACKAGE_NAME),
    })
  })

  test('blocks a missing version', () => {
    const verdict = checkNextRelease({
      packageJson: { name: EXPECTED_PACKAGE_NAME },
      preState: PRE_NEXT,
    })

    expect(verdict.status).toBe('blocked')
  })

  test('blocks a package.json that is not an object', () => {
    const verdict = checkNextRelease({ packageJson: null, preState: PRE_NEXT })

    expect(verdict.status).toBe('blocked')
  })
})
