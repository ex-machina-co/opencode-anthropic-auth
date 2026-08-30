import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../src/config.ts'
import { mapUsage, toAnthropicBody } from '../src/openai/translate.ts'
import {
  BadRequestError,
  type ChatCompletionRequest,
} from '../src/openai/types.ts'

const ctx = {
  config: loadConfig({ SERVER_API_KEY: 'test-local-key' }),
  deviceId: 'dev'.repeat(16),
  accountUuid: '00000000-0000-0000-0000-000000000000',
  sessionId: '11111111-2222-3333-4444-555555555555',
}

function translate(req: Partial<ChatCompletionRequest>) {
  return toAnthropicBody(
    {
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      ...req,
    },
    ctx,
  )
}

describe('system prompt', () => {
  test('3-block system keeps the traced shape and gate markers', () => {
    const body = translate({
      messages: [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(body.system).toHaveLength(3)
    expect(body.system[0]).toEqual({
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2.1.236.761; cc_entrypoint=sdk-cli;',
    })
    expect(body.system[1]!.text).toBe(
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    )
    expect(body.system[1]!.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(body.system[2]).toEqual({
      type: 'text',
      text: 'Be helpful.',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    })
  })

  test('system as content-part array is flattened', () => {
    const body = translate({
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Part one.' },
            { type: 'text', text: 'Part two.' },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(body.system).toHaveLength(3)
    expect(body.system[2]!.text).toBe('Part one.\n\nPart two.')
  })

  test('valid mid-conversation system message stays a message', () => {
    const body = translate({
      messages: [
        { role: 'system', content: 'global' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'mid-turn reminder' },
        { role: 'assistant', content: 'understood' },
      ],
    })
    expect(body.system[2]!.text).toBe('global')
    expect(body.messages).toHaveLength(3)
    expect(body.messages[1]!).toEqual({
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'mid-turn reminder',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
    })
    expect(body.messages[2]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'understood' }],
    })
  })

  test('mid-conversation system messages may be final or consecutive', () => {
    const final = translate({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'first reminder' },
        { role: 'system', content: 'second reminder' },
      ],
    })
    expect(final.messages.map((message) => message.role)).toEqual([
      'user',
      'system',
      'system',
    ])
  })

  test('rejects invalid mid-conversation system ordering', () => {
    expect(() =>
      translate({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'system', content: 'reminder' },
          { role: 'user', content: 'invalid follower' },
        ],
      }),
    ).toThrow(
      'mid-conversation system messages must be final or immediately followed by an assistant turn',
    )

    expect(() =>
      translate({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'reply' },
          { role: 'system', content: 'invalid placement' },
        ],
      }),
    ).toThrow(
      'mid-conversation system messages must immediately follow a user turn',
    )
  })

  test('no system message → billing + identity only', () => {
    const body = translate({})
    expect(body.system).toHaveLength(2)
  })
})

describe('messages', () => {
  test('user content parts become text blocks', () => {
    const body = translate({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
    })
    expect(body.messages[0]!).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    })
  })

  test('data: image_url becomes a base64 image block', () => {
    const body = translate({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,aGVsbG8=' },
            },
          ],
        },
      ],
    })
    expect(body.messages[0]!.content[0]!).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    })
  })

  test('remote image_url is rejected', () => {
    expect(() =>
      translate({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/x.png' },
              },
            ],
          },
        ],
      }),
    ).toThrow(BadRequestError)
  })

  test('assistant tool_calls become tool_use blocks', () => {
    const body = translate({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
    })
    expect(body.messages[1]!).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'get_weather',
          input: { city: 'Paris' },
        },
      ],
    })
    // consecutive tool messages merge into one user message
    expect(body.messages[2]!).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'sunny' },
      ],
    })
  })

  test('multiple consecutive tool messages merge, is_error passthrough', () => {
    const body = translate({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'a',
              type: 'function',
              function: { name: 'f1', arguments: '{}' },
            },
            {
              id: 'b',
              type: 'function',
              function: { name: 'f2', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'a', content: 'ok' },
        { role: 'tool', tool_call_id: 'b', content: 'boom', is_error: true },
      ],
    })
    expect(body.messages[1]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
      {
        type: 'tool_result',
        tool_use_id: 'b',
        content: 'boom',
        is_error: true,
      },
    ])
  })

  test('invalid tool_call arguments are a 400', () => {
    expect(() =>
      translate({
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'a',
                type: 'function',
                function: { name: 'f', arguments: '{oops' },
              },
            ],
          },
        ],
      }),
    ).toThrow(BadRequestError)
  })

  test('unsupported message roles are a 400', () => {
    expect(() =>
      translate({
        messages: [
          { role: 'developer', content: 'nope' } as unknown as {
            role: 'system'
            content: string
          },
        ],
      }),
    ).toThrow('unsupported message role: developer')
  })
})

