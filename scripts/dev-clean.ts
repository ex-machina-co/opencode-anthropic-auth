import { existsSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

const SYMLINK_PATH = resolve(import.meta.dirname, '..', '.opencode', 'plugins', 'anthropic-auth.js')

if (existsSync(SYMLINK_PATH)) {
  unlinkSync(SYMLINK_PATH)
  console.log('[dev:clean] Removed symlink')
} else {
  console.log('[dev:clean] No symlink found, nothing to clean')
}
