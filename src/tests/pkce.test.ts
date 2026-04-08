import { afterEach, describe, expect, mock, test } from 'bun:test'
import { generatePKCE } from '../pkce'

afterEach(() => {
  mock.restore()
})

describe('generatePKCE', () => {
  test('returns an object with verifier, challenge, and method', async () => {
    const result = await generatePKCE()
    expect(result).toHaveProperty('verifier')
    expect(result).toHaveProperty('challenge')
    expect(result).toHaveProperty('method')
  })

  test('method is S256', async () => {
    const result = await generatePKCE()
    expect(result.method).toBe('S256')
  })

  test('verifier is 86 characters (64 bytes base64url)', async () => {
    const result = await generatePKCE()
    expect(result.verifier.length).toBe(86)
  })

  test('challenge is 43 characters (SHA-256 base64url)', async () => {
    const result = await generatePKCE()
    expect(result.challenge.length).toBe(43)
  })

  test('verifier contains only base64url characters', async () => {
    const result = await generatePKCE()
    expect(result.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('challenge contains only base64url characters', async () => {
    const result = await generatePKCE()
    expect(result.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('verifier has no base64 padding or unsafe chars', async () => {
    const result = await generatePKCE()
    expect(result.verifier).not.toContain('+')
    expect(result.verifier).not.toContain('/')
    expect(result.verifier).not.toContain('=')
  })

  test('challenge has no base64 padding or unsafe chars', async () => {
    const result = await generatePKCE()
    expect(result.challenge).not.toContain('+')
    expect(result.challenge).not.toContain('/')
    expect(result.challenge).not.toContain('=')
  })

  test('challenge is SHA-256 of verifier (independent verification)', async () => {
    const result = await generatePKCE()
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(result.verifier),
    )
    const hashBytes = new Uint8Array(digest)
    let bin = ''
    for (const byte of hashBytes) bin += String.fromCharCode(byte)
    const expected = btoa(bin)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
    expect(result.challenge).toBe(expected)
  })

  test('consecutive calls produce different verifiers', async () => {
    const a = await generatePKCE()
    const b = await generatePKCE()
    expect(a.verifier).not.toBe(b.verifier)
  })

  test('consecutive calls produce different challenges', async () => {
    const a = await generatePKCE()
    const b = await generatePKCE()
    expect(a.challenge).not.toBe(b.challenge)
  })

  test('verifier is within RFC 7636 bounds (43-128 chars)', async () => {
    const result = await generatePKCE()
    expect(result.verifier.length).toBeGreaterThanOrEqual(43)
    expect(result.verifier.length).toBeLessThanOrEqual(128)
  })

  test('deterministic output for known random bytes', async () => {
    // Bytes 0-63 produce +, / and = in raw base64,
    // pinning all three .replace() calls
    const knownBytes = new Uint8Array(64)
    for (let i = 0; i < 64; i++) knownBytes[i] = i

    const original = crypto.getRandomValues
    crypto.getRandomValues = (<T extends ArrayBufferView>(array: T): T => {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(
        knownBytes,
      )
      return array
    }) as typeof crypto.getRandomValues

    try {
      const result = await generatePKCE()

      // Expected verifier: base64url(bytes 0..63)
      let bin = ''
      for (let i = 0; i < 64; i++) bin += String.fromCharCode(i)
      const expectedVerifier = btoa(bin)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')
      expect(result.verifier).toBe(expectedVerifier)

      // Expected challenge: base64url(SHA-256(verifier))
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(expectedVerifier),
      )
      const hashBytes = new Uint8Array(digest)
      let hashBin = ''
      for (const byte of hashBytes) hashBin += String.fromCharCode(byte)
      const expectedChallenge = btoa(hashBin)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')
      expect(result.challenge).toBe(expectedChallenge)
    } finally {
      crypto.getRandomValues = original
    }
  })
})
