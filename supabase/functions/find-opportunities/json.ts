export function parseJsonObject<T>(text: string, fallback: T): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const candidates = [cleaned, extractFirstObject(cleaned)].filter(
    (value): value is string => Boolean(value),
  )

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T
    } catch {
      // Try the next candidate. Stage-specific normalizers handle schema mistakes.
    }
  }

  return fallback
}

function extractFirstObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const character = text[index]

    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }

    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }

  return null
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

export function asStringArray(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;\n]/)
      : []

  return [...new Set(
    values
      .map((item) => asString(item))
      .filter(Boolean),
  )]
}

export function asFiniteNumber(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function clampScore(value: unknown): number {
  return Math.round(Math.min(100, Math.max(0, asFiniteNumber(value))))
}
