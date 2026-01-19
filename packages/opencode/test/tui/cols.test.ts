import { describe, expect, test } from "bun:test"
import { cols, destroy, maxLineCols, truncateEnd, truncateMiddle } from "../../src/cli/cmd/tui/lib/cols"

describe("tui cols", () => {
  test("truncateMiddle keeps some suffix when possible", () => {
    const out = truncateMiddle({ method: "unicode", text: "abcdefghijklmnopqrstuvwxyz", max: 10, mid: "…" })
    expect(out.includes("…")).toBe(true)
    expect(out.startsWith("ab")).toBe(true)
    expect(out.length).toBeGreaterThan(3)
  })

  test("maxLineCols measures widest line", () => {
    const text = "a\n" + "你".repeat(90)
    expect(maxLineCols("unicode", text)).toBe(180)
    expect(maxLineCols("wcwidth", text)).toBe(180)
  })

  test("destroy clears cached buffers", () => {
    // Warm caches
    cols("unicode", "x")
    cols("wcwidth", "x")
    destroy()
  })

  test("cols measures CJK as width 2", () => {
    expect(cols("unicode", "你")).toBe(2)
    expect(cols("wcwidth", "你")).toBe(2)
  })

  test("cols differs for ZWJ emoji between unicode and wcwidth", () => {
    expect(cols("unicode", "👩‍💻")).toBe(2)
    expect(cols("wcwidth", "👩‍💻")).toBe(4)
  })

  test("truncateEnd never exceeds max columns", () => {
    const text = "你".repeat(10)
    const out = truncateEnd({ method: "unicode", text, max: 5, tail: "…" })
    expect(cols("unicode", out)).toBeLessThanOrEqual(5)
  })

  test("truncateMiddle never exceeds max columns", () => {
    const text = "这是一个链接https://example.com/这是后面中文"
    const out = truncateMiddle({ method: "unicode", text, max: 10, mid: "…" })
    expect(cols("unicode", out)).toBeLessThanOrEqual(10)
  })
})
