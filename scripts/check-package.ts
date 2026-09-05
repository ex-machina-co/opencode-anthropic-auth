import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const REQUIRED_FILES = ['package.json', 'dist/index.js', 'dist/index.d.ts']
const PACKAGE_ROOT_FILES = new Set(['LICENSE', 'README.md', 'package.json'])

function fail(message: string): never {
  throw new Error(`[check:package] ${message}`)
}

function run(command: string[], cwd: string): Uint8Array {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim()
    fail(`${command.join(' ')} failed${stderr ? `:\n${stderr}` : '.'}`)
  }

  return result.stdout
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const temporaryRoot = mkdtempSync(
  join(tmpdir(), 'opencode-anthropic-auth-package-'),
)

try {
  const output = new TextDecoder().decode(
    run(
      [
        'npm',
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        temporaryRoot,
      ],
      PROJECT_ROOT,
    ),
  )
  const packResult: unknown = JSON.parse(output)
  const packEntries = Array.isArray(packResult)
    ? packResult
    : isRecord(packResult)
      ? Object.values(packResult)
      : []

  if (packEntries.length !== 1 || !isRecord(packEntries[0])) {
    fail('npm pack returned an unexpected result.')
  }

  const [{ filename, files }] = packEntries
  if (typeof filename !== 'string' || !Array.isArray(files)) {
    fail('npm pack did not report a tarball and file list.')
  }

  const paths = files.flatMap((file) =>
    isRecord(file) && typeof file.path === 'string' ? [file.path] : [],
  )
  const pathSet = new Set(paths)

  for (const required of REQUIRED_FILES) {
    if (!pathSet.has(required)) {
      fail(`packed tarball is missing ${required}.`)
    }
  }

  const unexpected = paths.filter(
    (path) => !path.startsWith('dist/') && !PACKAGE_ROOT_FILES.has(path),
  )
  if (unexpected.length > 0) {
    fail(`packed tarball contains unexpected files: ${unexpected.join(', ')}.`)
  }

  const tarball = resolve(temporaryRoot, filename)
  if (!existsSync(tarball)) {
    fail(`npm pack did not create ${filename}.`)
  }

  const extractedRoot = resolve(temporaryRoot, 'extracted')
  mkdirSync(extractedRoot)
  run(['tar', '-xzf', tarball, '-C', extractedRoot], PROJECT_ROOT)

  const extractedPackage = resolve(extractedRoot, 'package')
  symlinkSync(
    resolve(PROJECT_ROOT, 'node_modules'),
    resolve(extractedPackage, 'node_modules'),
    'junction',
  )

  const module: unknown = await import(
    pathToFileURL(resolve(extractedPackage, 'dist/index.js')).href
  )
  if (!isRecord(module) || Object.keys(module).join(',') !== 'default') {
    fail('packed entrypoint must export only a default plugin.')
  }

  const plugin = module.default
  if (
    !isRecord(plugin) ||
    plugin.id !== 'ex-machina.anthropic-auth' ||
    typeof plugin.setup !== 'function'
  ) {
    fail('packed entrypoint is not the OpenCode v2 Anthropic auth plugin.')
  }

  const integrationMethods: unknown[] = []
  await plugin.setup({
    integration: {
      transform: async (
        transform: (editor: {
          method: { update: (input: unknown) => void }
        }) => void,
      ) => {
        transform({
          method: {
            update: (input) => integrationMethods.push(input),
          },
        })
        return { dispose: async () => {} }
      },
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
    session: {
      hook: async () => ({ dispose: async () => {} }),
    },
  })

  const registration = integrationMethods[0]
  if (
    integrationMethods.length !== 1 ||
    !isRecord(registration) ||
    registration.integrationID !== 'anthropic' ||
    !isRecord(registration.method) ||
    registration.method.id !== 'claude-max' ||
    registration.method.type !== 'oauth' ||
    registration.method.label !== 'Claude Pro/Max' ||
    typeof registration.authorize !== 'function' ||
    typeof registration.refresh !== 'function'
  ) {
    fail('packed plugin did not register the Claude Pro/Max OAuth method.')
  }

  console.log(
    `[check:package] Verified ${filename} (${paths.length} packaged files) and Claude Pro/Max registration.`,
  )
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
