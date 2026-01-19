import { EditBuffer, type WidthMethod } from "@opentui/core"

export type TokenLocateItem = {
  token: string
  hint: number
}

export type TokenLocateMatch<TItem> = {
  item: TItem
  start: number
  end: number
}

function offsetLength(token: string, method: WidthMethod) {
  const buf = EditBuffer.create(method)
  buf.setText(token)
  return buf.getEOL().offset
}

function firstCodePoint(token: string) {
  const cp = token.codePointAt(0)
  if (cp === undefined) return ""
  return String.fromCodePoint(cp)
}

export function locateTokensByOffset<TItem extends TokenLocateItem>(args: {
  items: TItem[]
  getTextRange: (start: number, end: number) => string
  endOffset: number
  widthMethod: WidthMethod
}): { matches: TokenLocateMatch<TItem>[]; missing: number } {
  const cached = new Map<string, { len: number; starts: number[] }>()

  const matches: TokenLocateMatch<TItem>[] = []
  let missing = 0

  for (const item of args.items) {
    if (!item.token) {
      matches.push({ item, start: item.hint, end: item.hint })
      continue
    }

    const existing = cached.get(item.token)
    const info =
      existing ??
      (() => {
        const len = offsetLength(item.token, args.widthMethod)
        const first = firstCodePoint(item.token)
        const starts: number[] = []
        if (len > 0 && args.endOffset >= len) {
          for (let pos = 0; pos <= args.endOffset - len; pos++) {
            if (first && args.getTextRange(pos, pos + 1) !== first) continue
            if (args.getTextRange(pos, pos + len) !== item.token) continue
            starts.push(pos)
          }
        }
        const value = { len, starts }
        cached.set(item.token, value)
        return value
      })()

    if (info.len <= 0 || info.starts.length === 0) {
      missing++
      continue
    }

    const around = Math.min(item.hint, args.endOffset)
    let idx = 0
    let best = Math.abs(info.starts[0]! - around)
    for (let i = 1; i < info.starts.length; i++) {
      const dist = Math.abs(info.starts[i]! - around)
      if (dist >= best) continue
      best = dist
      idx = i
      if (dist === 0) break
    }

    const start = info.starts.splice(idx, 1)[0]!
    matches.push({ item, start, end: start + info.len })
  }

  return { matches, missing }
}
