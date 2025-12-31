export type DeleteSpan = { start: number; end: number }

type Range = (start: number, end: number) => string

export function deleteSpanForward(range: Range, offset: number, max = 8): DeleteSpan | undefined {
  const base = range(offset, offset + 1)

  let end = offset + 1
  for (let i = 0; i < max; i++) {
    if (range(end, end + 1) === "") break
    const next = range(offset, end + 1)
    if (next !== base) break
    end++
  }

  return { start: offset, end }
}

export function deleteSpanBackward(range: Range, offset: number, max = 8): DeleteSpan | undefined {
  if (offset <= 0) return

  const base = range(offset - 1, offset)
  if (base === "" && range(Math.max(0, offset - 2), offset) === "") return

  let start = offset - 1
  for (let i = 0; i < max; i++) {
    if (start <= 0) break
    const prev = range(start - 1, offset)
    if (prev !== base) break
    start--
  }

  return { start, end: offset }
}
