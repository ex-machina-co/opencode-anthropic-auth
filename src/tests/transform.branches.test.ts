import { describe, expect, test } from 'bun:test'
import { prependClaudeCodeIdentity, rewriteUrl } from '../transform'

describe('rewriteUrl - unparseable input', () => {
  test('returns the input untouched when the URL cannot be parsed', () => {
    const result = rewriteUrl('not a valid url')
    expect(result.url).toBeNull()
    expect(result.input).toBe('not a valid url')
  })
})

describe('prependClaudeCodeIdentity - non-array system values', () => {
  test('accepts a single system block object', () => {
    const blocks = prependClaudeCodeIdentity({
      type: 'text',
      text: 'plain instructions',
    })
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toMatchObject({
      type: 'text',
      text: 'plain instructions',
    })
  })

  test('preserves extra keys on a single system block object', () => {
    const blocks = prependClaudeCodeIdentity({
      type: 'text',
      text: 'cached',
      cache_control: { type: 'ephemeral' },
    })
    expect(blocks[1]).toMatchObject({ cache_control: { type: 'ephemeral' } })
  })

  test('drops a block object without an explicit text type', () => {
    const blocks = prependClaudeCodeIdentity({ text: 'no type here' } as never)
    expect(blocks).toHaveLength(1)
  })

  test('drops array items that are neither strings nor text blocks', () => {
    const blocks = prependClaudeCodeIdentity([
      42,
      { type: 'image', source: {} },
    ])
    expect(blocks).toHaveLength(1)
  })

  test('falls back to the identity block for unsupported system values', () => {
    expect(prependClaudeCodeIdentity(true as never)).toHaveLength(1)
  })
})
