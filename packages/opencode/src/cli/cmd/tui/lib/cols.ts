import { EditBuffer, EditorView, type WidthMethod } from "@opentui/core"
import { getMaxOffset } from "./buffer-offset"

type Cache = {
  buf: EditBuffer
  view: EditorView
  measure: EditBuffer
}

const cache = new Map<WidthMethod, Cache>()

function get(method: WidthMethod) {
  const existing = cache.get(method)
  if (existing) return existing

  const buf = EditBuffer.create(method)
  const view = EditorView.create(buf, 1, 1)
  view.setWrapMode("none")

  const measure = EditBuffer.create(method)

  const entry = { buf, view, measure }
  cache.set(method, entry)
  return entry
}

export function destroy() {
  for (const entry of cache.values()) {
    entry.view.destroy()
    entry.buf.destroy()
    entry.measure.destroy()
  }
  cache.clear()
}

export function cols(method: WidthMethod, text: string) {
  const entry = get(method)
  entry.measure.setText(text)
  return entry.measure.getEOL().offset
}

export function maxLineCols(method: WidthMethod, text: string) {
  const entry = get(method)
  entry.buf.setText(text)
  entry.view.setViewportSize(1, entry.buf.getLineCount())
  const info = entry.view.getLogicalLineInfo()
  return info.maxLineWidth
}

function fit(args: { buf: EditBuffer; method: WidthMethod; max: number; start: number; end: number }) {
  if (args.max <= 0) return ""

  const max = Math.min(args.max, args.end - args.start)

  let low = 0
  let high = max

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    const text = args.buf.getTextRange(args.start, args.start + mid)

    const width = cols(args.method, text)
    if (width <= args.max) {
      low = mid
    } else {
      high = mid - 1
    }
  }

  return args.buf.getTextRange(args.start, args.start + low)
}

export function truncateEnd(args: { method: WidthMethod; text: string; max: number; tail?: string }) {
  const tail = args.tail ?? "…"
  const max = args.max
  if (max <= 0) return ""

  const width = cols(args.method, args.text)
  if (width <= max) return args.text

  const tailw = cols(args.method, tail)
  if (tailw >= max) return tailw === max ? tail : ""

  const entry = get(args.method)
  entry.buf.setText(args.text)
  const end = getMaxOffset((offset) => entry.buf.offsetToPosition(offset))

  const head = fit({ buf: entry.buf, method: args.method, max: max - tailw, start: 0, end })
  return head + tail
}

export function truncateMiddle(args: { method: WidthMethod; text: string; max: number; mid?: string }) {
  const mid = args.mid ?? "…"
  const max = args.max
  if (max <= 0) return ""

  const width = cols(args.method, args.text)
  if (width <= max) return args.text

  const midw = cols(args.method, mid)
  if (midw >= max) return midw === max ? mid : ""

  const entry = get(args.method)
  entry.buf.setText(args.text)
  const end = getMaxOffset((offset) => entry.buf.offsetToPosition(offset))

  const leftMax = Math.max(0, Math.floor((max - midw) / 2))
  const rightMax = Math.max(0, max - midw - leftMax)

  const left = fit({ buf: entry.buf, method: args.method, max: leftMax, start: 0, end })
  const right = (() => {
    if (rightMax <= 0) return ""

    const low = Math.max(0, end - max)
    const high = end - 1

    let lowOffset = low
    let highOffset = high

    // Find the earliest offset such that suffix width <= rightMax.
    // Earlier offset => longer suffix.
    while (lowOffset + 1 < highOffset) {
      const midOffset = lowOffset + Math.floor((highOffset - lowOffset) / 2)
      const ok = entry.buf.offsetToPosition(midOffset) !== null
      if (!ok) {
        lowOffset = midOffset
        continue
      }

      const part = entry.buf.getTextRange(midOffset, end)
      const width = cols(args.method, part)
      if (width <= rightMax) {
        highOffset = midOffset
      } else {
        lowOffset = midOffset
      }
    }

    const finalOffset = (() => {
      const ok = entry.buf.offsetToPosition(highOffset) !== null
      if (!ok) return

      const part = entry.buf.getTextRange(highOffset, end)
      const width = cols(args.method, part)
      if (width <= rightMax) return highOffset
    })()

    if (finalOffset === undefined) return ""
    return entry.buf.getTextRange(finalOffset, end)
  })()

  return left + mid + right
}
