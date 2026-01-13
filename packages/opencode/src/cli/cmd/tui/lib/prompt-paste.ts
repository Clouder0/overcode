import type { PromptInfo } from "../component/prompt/history"

export type PromptPasteExtmark = {
  id: number
  start: number
  end: number
  typeId: number
}

export function expandPromptPastes(args: {
  parts: PromptInfo["parts"]
  extmarkToPartIndex: Map<number, number>
  extmarks: PromptPasteExtmark[]
  promptPartTypeId: number
  endOffset: number
  getTextRange: (start: number, end: number) => string
  offsetToPosition?: (offset: number) => { row: number; col: number } | null
  getTextRangeByCoords?: (startRow: number, startCol: number, endRow: number, endCol: number) => string
}): { text: string; missing: number } {
  const chunks: string[] = []
  let cursor = 0
  const expanded = new Set<number>()

  const slice = (start: number, end: number) => {
    if (!args.offsetToPosition || !args.getTextRangeByCoords) {
      return args.getTextRange(start, end)
    }

    const startPos = args.offsetToPosition(start)
    const endPos = args.offsetToPosition(end)

    if (!startPos || !endPos) {
      return args.getTextRange(start, end)
    }

    let text = args.getTextRangeByCoords(startPos.row, startPos.col, endPos.row, endPos.col)

    if (endPos.row > startPos.row && endPos.col === 0) {
      text += "\n"
    }

    return text
  }

  const marks = args.extmarks.filter((m) => m.typeId === args.promptPartTypeId).sort((a, b) => a.start - b.start)

  for (const mark of marks) {
    const partIndex = args.extmarkToPartIndex.get(mark.id)
    const part = partIndex === undefined ? undefined : args.parts[partIndex]
    if (!part || part.type !== "text" || !part.source?.text) continue
    if (part.source.expanded) continue

    if (mark.start < cursor) continue

    chunks.push(slice(cursor, mark.start))
    chunks.push(part.text)
    cursor = mark.end
    expanded.add(mark.id)
  }

  chunks.push(slice(cursor, args.endOffset))

  let missing = 0
  for (const [id, partIndex] of args.extmarkToPartIndex) {
    const part = args.parts[partIndex]
    if (!part || part.type !== "text" || !part.source?.text) continue
    if (part.source.expanded) continue
    if (expanded.has(id)) continue
    missing++
  }

  return { text: chunks.join(""), missing }
}
