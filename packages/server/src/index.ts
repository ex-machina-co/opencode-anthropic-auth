import { callClaude } from './claude/client.ts'
import {
  fetchClaudeModels,
  filterModelList,
  staticModelList,
} from './claude/models.ts'
import { loadConfig } from './config.ts'
import { CredentialStore } from './credentials.ts'
import { login } from './oauth-login.ts'
import { translateUpstreamError } from './openai/errors.ts'
import { collectChatCompletion, translateToOpenAISSE } from './openai/stream.ts'
import { toAnthropicBody } from './openai/translate.ts'
import { BadRequestError, type OpenAIError } from './openai/types.ts'

const loginMode = process.argv[2] === 'login'
const config = loadConfig(process.env, { requireApiKey: !loginMode })

// ---------------------------------------------------------------------------
// `claude-subscription-server login`

if (loginMode) {
  try {
    await login(config.credentialsPath)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
} else {
  serve()
}

// ---------------------------------------------------------------------------
// Server

function serve() {
  const store = new CredentialStore(config.credentialsPath)
  const apiKey = config.apiKey
  if (!apiKey) {
    throw new Error('SERVER_API_KEY is required when starting the server')
  }

  function errorBody(
    message: string,
    status: number,
    type = 'invalid_request_error',
  ): Response {
    const body: OpenAIError = {
      error: { message, type, code: type },
    }
    return Response.json(body, { status })
  }

  async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(input),
    )
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  /**
   * Session UUID for x-claude-code-session-id + metadata.user_id. Stable
   * per OpenAI `user` field so repeated turns of one conversation share an
   * upstream session (cache-friendly); random per request otherwise.
   */
  async function sessionIdFor(user: string | undefined): Promise<string> {
    if (!user) return crypto.randomUUID()
    const hash = await sha256Hex(user)
    return [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join('-')
  }

  function authorized(req: Request): boolean {
    return req.headers.get('authorization') === `Bearer ${apiKey}`
  }

  async function handleModels(req: Request): Promise<Response> {
    try {
      const accessToken = await store.getAccessToken()
      const models = filterModelList(
        await fetchClaudeModels({
          accessToken,
          baseUrl: config.anthropicBaseUrl,
          signal: req.signal,
        }),
        config.modelAllowlist,
      )
      return Response.json(models)
    } catch (error) {
      console.warn(
        `upstream model discovery failed; using CLAUDE_MODELS fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return Response.json(staticModelList(config.fallbackModels))
    }
  }

  async function handleChatCompletions(req: Request): Promise<Response> {
    let requestJson: { stream?: boolean; user?: string } & Parameters<
      typeof toAnthropicBody
    >[0]
    try {
      requestJson = (await req.json()) as typeof requestJson
    } catch {
      return errorBody('request body must be valid JSON', 400)
    }

    let accessToken: string
    let body: ReturnType<typeof toAnthropicBody>
    let sessionId: string
    try {
      // Fail fast on client errors (unknown model, bad shape) before
      // touching credentials or the network.
      if (typeof requestJson.model !== 'string' || !requestJson.model.trim()) {
        throw new BadRequestError('model must be a non-empty string')
      }
      if (
        config.modelAllowlist !== null &&
        !config.modelAllowlist.includes(requestJson.model)
      ) {
        throw new BadRequestError(
          `unknown model: ${requestJson.model} (available: ${config.modelAllowlist.join(', ')})`,
        )
      }
      // Loads credentials (and refreshes if needed) before translation so
      // metadata.user_id can carry the real device/account identity.
      accessToken = await store.getAccessToken()
      const credentials = store.getCached()
      sessionId = await sessionIdFor(requestJson.user)
      body = toAnthropicBody(requestJson, {
        config,
        deviceId: credentials.device_id,
        accountUuid: credentials.account_uuid,
        sessionId,
      })
    } catch (error) {
      if (error instanceof BadRequestError) {
        return errorBody(error.message, 400)
      }
      return errorBody(
        error instanceof Error ? error.message : String(error),
        401,
        'authentication_error',
      )
    }

    let upstream: Response
    try {
      upstream = await callClaude({
        body,
        accessToken,
        sessionId,
        baseUrl: config.anthropicBaseUrl,
        signal: req.signal,
      })
    } catch (error) {
      return errorBody(
        `upstream request failed: ${error instanceof Error ? error.message : error}`,
        502,
      )
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '')
      return Response.json(translateUpstreamError(upstream.status, text), {
        status: upstream.status,
      })
    }

    if (requestJson.stream === true) {
      return new Response(translateToOpenAISSE(upstream.body), {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      })
    }

    const result = await collectChatCompletion(upstream.body)
    if ('error' in result) {
      return Response.json(result, { status: 502 })
    }
    return Response.json(result)
  }

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === '/healthz') {
        return Response.json({ ok: true })
      }

      if (!authorized(req)) {
        return Response.json(
          {
            error: {
              message: 'missing or invalid bearer token',
              type: 'authentication_error',
              code: 'authentication_error',
            },
          },
          { status: 401 },
        )
      }

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        return handleModels(req)
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        return handleChatCompletions(req)
      }

      return errorBody('not found', 404)
    },
  })

  console.log(
    `claude-subscription-server listening on http://${config.host}:${server.port}`,
  )
  if (config.modelAllowlist === null) {
    console.log(
      `models: all upstream models (fallback: ${config.fallbackModels.join(', ')})`,
    )
  } else {
    console.log(`models: ${config.modelAllowlist.join(', ')}`)
  }
  console.log(
    `effort: ${config.effort} (override per request with reasoning_effort)`,
  )
  console.log(`upstream: ${config.anthropicBaseUrl}`)
}
