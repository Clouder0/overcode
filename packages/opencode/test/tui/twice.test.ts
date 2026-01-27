import { describe, expect, test } from "bun:test"
import { twice } from "../../src/cli/cmd/tui/lib/twice"

describe("twice", () => {
  test("arms on first press", () => {
    const result = twice({ now: 1000, last: 0, window: 500 })
    expect(result).toEqual({ hit: false, next: 1000 })
  })

  test("hits on second press within window", () => {
    const result = twice({ now: 1400, last: 1000, window: 500 })
    expect(result).toEqual({ hit: true, next: 0 })
  })

  test("does not hit outside window", () => {
    const result = twice({ now: 1601, last: 1000, window: 500 })
    expect(result).toEqual({ hit: false, next: 1601 })
  })

  test("treats exact boundary as within", () => {
    const result = twice({ now: 1500, last: 1000, window: 500 })
    expect(result).toEqual({ hit: true, next: 0 })
  })
})
