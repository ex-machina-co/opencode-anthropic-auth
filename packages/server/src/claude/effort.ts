export const CLAUDE_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ClaudeEffort = (typeof CLAUDE_EFFORT_LEVELS)[number]

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return (
    typeof value === 'string' &&
    (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value)
  )
}

export const CLAUDE_EFFORT_DESCRIPTION = CLAUDE_EFFORT_LEVELS.join(', ')
