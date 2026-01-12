import { describe, expect, test } from "bun:test"
import { EditBuffer } from "@opentui/core"
import type { PromptInfo } from "../../src/cli/cmd/tui/component/prompt/history"
import { getBufferEndOffset } from "../../src/cli/cmd/tui/lib/buffer-offset"
import { expandPromptPastes } from "../../src/cli/cmd/tui/lib/prompt-paste"

describe("expandPromptPastes", () => {
  test("replaces only extmarked occurrence when token repeats", () => {
    const token = "[Pasted ~2 lines]"
    const base = `AA ${token} BB ${token} CC`

    const buf = EditBuffer.create("wcwidth")
    buf.setText(base)

    const first = base.indexOf(token)
    const second = base.indexOf(token, first + 1)

    const parts: PromptInfo["parts"] = [
      {
        type: "text",
        text: "<<PASTE>>",
        source: {
          expanded: false,
          text: {
            start: second,
            end: second + token.length,
            value: token,
          },
        },
      },
    ]

    const result = expandPromptPastes({
      parts,
      extmarkToPartIndex: new Map([[1, 0]]),
      extmarks: [{ id: 1, start: second, end: second + token.length, typeId: 123 }],
      promptPartTypeId: 123,
      endOffset: getBufferEndOffset(buf),
      getTextRange: buf.getTextRange.bind(buf),
      offsetToPosition: buf.offsetToPosition.bind(buf),
      getTextRangeByCoords: buf.getTextRangeByCoords.bind(buf),
    })

    expect(result.missing).toBe(0)
    expect(result.text).toBe(`AA ${token} BB <<PASTE>> CC`)
  })

  test("counts missing extmarks", () => {
    const token = "[Pasted ~2 lines]"
    const base = `AA ${token} CC`

    const buf = EditBuffer.create("wcwidth")
    buf.setText(base)

    const start = base.indexOf(token)

    const parts: PromptInfo["parts"] = [
      {
        type: "text",
        text: "<<PASTE>>",
        source: {
          expanded: false,
          text: {
            start,
            end: start + token.length,
            value: token,
          },
        },
      },
    ]

    const result = expandPromptPastes({
      parts,
      extmarkToPartIndex: new Map([[1, 0]]),
      extmarks: [],
      promptPartTypeId: 123,
      endOffset: getBufferEndOffset(buf),
      getTextRange: buf.getTextRange.bind(buf),
      offsetToPosition: buf.offsetToPosition.bind(buf),
      getTextRangeByCoords: buf.getTextRangeByCoords.bind(buf),
    })

    expect(result.missing).toBe(1)
    expect(result.text).toBe(base)
  })

  test("handles CJK prefix offsets", () => {
    const token = "[Pasted ~2 lines]"
    const base = `你 ${token} 好`

    const buf = EditBuffer.create("wcwidth")
    buf.setText(base)

    const prefix = EditBuffer.create("wcwidth")
    prefix.setText("你 ")
    const start = prefix.getEOL().offset

    const parts: PromptInfo["parts"] = [
      {
        type: "text",
        text: "X",
        source: {
          expanded: false,
          text: {
            start,
            end: start + token.length,
            value: token,
          },
        },
      },
    ]

    const result = expandPromptPastes({
      parts,
      extmarkToPartIndex: new Map([[1, 0]]),
      extmarks: [{ id: 1, start, end: start + token.length, typeId: 123 }],
      promptPartTypeId: 123,
      endOffset: getBufferEndOffset(buf),
      getTextRange: buf.getTextRange.bind(buf),
      offsetToPosition: buf.offsetToPosition.bind(buf),
      getTextRangeByCoords: buf.getTextRangeByCoords.bind(buf),
    })

    expect(result.missing).toBe(0)
    expect(result.text).toBe(`你 X 好`)
  })

  test("preserves newline when extmark starts at line start", () => {
    const token = "[Pasted ~2 lines]"
    const base = `A\n${token} B`

    const buf = EditBuffer.create("wcwidth")
    buf.setText(base)

    const prefix = EditBuffer.create("wcwidth")
    prefix.setText("A\n")
    const start = getBufferEndOffset(prefix)

    const parts: PromptInfo["parts"] = [
      {
        type: "text",
        text: "<<PASTE>>",
        source: {
          expanded: false,
          text: {
            start,
            end: start + token.length,
            value: token,
          },
        },
      },
    ]

    const result = expandPromptPastes({
      parts,
      extmarkToPartIndex: new Map([[1, 0]]),
      extmarks: [{ id: 1, start, end: start + token.length, typeId: 123 }],
      promptPartTypeId: 123,
      endOffset: getBufferEndOffset(buf),
      getTextRange: buf.getTextRange.bind(buf),
      offsetToPosition: buf.offsetToPosition.bind(buf),
      getTextRangeByCoords: buf.getTextRangeByCoords.bind(buf),
    })

    expect(result.missing).toBe(0)
    expect(result.text).toBe(`A\n<<PASTE>> B`)
  })
})
