export class BodyLimitError extends Error {
  constructor(label: string, limit: number) {
    super(`${label} exceeds ${limit} byte limit`)
    this.name = 'BodyLimitError'
  }
}

export class InvalidUtf8Error extends Error {
  constructor(label: string) {
    super(`${label} is not valid UTF-8`)
    this.name = 'InvalidUtf8Error'
  }
}

export function contentLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length')
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  label: string,
): Promise<string> {
  if (!body) return ''

  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parts: string[] = []
  let total = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        throw new BodyLimitError(label, limit)
      }
      try {
        parts.push(decoder.decode(value, { stream: true }))
      } catch {
        throw new InvalidUtf8Error(label)
      }
    }
    try {
      parts.push(decoder.decode())
    } catch {
      throw new InvalidUtf8Error(label)
    }
    return parts.join('')
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}
