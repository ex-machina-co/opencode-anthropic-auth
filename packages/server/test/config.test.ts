import { describe, expect, test } from 'bun:test'
import { DEFAULT_CLAUDE_MODELS, loadConfig } from '../src/config.ts'

const SERVER_ENV = { SERVER_API_KEY: 'test-local-key' }

describe('CLAUDE_MODELS', () => {
  test('allows all models by default with the observed catalog as fallback', () => {
    const config = loadConfig(SERVER_ENV)
    expect(config.modelAllowlist).toBeNull()
    expect(config.fallbackModels).toEqual([...DEFAULT_CLAUDE_MODELS])
    expect(DEFAULT_CLAUDE_MODELS).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5-20250929',
    ])
  })

  test('uses an explicit comma-separated list as restriction and fallback', () => {
    const config = loadConfig({
      ...SERVER_ENV,
      CLAUDE_MODELS: ' claude-opus-5, claude-fable-5, ',
    })
    expect(config.modelAllowlist).toEqual(['claude-opus-5', 'claude-fable-5'])
    expect(config.fallbackModels).toEqual(['claude-opus-5', 'claude-fable-5'])
  })
})

describe('CC_EFFORT', () => {
  test('accepts every supported effort level', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(loadConfig({ ...SERVER_ENV, CC_EFFORT: effort }).effort).toBe(
        effort,
      )
    }
  })

  test('rejects unsupported effort levels at startup', () => {
    expect(() => loadConfig({ ...SERVER_ENV, CC_EFFORT: 'minimal' })).toThrow(
      'CC_EFFORT must be one of: low, medium, high, xhigh, max',
    )
  })
})

describe('SERVER_API_KEY', () => {
  test('is required for server mode', () => {
    expect(() => loadConfig({})).toThrow('SERVER_API_KEY is required')
    expect(() => loadConfig({ SERVER_API_KEY: '   ' })).toThrow(
      'SERVER_API_KEY is required',
    )
  })

  test('may be omitted for the login subcommand', () => {
    expect(loadConfig({}, { requireApiKey: false }).apiKey).toBeNull()
  })
})

describe('ANTHROPIC_BASE_URL', () => {
  test('allows HTTPS and loopback-only plaintext debug proxies', () => {
    expect(loadConfig(SERVER_ENV).anthropicBaseUrl).toBe(
      'https://api.anthropic.com',
    )
    for (const baseUrl of [
      'http://localhost:8400/',
      'http://127.0.0.2:8400/proxy/',
      'http://[::1]:8400/',
    ]) {
      expect(
        loadConfig({ ...SERVER_ENV, ANTHROPIC_BASE_URL: baseUrl })
          .anthropicBaseUrl,
      ).toBe(baseUrl.replace(/\/$/, ''))
    }
  })

  test('rejects non-loopback plaintext and malformed upstream URLs', () => {
    for (const baseUrl of [
      'http://example.com',
      'http://localhost.example.com',
      'ftp://localhost',
      'not a URL',
      'https://user:pass@example.com',
      'https://example.com?token=bad',
    ]) {
      expect(() =>
        loadConfig({ ...SERVER_ENV, ANTHROPIC_BASE_URL: baseUrl }),
      ).toThrow(/ANTHROPIC_BASE_URL/)
    }
  })
})
