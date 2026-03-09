import { describe, expect, test } from "bun:test"
import { fastModeState, nextFastModeTier } from "../../src/cli/cmd/tui/component/prompt/fast-mode"

describe("fast mode prompt helpers", () => {
  test("supported model reports enable state when fast mode is off", () => {
    const result = fastModeState({
      model: {
        api: {
          id: "gpt-5",
          npm: "@ai-sdk/openai",
        },
      } as any,
      serviceTier: undefined,
    })

    expect(result.supported).toBe(true)
    expect(result.enabled).toBe(false)
    expect(result.title).toBe("Enable fast mode")
    expect(result.badge).toBe("")
  })

  test("supported model reports disable state and FAST badge when enabled", () => {
    const result = fastModeState({
      model: {
        api: {
          id: "gpt-5",
          npm: "@ai-sdk/openai",
        },
      } as any,
      serviceTier: "priority",
    })

    expect(result.supported).toBe(true)
    expect(result.enabled).toBe(true)
    expect(result.title).toBe("Disable fast mode")
    expect(result.badge).toBe(" · FAST")
  })

  test("unsupported model reports unavailable state", () => {
    const result = fastModeState({
      model: {
        api: {
          id: "gpt-5-nano",
          npm: "@ai-sdk/openai",
        },
      } as any,
      serviceTier: undefined,
    })

    expect(result.supported).toBe(false)
    expect(result.enabled).toBe(false)
    expect(result.title).toBe("Fast mode unavailable")
    expect(result.badge).toBe("")
  })

  test("toggle helper flips between priority and cleared normal mode", () => {
    expect(nextFastModeTier(undefined)).toBe("priority")
    expect(nextFastModeTier("auto")).toBe("priority")
    expect(nextFastModeTier("priority")).toBeUndefined()
  })
})
