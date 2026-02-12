import { describe, expect, test } from "bun:test"
import { resolveSkillStatus } from "../../src/cli/cmd/tui/routes/session/skill-status"

describe("skill status", () => {
  test("prefers failed when tool part is error", () => {
    const out = resolveSkillStatus({
      status: "error",
      applied: false,
      superseded: true,
    })

    expect(out).toBe("failed")
  })

  test("returns loading for non-completed status", () => {
    const out = resolveSkillStatus({
      status: "running",
      applied: false,
      superseded: true,
    })

    expect(out).toBe("loading")
  })

  test("hides duplicate no-op entries from same assistant turn", () => {
    const out = resolveSkillStatus({
      status: "completed",
      applied: false,
      reason: "duplicate_in_turn",
      superseded: false,
    })

    expect(out).toBe("hidden")
  })

  test("hides near-context no-op entries to reduce transcript spam", () => {
    const out = resolveSkillStatus({
      status: "completed",
      applied: false,
      reason: "near_context",
      superseded: false,
    })

    expect(out).toBe("hidden")
  })

  test("hides same-turn no-op entries to reduce transcript spam", () => {
    const out = resolveSkillStatus({
      status: "completed",
      applied: false,
      reason: "same_turn",
      superseded: false,
    })

    expect(out).toBe("hidden")
  })

  test("prefers noop over superseded for completed no-op loads", () => {
    const out = resolveSkillStatus({
      status: "completed",
      applied: false,
      superseded: true,
    })

    expect(out).toBe("noop")
  })

  test("returns superseded for completed applied loads", () => {
    const out = resolveSkillStatus({
      status: "completed",
      applied: true,
      superseded: true,
    })

    expect(out).toBe("superseded")
  })

  test("returns active for completed applied load", () => {
    const out = resolveSkillStatus({
      status: "completed",
      applied: true,
      superseded: false,
    })

    expect(out).toBe("active")
  })
})
