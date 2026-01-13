import { describe, expect, test } from "bun:test"
import { EditBuffer, EditorView, createExtmarksController } from "@opentui/core"

describe("ExtmarksController offset handling", () => {
  test("insertText shifts extmarks by CJK width", () => {
    const token = "[TOKEN]"
    const buf = EditBuffer.create("wcwidth")
    const view = EditorView.create(buf, 80, 24)
    const ext = createExtmarksController(buf, view)

    buf.setText("a" + token)

    const start = 1
    const end = start + token.length
    const id = ext.create({ start, end, virtual: true, typeId: 1 })

    buf.setCursorByOffset(0)
    buf.insertText("你")

    const mark = ext.get(id)
    expect(mark?.start).toBe(start + 2)
    expect(mark?.end).toBe(end + 2)
  })

  test("insertText shifts extmarks by tab width", () => {
    const token = "[TOKEN]"
    const buf = EditBuffer.create("wcwidth")
    const view = EditorView.create(buf, 80, 24)
    const ext = createExtmarksController(buf, view)

    buf.setText("a" + token)

    const start = 1
    const end = start + token.length
    const id = ext.create({ start, end, virtual: true, typeId: 1 })

    buf.setCursorByOffset(0)
    buf.insertText("\t")

    const mark = ext.get(id)
    expect(mark?.start).toBe(start + 2)
    expect(mark?.end).toBe(end + 2)
  })

  test("moveCursorLeft from extmark end lands at extmark start", () => {
    const token = "[TOKEN]"
    const buf = EditBuffer.create("wcwidth")
    const view = EditorView.create(buf, 80, 24)
    const ext = createExtmarksController(buf, view)

    buf.setText("你" + token)

    const start = 2
    const end = start + token.length
    const id = ext.create({ start, end, virtual: true, typeId: 1 })

    buf.setCursorByOffset(end)
    buf.moveCursorLeft()

    expect(buf.getCursorPosition().offset).toBe(start)

    const mark = ext.get(id)
    expect(mark?.start).toBe(start)
    expect(mark?.end).toBe(end)
  })

  test("moveCursorLeft from extmark end prefers preceding space", () => {
    const token = "[TOKEN]"
    const buf = EditBuffer.create("wcwidth")
    const view = EditorView.create(buf, 80, 24)
    const ext = createExtmarksController(buf, view)

    buf.setText(" " + token)

    const start = 1
    const end = start + token.length
    const id = ext.create({ start, end, virtual: true, typeId: 1 })

    buf.setCursorByOffset(end)
    buf.moveCursorLeft()

    expect(buf.getCursorPosition().offset).toBe(0)

    const mark = ext.get(id)
    expect(mark?.start).toBe(start)
    expect(mark?.end).toBe(end)
  })

  test("deleteCharBackward before extmark deletes preceding CJK char", () => {
    const token = "[TOKEN]"
    const buf = EditBuffer.create("wcwidth")
    const view = EditorView.create(buf, 80, 24)
    const ext = createExtmarksController(buf, view)

    buf.setText("你" + token)

    const start = 2
    const end = start + token.length
    const id = ext.create({ start, end, virtual: true, typeId: 1 })

    buf.setCursorByOffset(end)
    buf.moveCursorLeft()
    buf.deleteCharBackward()

    expect(buf.getText()).toBe(token)

    const mark = ext.get(id)
    expect(mark?.start).toBe(0)
    expect(mark?.end).toBe(token.length)
  })

  test("deleteChar shifts extmarks by deleted CJK width", () => {
    const token = "[TOKEN]"
    const buf = EditBuffer.create("wcwidth")
    const view = EditorView.create(buf, 80, 24)
    const ext = createExtmarksController(buf, view)

    buf.setText("你" + token)

    const start = 2
    const end = start + token.length
    const id = ext.create({ start, end, virtual: true, typeId: 1 })

    buf.setCursorByOffset(0)
    buf.deleteChar()

    const mark = ext.get(id)
    expect(mark?.start).toBe(0)
    expect(mark?.end).toBe(token.length)
  })
})
