/**
 * extract-system-prompt.ts — Extract the system prompt from a mitmproxy .flow capture.
 *
 * Usage:
 *   bun run scripts/extract-system-prompt.ts <flow-file> [-o <output-file>]
 *
 * Runs `mitmdump` to dump captured /v1/messages requests, parses the JSON
 * bodies, and extracts the system prompt blocks from the request with the
 * largest system prompt (skipping short requests like title generators).
 *
 * Writes to stdout by default, or to the file specified with -o.
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    output: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
})

if (values.help || positionals.length === 0) {
  console.log(`Usage: bun run scripts/extract-system-prompt.ts <flow-file> [-o <output-file>]

Extracts the system prompt from a mitmproxy .flow capture file.

Arguments:
  <flow-file>       Path to the .flow file captured by mitmproxy

Options:
  -o, --output      Write output to a file instead of stdout
  -h, --help        Show this help message`)
  process.exit(values.help ? 0 : 1)
}

const file = positionals[0]
if (!file) throw new Error('Missing flow file argument')

const flowFile = resolve(process.cwd(), file)

// Run mitmdump to dump the flow as text, filtered to /v1/messages requests
const proc = Bun.spawn(
  ['mitmdump', '-nr', flowFile, '--flow-detail', '4', '~u', '/v1/messages'],
  { stdout: 'pipe', stderr: 'pipe' },
)

const stdout = await new Response(proc.stdout).text()
const stderr = await new Response(proc.stderr).text()
const exitCode = await proc.exited

if (exitCode !== 0) {
  console.error(`mitmdump exited with code ${exitCode}`)
  if (stderr) console.error(stderr)
  process.exit(1)
}

// Parse JSON request bodies from the mitmdump text output.
// mitmdump --flow-detail 4 prints request bodies as indented JSON blocks.
// We find them by tracking brace depth.
interface SystemBlock {
  type: string
  text: string
  cache_control?: { type: string }
}

interface RequestBody {
  model: string
  system: SystemBlock[]
  [key: string]: unknown
}

const jsonBodies: RequestBody[] = []
const lines = stdout.split('\n')
let inJson = false
let jsonBuf: string[] = []

for (const line of lines) {
  const stripped = line.trim()
  if (stripped.startsWith('{') && !inJson) {
    inJson = true
    jsonBuf = [stripped]
  } else if (inJson) {
    jsonBuf.push(stripped)
    try {
      const candidate = jsonBuf.join('\n')
      const parsed = JSON.parse(candidate)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'model' in parsed &&
        'system' in parsed
      ) {
        jsonBodies.push(parsed as RequestBody)
      }
      inJson = false
      jsonBuf = []
    } catch {
      // Not yet a complete JSON object — keep accumulating
    }
  }
}

if (jsonBodies.length === 0) {
  console.error(
    'No /v1/messages requests with system prompts found in the flow file.',
  )
  process.exit(1)
}

// Pick the request with the largest system prompt (skipping title generators)
let best: RequestBody | null = null
let bestLen = 0

for (const body of jsonBodies) {
  const systemBlocks = body.system ?? []
  const totalLen = systemBlocks.reduce(
    (sum: number, block: SystemBlock) => sum + (block.text?.length ?? 0),
    0,
  )
  if (totalLen > bestLen) {
    bestLen = totalLen
    best = body
  }
}

if (!best) {
  console.error('Could not find a request with a system prompt.')
  process.exit(1)
}

// Concatenate all system text blocks
const systemText = best.system
  .filter((block: SystemBlock) => block.type === 'text' && block.text)
  .map((block: SystemBlock) => block.text)
  .join('\n\n')

if (values.output) {
  writeFileSync(values.output, systemText + '\n')
  console.log(
    `Extracted system prompt (${systemText.length} chars) → ${values.output}`,
  )
} else {
  process.stdout.write(systemText + '\n')
}
