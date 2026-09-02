/**
 * Release guard for the OpenCode v2 (`next`) channel.
 *
 * `v2/main` publishes prereleases of the 2.x line to npm's `next` dist-tag, while
 * `main` keeps publishing the 1.x line to `latest`. Changesets happily prepares a
 * release PR for whatever version the branch currently sits at, so before the v2
 * major landed that PR can resolve to something like `1.8.2-next.0`. Publishing
 * that would put a v1-shaped prerelease on the v2 channel.
 *
 * This guard runs immediately before `changeset publish` on `v2/main` and refuses
 * to publish anything that is not a `2.x.y-next.N` prerelease.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const EXPECTED_PACKAGE_NAME = '@ex-machina/opencode-anthropic-auth'
export const EXPECTED_PRE_TAG = 'next'
export const EXPECTED_MAJOR = 2

/** `<major>.<minor>.<patch>-<EXPECTED_PRE_TAG>.<counter>`, capturing the major. */
const NEXT_VERSION_PATTERN = new RegExp(
  String.raw`^(\d+)\.\d+\.\d+-${EXPECTED_PRE_TAG}\.\d+$`,
)

/**
 * State of `.changeset/pre.json`.
 *
 * Absence is a meaningful, expected state (the branch is not in prerelease mode),
 * so it is modelled explicitly rather than as a null/undefined `raw`.
 */
export type PreStateSource =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly detail: string }
  | { readonly kind: 'present'; readonly raw: unknown }

export type ReleaseGuardVerdict =
  | {
      readonly status: 'allowed'
      readonly version: string
      readonly tag: string
    }
  | { readonly status: 'blocked'; readonly reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decide whether the current working tree may publish to the `next` channel.
 *
 * Pure: takes already-read file contents so it can be exercised without touching
 * the filesystem.
 */
export function checkNextRelease(input: {
  readonly packageJson: unknown
  readonly preState: PreStateSource
}): ReleaseGuardVerdict {
  const { packageJson, preState } = input

  if (!isRecord(packageJson)) {
    return { status: 'blocked', reason: 'package.json is not a JSON object.' }
  }

  const { name, version } = packageJson

  if (name !== EXPECTED_PACKAGE_NAME) {
    return {
      status: 'blocked',
      reason: `Expected package "${EXPECTED_PACKAGE_NAME}", found ${JSON.stringify(name)}.`,
    }
  }

  if (typeof version !== 'string') {
    return {
      status: 'blocked',
      reason: `package.json "version" must be a string, found ${JSON.stringify(version)}.`,
    }
  }

  switch (preState.kind) {
    case 'absent':
      return {
        status: 'blocked',
        reason:
          '.changeset/pre.json is missing. The v2 channel must stay in changesets pre mode; run `bun change pre enter next`.',
      }
    case 'unreadable':
      return {
        status: 'blocked',
        reason: `.changeset/pre.json could not be parsed: ${preState.detail}`,
      }
    case 'present':
      break
  }

  const pre = preState.raw

  if (!isRecord(pre)) {
    return {
      status: 'blocked',
      reason: '.changeset/pre.json is not a JSON object.',
    }
  }

  if (pre.mode !== 'pre') {
    return {
      status: 'blocked',
      reason: `Changesets is not in pre mode (mode is ${JSON.stringify(pre.mode)}). The v2 channel must never publish a stable release.`,
    }
  }

  if (pre.tag !== EXPECTED_PRE_TAG) {
    return {
      status: 'blocked',
      reason: `Changesets pre tag must be "${EXPECTED_PRE_TAG}", found ${JSON.stringify(pre.tag)}.`,
    }
  }

  const match = NEXT_VERSION_PATTERN.exec(version)

  if (!match) {
    return {
      status: 'blocked',
      reason: `Version "${version}" is not a "${EXPECTED_MAJOR}.x.y-${EXPECTED_PRE_TAG}.N" prerelease.`,
    }
  }

  const major = Number(match[1])

  if (major !== EXPECTED_MAJOR) {
    return {
      status: 'blocked',
      reason: `Version "${version}" is major ${major}; the ${EXPECTED_PRE_TAG} channel only publishes major ${EXPECTED_MAJOR}.`,
    }
  }

  return { status: 'allowed', version, tag: EXPECTED_PRE_TAG }
}

function readPackageJson(root: string): unknown {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
}

function readPreState(root: string): PreStateSource {
  let contents: string

  try {
    contents = readFileSync(resolve(root, '.changeset', 'pre.json'), 'utf8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return { kind: 'absent' }
    }
    return { kind: 'unreadable', detail: String(error) }
  }

  try {
    return { kind: 'present', raw: JSON.parse(contents) }
  } catch (error) {
    return { kind: 'unreadable', detail: String(error) }
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..')

  const verdict = checkNextRelease({
    packageJson: readPackageJson(root),
    preState: readPreState(root),
  })

  if (verdict.status === 'blocked') {
    console.error(`[release:next] Refusing to publish. ${verdict.reason}`)
    process.exit(1)
  }

  console.log(
    `[release:next] Publishing ${EXPECTED_PACKAGE_NAME}@${verdict.version} to "${verdict.tag}".`,
  )
}
