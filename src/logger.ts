import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const LOG_DIR = join(homedir(), '.config', 'opencode-anthropic-auth')
const LOG_FILE = join(LOG_DIR, 'debug.log')

try {
  mkdirSync(LOG_DIR, { recursive: true })
} catch {}

function timestamp(): string {
  return new Date().toISOString()
}

export function log(level: string, context: string, message: string, data?: Record<string, unknown>): void {
  const line = data
    ? `[${timestamp()}] ${level} [${context}] ${message} ${JSON.stringify(data, null, 2)}`
    : `[${timestamp()}] ${level} [${context}] ${message}`
  try {
    appendFileSync(LOG_FILE, line + '\n')
  } catch {}
}

export function logInfo(context: string, message: string, data?: Record<string, unknown>): void {
  log('INFO', context, message, data)
}

export function logError(context: string, message: string, data?: Record<string, unknown>): void {
  log('ERROR', context, message, data)
}

export function logDebug(context: string, message: string, data?: Record<string, unknown>): void {
  log('DEBUG', context, message, data)
}

export const LOG_PATH = LOG_FILE