describe('tools and sampling params', () => {
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: 'get_weather',
        description: 'Get weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
      },
    },
  ]

  test('tools map to plain name/description/input_schema', () => {
    const body = translate({ tools })
    expect(body.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Get weather',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
      },
    ])
  })

  test('tool_choice variants', () => {
    expect(translate({ tool_choice: 'auto' }).tool_choice).toEqual({
      type: 'auto',
    })
    expect(translate({ tool_choice: 'none' }).tool_choice).toEqual({
      type: 'none',
    })
    expect(translate({ tool_choice: 'required' }).tool_choice).toEqual({
      type: 'any',
    })
    expect(
      translate({
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      }).tool_choice,
    ).toEqual({ type: 'tool', name: 'get_weather' })
  })

  test('parallel_tool_calls false disables parallel tool use', () => {
    expect(
      translate({ parallel_tool_calls: false }).disable_parallel_tool_use,
    ).toBe(true)
    expect(
      translate({ parallel_tool_calls: true }).disable_parallel_tool_use,
    ).toBeUndefined()
  })

  test('sampling params pass through', () => {
    const body = translate({
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 100,
      stop: ['END', 'STOP'],
    })
    expect(body.temperature).toBe(0.5)
    expect(body.top_p).toBe(0.9)
    expect(body.max_tokens).toBe(100)
    expect(body.stop_sequences).toEqual(['END', 'STOP'])
  })
})

describe('traced defaults and validation', () => {
  test('defaults match the 2.1.236 trace', () => {
    const body = translate({})
    expect(body.max_tokens).toBe(64000)
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'omitted' })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.stream).toBe(true)
  })

  test('metadata.user_id is the traced JSON shape', () => {
    const body = translate({})
    expect(JSON.parse(body.metadata.user_id)).toEqual({
      device_id: ctx.deviceId,
      account_uuid: ctx.accountUuid,
      session_id: ctx.sessionId,
    })
  })

  test('all model IDs are accepted by default', () => {
    expect(translate({ model: 'claude-fable-5' }).model).toBe('claude-fable-5')
    expect(translate({ model: 'claude-future-model' }).model).toBe(
      'claude-future-model',
    )
  })

  test('an explicit model allowlist is enforced', () => {
    const restricted = {
      ...ctx,
      config: loadConfig({
        SERVER_API_KEY: 'test-local-key',
        CLAUDE_MODELS: 'claude-opus-5',
      }),
    }
    expect(() =>
      toAnthropicBody(
        {
          model: 'claude-fable-5',
          messages: [{ role: 'user', content: 'hi' }],
        },
        restricted,
      ),
    ).toThrow(/unknown model/)
  })

  test('model must be a non-empty string even when all models are allowed', () => {
    expect(() => translate({ model: '' })).toThrow(
      'model must be a non-empty string',
    )
    expect(() => translate({ model: undefined as unknown as string })).toThrow(
      'model must be a non-empty string',
    )
  })

  test('reasoning_effort overrides CC_EFFORT for all supported levels', () => {
    for (const reasoning_effort of [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ] as const) {
      expect(translate({ reasoning_effort }).output_config).toEqual({
        effort: reasoning_effort,
      })
    }
    expect(translate({ reasoning_effort: null }).output_config).toEqual({
      effort: 'high',
    })
  })

  test('unsupported reasoning_effort is a 400', () => {
    expect(() => translate({ reasoning_effort: 'minimal' as 'low' })).toThrow(
      'reasoning_effort must be one of: low, medium, high, xhigh, max',
    )
  })

  test('empty messages are a 400', () => {
    expect(() => translate({ messages: [] })).toThrow(BadRequestError)
  })

  test('usage includes cache creation and cache reads in prompt totals', () => {
    expect(
      mapUsage({
        input_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 5,
        output_tokens: 7,
        output_tokens_details: { thinking_tokens: 4 },
      }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 7,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 5 },
      completion_tokens_details: { reasoning_tokens: 4 },
    })
  })
})
