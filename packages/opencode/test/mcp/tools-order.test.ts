import { describe, expect, test } from "bun:test"
import { compareMcpNames, mcpToolKey, sanitizeMcpName, stableMcpToolOrder } from "../../src/mcp/lib/tool-order"

describe("mcp tool ordering", () => {
  test("sanitizeMcpName replaces unsupported characters", () => {
    expect(sanitizeMcpName("a b$c")).toBe("a_b_c")
  })

  test("compareMcpNames prefers sanitized ordering", () => {
    const names = ["b", "a"]
    names.sort(compareMcpNames)
    expect(names).toEqual(["a", "b"])
  })

  test("stableMcpToolOrder sorts by sanitized name", () => {
    const tools = stableMcpToolOrder([{ name: "b" }, { name: "a" }])
    expect(tools.map((t) => t.name)).toEqual(["a", "b"])
  })

  test("stableMcpToolOrder is deterministic on sanitized collisions", () => {
    const tools = stableMcpToolOrder([{ name: "a?b" }, { name: "a$b" }])
    expect(tools.map((t) => t.name)).toEqual(["a$b", "a?b"])
  })

  test("mcpToolKey combines sanitized client and tool", () => {
    expect(mcpToolKey("client name", "tool name")).toBe("client_name_tool_name")
  })
})
