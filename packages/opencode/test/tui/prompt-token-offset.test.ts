import { describe, expect, test } from "bun:test"
import { EditBuffer } from "@opentui/core"
import { getBufferEndOffset } from "../../src/cli/cmd/tui/lib/buffer-offset"
import { locateTokensByOffset } from "../../src/cli/cmd/tui/lib/prompt-token-offset"

describe("locateTokensByOffset", () => {
  test("finds token start/end in wcwidth offsets", () => {
    const buf = EditBuffer.create("wcwidth")
    buf.setText("你@file")

    const result = locateTokensByOffset({
      items: [{ token: "@file", hint: 0 }],
      getTextRange: buf.getTextRange.bind(buf),
      endOffset: getBufferEndOffset(buf),
    })

    expect(result.missing).toBe(0)
    expect(result.matches.length).toBe(1)
    expect(result.matches[0]!.start).toBe(2)
    expect(result.matches[0]!.end).toBe(7)
  })

  test("assigns duplicate tokens to nearest hints", () => {
    const buf = EditBuffer.create("wcwidth")
    const token = "@x"
    const text = `AA ${token} BB ${token} CC`
    buf.setText(text)

    const result = locateTokensByOffset({
      items: [
        { token, hint: 0, key: "first" },
        { token, hint: 999, key: "second" },
      ],
      getTextRange: buf.getTextRange.bind(buf),
      endOffset: getBufferEndOffset(buf),
    })

    expect(result.missing).toBe(0)
    expect(result.matches.length).toBe(2)

    const a = result.matches.find((m) => m.item.key === "first")!
    const b = result.matches.find((m) => m.item.key === "second")!

    expect(a.start).toBe(text.indexOf(token))
    expect(b.start).toBe(text.lastIndexOf(token))
  })

  test("counts missing tokens", () => {
    const buf = EditBuffer.create("wcwidth")
    buf.setText("abc")

    const result = locateTokensByOffset({
      items: [{ token: "@missing", hint: 0 }],
      getTextRange: buf.getTextRange.bind(buf),
      endOffset: getBufferEndOffset(buf),
    })

    expect(result.matches.length).toBe(0)
    expect(result.missing).toBe(1)
  })
})
