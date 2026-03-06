import { describe, expect, test } from "bun:test"
import { waitResultState } from "../../../src/cli/cmd/tui/util/wait-result"

type Part = Parameters<typeof waitResultState>[0]

function part(input: { waitStatus?: "resolved" | "timedOut" } = {}): Part {
  return {
    direction: "incoming",
    peer: "Wait result",
    peerType: "system",
    metadata: {
      opencode: {
        messageType: "wait_result",
        ...(input.waitStatus ? { waitStatus: input.waitStatus } : {}),
      },
    },
  }
}

describe("wait result tui state", () => {
  test("resolved wait result uses success styling without timeout badge", () => {
    const result = waitResultState(part({ waitStatus: "resolved" }))

    expect(result.isWaitResult).toBe(true)
    expect(result.tone).toBe("success")
    expect(result.icon).toBe("✓")
    expect(result.showTimeoutLabel).toBe(false)
  })

  test("timed out wait result keeps timeout styling", () => {
    const result = waitResultState(part({ waitStatus: "timedOut" }))

    expect(result.isWaitResult).toBe(true)
    expect(result.tone).toBe("error")
    expect(result.icon).toBe("⏱")
    expect(result.showTimeoutLabel).toBe(true)
  })
})
