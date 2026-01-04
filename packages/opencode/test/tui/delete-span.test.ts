import { describe, expect, test } from "bun:test"
import { deleteSpanBackward, deleteSpanForward } from "../../src/cli/cmd/tui/lib/delete-span"
import { EditBuffer, EditorView, createExtmarksController } from "@opentui/core"

describe("deleteSpanForward", () => {
  test("returns width 2 span for wide chars", () => {
    const buf = EditBuffer.create("wcwidth")
    buf.setText("你a")

    const span = deleteSpanForward(buf.getTextRange.bind(buf), 0)
    expect(span).toEqual({ start: 0, end: 2 })

    const startPos = buf.offsetToPosition(span!.start)!
    const endPos = buf.offsetToPosition(span!.end)!
    buf.deleteRange(startPos.row, startPos.col, endPos.row, endPos.col)

    expect(buf.getText()).toBe("a")
  })

  test("returns width 2 span for tabs", () => {
    const buf = EditBuffer.create("wcwidth")
    buf.setText("a\tb")

    const span = deleteSpanForward(buf.getTextRange.bind(buf), 1)
    expect(span).toEqual({ start: 1, end: 3 })

    const startPos = buf.offsetToPosition(span!.start)!
    const endPos = buf.offsetToPosition(span!.end)!
    buf.deleteRange(startPos.row, startPos.col, endPos.row, endPos.col)

    expect(buf.getText()).toBe("ab")
  })

  test("returns span for trailing newline", () => {
    const buf = EditBuffer.create("wcwidth")
    buf.setText("a\n")

    const span = deleteSpanForward(buf.getTextRange.bind(buf), 1)
    expect(span).toEqual({ start: 1, end: 2 })

    const startPos = buf.offsetToPosition(span!.start)!
    const endPos = buf.offsetToPosition(span!.end)!
    buf.deleteRange(startPos.row, startPos.col, endPos.row, endPos.col)

    expect(buf.getText()).toBe("a")
  })
})

describe("deleteSpanBackward", () => {
  test("returns width 2 span for wide chars", () => {
    const buf = EditBuffer.create("wcwidth")
    buf.setText("你a")

    const span = deleteSpanBackward(buf.getTextRange.bind(buf), 2)
    expect(span).toEqual({ start: 0, end: 2 })

    const startPos = buf.offsetToPosition(span!.start)!
    const endPos = buf.offsetToPosition(span!.end)!
    buf.deleteRange(startPos.row, startPos.col, endPos.row, endPos.col)

    expect(buf.getText()).toBe("a")
  })

  test("returns width 2 span for tabs", () => {
    const buf = EditBuffer.create("wcwidth")
    buf.setText("a\tb")

    const span = deleteSpanBackward(buf.getTextRange.bind(buf), 3)
    expect(span).toEqual({ start: 1, end: 3 })

    const startPos = buf.offsetToPosition(span!.start)!
    const endPos = buf.offsetToPosition(span!.end)!
    buf.deleteRange(startPos.row, startPos.col, endPos.row, endPos.col)

    expect(buf.getText()).toBe("ab")
  })
})

describe("deleteRange shifts extmarks", () => {
  test("deleting before a virtual extmark shifts it", () => {
    const buf = EditBuffer.create("wcwidth")
    const view = EditorView.create(buf, 80, 24)
    const ext = createExtmarksController(buf, view)

    const prefix = "你".repeat(20) + "abc"
    const token = "[Pasted ~2 lines]"

    buf.setText(prefix + token)

    const tokenStart = Bun.stringWidth(prefix)
    const tokenEnd = tokenStart + Bun.stringWidth(token)
    const id = ext.create({ start: tokenStart, end: tokenEnd, virtual: true, typeId: 1 })

    const delOffset = Bun.stringWidth("你".repeat(20))
    const span = deleteSpanForward(buf.getTextRange.bind(buf), delOffset)
    expect(span).toEqual({ start: delOffset, end: delOffset + 1 })

    const startPos = buf.offsetToPosition(span!.start)!
    const endPos = buf.offsetToPosition(span!.end)!
    buf.deleteRange(startPos.row, startPos.col, endPos.row, endPos.col)

    const mark = ext.get(id)
    expect(mark?.start).toBe(tokenStart - 1)
    expect(mark?.end).toBe(tokenEnd - 1)
  })
})
