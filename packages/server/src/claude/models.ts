import type { OpenAIModel, OpenAIModelList } from '../openai/types.ts'

type UpstreamModel = {
  id?: unknown
  created_at?: unknown
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type ClaudeModelsOptions = {
  accessToken: string
  baseUrl: string
  signal?: AbortSignal
  fetchFn?: FetchLike
  now?: number
}

function createdAtSeconds(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : fallback
}

function toOpenAIModel(
  model: UpstreamModel,
  fallbackCreated: number,
): OpenAIModel | null {
  if (typeof model.id !== 'string' || !model.id.startsWith('claude-')) {
    return null
  }
  return {
    id: model.id,
    object: 'model',
    created: createdAtSeconds(model.created_at, fallbackCreated),
    owned_by: 'anthropic',
  }
}

export function staticModelList(
  ids: readonly string[],
  now = Date.now(),
): OpenAIModelList {
  const created = Math.floor(now / 1000)
  return {
    object: 'list',
    data: ids.map((id) => ({
      id,
      object: 'model',
      created,
      owned_by: 'anthropic',
    })),
  }
}

export function filterModelList(
  list: OpenAIModelList,
  allowlist: readonly string[] | null,
): OpenAIModelList {
  if (allowlist === null) return list
  const allowed = new Set(allowlist)
  return {
    object: 'list',
    data: list.data.filter((model) => allowed.has(model.id)),
  }
}

/**
 * Fetch Anthropic's live OAuth-visible catalog and translate its model records
 * into the OpenAI `/v1/models` shape. Callers own fallback behavior.
 */
export async function fetchClaudeModels(
  opts: ClaudeModelsOptions,
): Promise<OpenAIModelList> {
  const fetchFn = opts.fetchFn ?? fetch
  const response = await fetchFn(`${opts.baseUrl}/v1/models?beta=true`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'anthropic-version': '2023-06-01',
      authorization: `Bearer ${opts.accessToken}`,
    },
    signal: opts.signal,
  })

  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`upstream models request returned ${response.status}`)
  }

  const json = (await response.json()) as { data?: unknown }
  if (!Array.isArray(json.data)) {
    throw new Error('upstream models response did not contain a data array')
  }

  const fallbackCreated = Math.floor((opts.now ?? Date.now()) / 1000)
  const seen = new Set<string>()
  const data: OpenAIModel[] = []
  for (const raw of json.data) {
    if (!raw || typeof raw !== 'object') continue
    const model = toOpenAIModel(raw as UpstreamModel, fallbackCreated)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    data.push(model)
  }
  if (data.length === 0) {
    throw new Error('upstream models response contained no Claude models')
  }

  return { object: 'list', data }
}
