import { expect, test } from "bun:test"
import { key } from "../../src/lsp/key"

test("LSP cache key does not collide for common prefix cases", () => {
  // Old concatenation (root + serverID) would collide here: "/a"+"bc" === "/ab"+"c".
  const a = key("bc", "/a")
  const b = key("c", "/ab")
  expect(a).not.toBe(b)
})
