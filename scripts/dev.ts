import {
  existsSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname!, '..')
const PLUGINS_DIR = resolve(PROJECT_ROOT, '.opencode', 'plugins')
const SYMLINK_PATH = resolve(PLUGINS_DIR, 'anthropic-auth.js')
const TARGET = '../../dist/index.js' // relative from .opencode/plugins/

function createSymlink() {
  mkdirSync(PLUGINS_DIR, { recursive: true })

  if (existsSync(SYMLINK_PATH)) {
    try {
      const current = readlinkSync(SYMLINK_PATH)
      if (current === TARGET) {
        console.log(`[dev] Symlink already exists: ${SYMLINK_PATH} -> ${TARGET}`)
        return
      }
    } catch {}
    unlinkSync(SYMLINK_PATH)
  }

  symlinkSync(TARGET, SYMLINK_PATH)
  console.log(`[dev] Created symlink: ${SYMLINK_PATH} -> ${TARGET}`)
}

function removeSymlink() {
  try {
    unlinkSync(SYMLINK_PATH)
    console.log('[dev] Removed symlink')
  } catch {}
}

// --- Main ---

// 1. Build first
console.log('[dev] Running initial build...')
const build = Bun.spawnSync(['tsc', '-p', 'tsconfig.build.json'], {
  cwd: PROJECT_ROOT,
  stdout: 'inherit',
  stderr: 'inherit',
})
if (build.exitCode !== 0) {
  console.error('[dev] Build failed, aborting')
  process.exit(1)
}

// 2. Create symlink
createSymlink()

// 3. Start tsc --watch
console.log('[dev] Starting tsc --watch...')
console.log('[dev] Restart OpenCode to pick up the linked plugin.')
const child = Bun.spawn(['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], {
  cwd: PROJECT_ROOT,
  stdout: 'inherit',
  stderr: 'inherit',
})

function cleanup() {
  console.log('\n[dev] Cleaning up...')
  child.kill()
  removeSymlink()
  process.exit(0)
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)

await child.exited
