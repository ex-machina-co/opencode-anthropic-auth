#!/usr/bin/env bun
/**
 * Bumps the version in package.json, commits, and pushes.
 * Pushing the version change to main triggers the CI publish workflow.
 *
 * Usage: bun script/bump.ts [patch|minor|major] [--dry-run]
 */

import { $ } from 'bun'

const dir = new URL('..', import.meta.url).pathname
process.chdir(dir)

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const bumpType = args[0] || 'patch'
const dry = process.argv.includes('--dry-run')

const log = (msg: string) => console.log(dry ? `[DRY RUN] ${msg}` : msg)

// Read current version
const currentPkg = await Bun.file('./package.json').json()
log(`Current version: ${currentPkg.version}`)
log(`Bumping ${bumpType}...`)

// Bump version in package.json
if (!dry) {
  await $`npm version ${bumpType} --no-git-tag-version`
}

// Read the new version
const pkg = await Bun.file('./package.json').json()
const version = pkg.version

log(`New version: ${version}`)

// Commit and push — CI will handle npm publish
if (!dry) {
  await $`git add package.json`
  await $`git commit -m ${`chore: bump to ${version}`}`
  await $`git push`
}

log(`Done!`)
