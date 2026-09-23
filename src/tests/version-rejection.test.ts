import { describe, expect, test } from 'bun:test'
import {
  detectClaudeCodeVersionRejection,
  parseClaudeCodeVersionRejection,
} from '../version-rejection'

function rejectionBody(
  rejectedVersion = '2.1.280',
  requiredVersion = '2.1.281',
) {
  return JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message:
        `Claude Code ${rejectedVersion} does not support this model; ` +
        `version ${requiredVersion} or newer is required. Run 'claude update', ` +
        'or update the Claude desktop app, then try again.',
      details: { error_code: 'claude_code_version_too_old' },
    },
    request_id: 'req_fixture_version_gate',
  })
}

describe('Claude Code version rejection', () => {
  test('parses the exact structured error and a newer real floor', () => {
    expect(parseClaudeCodeVersionRejection(rejectionBody(), '2.1.280')).toEqual(
      {
        rejectedVersion: '2.1.280',
        requiredVersion: '2.1.281',
      },
    )
  })

  test.each([
    ['wrong error code', { error_code: 'some_other_error' }],
    ['missing error code', {}],
  ])('rejects a %s', (_label, details) => {
    const body = JSON.parse(rejectionBody())
    body.error.details = details
    expect(
      parseClaudeCodeVersionRejection(JSON.stringify(body), '2.1.280'),
    ).toBeUndefined()
  })

  test.each([
    ['mismatched rejected version', rejectionBody('2.1.279', '2.1.281')],
    ['equal required version', rejectionBody('2.1.280', '2.1.280')],
    ['older required version', rejectionBody('2.1.280', '2.1.279')],
    ['malformed required version', rejectionBody('2.1.280', '999')],
    ['non-JSON body', 'not json'],
  ])('rejects %s', (_label, body) => {
    expect(parseClaudeCodeVersionRejection(body, '2.1.280')).toBeUndefined()
  })

  test('inspects a clone without consuming the provider response', async () => {
    const body = rejectionBody()
    const response = new Response(body, {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })

    await expect(
      detectClaudeCodeVersionRejection(response, '2.1.280'),
    ).resolves.toEqual({
      rejectedVersion: '2.1.280',
      requiredVersion: '2.1.281',
    })
    expect(await response.text()).toBe(body)
  })

  test('ignores non-400 and oversized responses', async () => {
    await expect(
      detectClaudeCodeVersionRejection(
        new Response(rejectionBody(), { status: 429 }),
        '2.1.280',
      ),
    ).resolves.toBeUndefined()

    await expect(
      detectClaudeCodeVersionRejection(
        new Response('x', {
          status: 400,
          headers: { 'content-length': String(16 * 1024 + 1) },
        }),
        '2.1.280',
      ),
    ).resolves.toBeUndefined()
  })
})
