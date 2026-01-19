import { describe, expect, test } from "bun:test"
import { EditBuffer } from "@opentui/core"

function findTrigger(args: { buf: EditBuffer; cursorOffset: number; trigger: string }) {
  const low = Math.max(0, args.cursorOffset - 200)
  for (let o = args.cursorOffset - 1; o >= low; o--) {
    const char = args.buf.getTextRange(o, o + 1)
    if (char === "") continue
    if (/\s/.test(char)) return
    if (char === args.trigger) return o
  }
}

describe("autocomplete trigger offsets", () => {
  test("finds @ offset after CJK", () => {
    const buf = EditBuffer.create("unicode")
    buf.setText("你@file")
    const end = buf.getEOL().offset
    expect(findTrigger({ buf, cursorOffset: end, trigger: "@" })).toBe(2)
    buf.destroy()
  })

  test("ignores whitespace before @", () => {
    const buf = EditBuffer.create("unicode")
    buf.setText("你 @file")
    const end = buf.getEOL().offset
    expect(findTrigger({ buf, cursorOffset: end, trigger: "@" })).toBe(3)
    buf.destroy()
  })
})
