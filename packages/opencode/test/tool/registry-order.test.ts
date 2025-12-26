import { describe, expect, test } from "bun:test"
import { sortEntries, sortPaths } from "../../src/tool/lib/registry-order"

describe("tool registry ordering", () => {
  test("sortPaths returns a sorted copy", () => {
    const input = ["c", "a", "b"]
    const result = sortPaths(input)

    expect(result).toEqual(["a", "b", "c"])
    expect(input).toEqual(["c", "a", "b"])
  })

  test("sortEntries returns entries ordered by key", () => {
    const input: Array<[string, number]> = [
      ["b", 2],
      ["a", 1],
    ]

    const result = sortEntries(input)

    expect(result.map(([key]) => key)).toEqual(["a", "b"])
    expect(input.map(([key]) => key)).toEqual(["b", "a"])
  })
})
