import { describe, expect, test } from "bun:test"
import {
  buildChildSessionPickerOptions,
  type ChildSessionPickerSession,
} from "../../src/cli/cmd/tui/lib/child-session-picker"

describe("buildChildSessionPickerOptions", () => {
  test("includes direct child sessions", () => {
    const sessions: ChildSessionPickerSession[] = [
      {
        id: "session_parent",
        title: "My parent",
        time: { updated: 100 },
      },
      {
        id: "session_child",
        parentID: "session_parent",
        title: "Child session - 2025-01-01T00:00:00.000Z",
        time: { updated: 200 },
      },
      {
        id: "session_other",
        title: "Other session",
        time: { updated: 300 },
      },
    ]

    const result = buildChildSessionPickerOptions({
      currentSessionID: "session_child",
      sessions,
      permissionsBySession: {},
    })

    expect(result.rootID).toBe("session_parent")

    const values = result.options.map((o) => o.value)
    expect(values).toContain("session_parent")
    expect(values).toContain("session_child")
    expect(values).not.toContain("session_other")
  })

  test("prioritizes sessions needing input", () => {
    const sessions: ChildSessionPickerSession[] = [
      { id: "session_parent", title: "Parent", time: { updated: 100 } },
      { id: "session_child", parentID: "session_parent", title: "Child", time: { updated: 200 } },
    ]

    const result = buildChildSessionPickerOptions({
      currentSessionID: "session_parent",
      sessions,
      permissionsBySession: {
        session_child: [{ id: "perm_1" }],
      },
    })

    const child = result.options.find((o) => o.value === "session_child")
    expect(child?.category).toBe("Needs input")
    expect(child?.footer).toBe("1 pending")

    const firstNonParent = result.options.find((o) => o.category !== "Parent")
    expect(firstNonParent?.value).toBe("session_child")
  })

  test("uses session title when not default", () => {
    const sessions: ChildSessionPickerSession[] = [
      { id: "session_parent", title: "Parent", time: { updated: 100 } },
      { id: "session_child", parentID: "session_parent", title: "Custom title", time: { updated: 200 } },
    ]

    const result = buildChildSessionPickerOptions({
      currentSessionID: "session_parent",
      sessions,
      permissionsBySession: {},
    })

    const child = result.options.find((o) => o.value === "session_child")
    expect(child?.title).toContain("Custom title")
  })
})
