import { createHash } from 'node:crypto'
import { CCH_POSITIONS, CCH_SALT, CLAUDE_CODE_VERSION } from './constants'

type Message = {
  role?: string
  content?: string | Array<{ type?: string; text?: string }>
}

/**
 * Extract text from the first user message's first text block.
 */
export function extractFirstUserMessageText(messages: Message[]): string {
  const userMsg = messages.find((message) => message.role === 'user')
  if (!userMsg) return ''

  const { content } = userMsg
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const textBlock = content.find((block) => block.type === 'text')
    if (textBlock?.text) return textBlock.text
  }

  return ''
}

/**
 * Compute cch: first 5 hex characters of SHA-256(messageText).
 */
export function computeCCH(messageText: string): string {
  return createHash('sha256').update(messageText).digest('hex').slice(0, 5)
}

/**
 * Compute the 3-char version suffix from the sampled message characters.
 */
export function computeVersionSuffix(
  messageText: string,
  version: string = CLAUDE_CODE_VERSION,
): string {
  const chars = CCH_POSITIONS.map((index) => messageText[index] || '0').join('')

  return createHash('sha256')
    .update(`${CCH_SALT}${chars}${version}`)
    .digest('hex')
    .slice(0, 3)
}

/**
 * Build the complete billing header string for insertion into system[0].
 */
export function buildBillingHeaderValue(
  messages: Message[],
  version: string = CLAUDE_CODE_VERSION,
  entrypoint: string,
): string {
  const text = extractFirstUserMessageText(messages)
  const suffix = computeVersionSuffix(text, version)
  const cch = computeCCH(text)

  return (
    'x-anthropic-billing-header: ' +
    `cc_version=${version}.${suffix}; ` +
    `cc_entrypoint=${entrypoint}; ` +
    `cch=${cch};`
  )
}
