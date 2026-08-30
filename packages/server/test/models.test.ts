import { describe, expect, test } from 'bun:test'
import {
  fetchClaudeModels,
  filterModelList,
  staticModelList,
} from '../src/claude/models.ts'

describe('fetchClaudeModels', () => {
  test('fetches the OAuth catalog and maps Claude records to OpenAI models', async () => {
    let requestedUrl = ''
    let requestedInit: RequestInit | undefined
    const models = await fetchClaudeModels({
      accessToken: 'oauth-token',
      baseUrl: 'https://api.anthropic.test',
      now: 1_800_000_000_000,
      fetchFn: async (input, init) => {
        requestedUrl = String(input)
        requestedInit = init
        return Response.json({
          data: [
            {
              id: 'claude-opus-5',
              type: 'model',
              created_at: '2026-08-01T00:00:00.000Z',
            },
            { id: 'not-claude', type: 'model' },
            { id: 'claude-sonnet-5', created_at: 'not-a-date' },
            { id: 'claude-opus-5' },
            { id: 123 },
          ],
        })
      },
    })

    expect(requestedUrl).toBe('https://api.anthropic.test/v1/models?beta=true')
    expect(requestedInit?.method).toBe('GET')
    expect(new Headers(requestedInit?.headers).get('authorization')).toBe(
      'Bearer oauth-token',
    )
    expect(models).toEqual({
      object: 'list',
      data: [
        {
          id: 'claude-opus-5',
          object: 'model',
          created: 1_785_542_400,
          owned_by: 'anthropic',
        },
        {
          id: 'claude-sonnet-5',
          object: 'model',
          created: 1_800_000_000,
          owned_by: 'anthropic',
        },
      ],
    })
  })

  test('rejects non-successful or unusable upstream responses', async () => {
    await expect(
      fetchClaudeModels({
        accessToken: 'token',
        baseUrl: 'https://api.anthropic.test',
        fetchFn: async () => new Response('', { status: 503 }),
      }),
    ).rejects.toThrow('upstream models request returned 503')

    await expect(
      fetchClaudeModels({
        accessToken: 'token',
        baseUrl: 'https://api.anthropic.test',
        fetchFn: async () => Response.json({ data: [{ id: 'other-model' }] }),
      }),
    ).rejects.toThrow('contained no Claude models')
  })
})

test('staticModelList produces the fallback OpenAI shape', () => {
  expect(staticModelList(['claude-opus-5'], 1_800_000_000_000)).toEqual({
    object: 'list',
    data: [
      {
        id: 'claude-opus-5',
        object: 'model',
        created: 1_800_000_000,
        owned_by: 'anthropic',
      },
    ],
  })
})

test('filterModelList applies only an explicit allowlist', () => {
  const list = staticModelList(
    ['claude-opus-5', 'claude-fable-5'],
    1_800_000_000_000,
  )
  expect(filterModelList(list, null)).toBe(list)
  expect(filterModelList(list, ['claude-fable-5']).data).toEqual([
    expect.objectContaining({ id: 'claude-fable-5' }),
  ])
})
