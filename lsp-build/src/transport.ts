// Keep serialized JSON below Orca's bridge limits, including UTF-8 and escaping.
export const RESPONSE_BUDGET = 700_000
export const POST_BUDGET = 220_000
// Frame -> host inputs are 64 KiB; leave room for the host envelope/session token.
export const REQUEST_BUDGET = 48_000
const encoder = new TextEncoder()
export const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length

/** Orca counts structured-clone cost too: each number takes 8 bytes and array
 * entries add 4 bytes. Small JSON numbers are not a safe estimate for token arrays. */
export function messageBytes(value: unknown): number {
  let objects = 0
  const visit = (v: any, depth: number): number => {
    if (depth > 90) return Infinity
    if (v == null || typeof v === 'boolean') return 1
    if (typeof v === 'number') return 8
    if (typeof v === 'string') return encoder.encode(v).length
    if (++objects > 9000) return Infinity
    if (Array.isArray(v)) return 8 + v.reduce((sum, item) => sum + 4 + visit(item, depth + 1), 0)
    return Object.entries(v).reduce((sum, [key, item]) => sum + 4 + encoder.encode(key).length + visit(item, depth + 1), 0)
  }
  return Math.max(jsonBytes(value), visit(value, 0))
}

/** Preserve a prefix of items, accounting for the envelope and array commas. */
export function limitItems<T>(items: T[], envelope: (items: T[]) => unknown, budget = RESPONSE_BUDGET): T[] {
  let count = 0, high = items.length
  while (count < high) {
    const middle = Math.ceil((count + high) / 2)
    if (messageBytes(envelope(items.slice(0, middle))) <= budget) count = middle
    else high = middle - 1
  }
  return items.slice(0, count)
}

/** Size chunks by serialized bytes, keeping UTF-16 surrogate pairs together. */
export function chunkText(text: string, budget = 36_000): string[] {
  if (budget < 8) throw new Error('The document path leaves no room for an upload chunk.')
  const chunks: string[] = []
  for (let start = 0; start < text.length;) {
    let end = start, high = Math.min(text.length, start + budget)
    while (end < high) {
      const middle = Math.ceil((end + high) / 2)
      if (jsonBytes(text.slice(start, middle)) <= budget) end = middle
      else high = middle - 1
    }
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks.length ? chunks : ['']
}
