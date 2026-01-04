import { describe, expect, test } from "bun:test"
import {
  buildChildSessionPickerOptions,
  type ChildSessionPickerSession,
} from "../../src/cli/cmd/tui/lib/child-session-picker"

describe("buildChildSessionPickerOptions", () => {
  test("includes descendants in tree order", () => {
    const sessions: ChildSessionPickerSession[] = [
      {
        id: "session_root",
        title: "My root",
        time: { created: 100, updated: 100 },
      },
      {
        id: "session_child",
        parentID: "session_root",
        title: "Child",
        time: { created: 200, updated: 200 },
      },
      {
        id: "session_grandchild",
        parentID: "session_child",
        title: "Grandchild",
        time: { created: 300, updated: 300 },
      },
      {
        id: "session_other",
        title: "Other session",
        time: { created: 400, updated: 400 },
      },
    ]

    const result = buildChildSessionPickerOptions({
      currentSessionID: "session_grandchild",
      sessions,
      permissionsBySession: {},
    })

    expect(result.rootID).toBe("session_root")

    const values = result.options.map((o) => o.value)
    expect(values).toStrictEqual(["session_root", "session_child", "session_grandchild"])
    expect(values).not.toContain("session_other")

    const grandchild = result.options.find((o) => o.value === "session_grandchild")
    expect(grandchild?.title).toContain("↳")
  })

  test("marks sessions needing input", () => {
    const sessions: ChildSessionPickerSession[] = [
      { id: "session_root", title: "Root", time: { created: 100, updated: 100 } },
      { id: "session_child", parentID: "session_root", title: "Child", time: { created: 200, updated: 200 } },
    ]

    const result = buildChildSessionPickerOptions({
      currentSessionID: "session_root",
      sessions,
      permissionsBySession: {
        session_child: [{ id: "perm_1" }],
      },
    })

    const child = result.options.find((o) => o.value === "session_child")
    expect(child?.description).toBe("Needs input")
    expect(child?.footer).toBe("1 pending")
    expect(child?.category).toBeUndefined()
  })

  test("uses session title when not default", () => {
    const sessions: ChildSessionPickerSession[] = [
      { id: "session_root", title: "Root", time: { created: 100, updated: 100 } },
      {
        id: "session_child",
        parentID: "session_root",
        title: "Custom title",
        time: { created: 200, updated: 200 },
      },
    ]

    const result = buildChildSessionPickerOptions({
      currentSessionID: "session_root",
      sessions,
      permissionsBySession: {},
    })

    const child = result.options.find((o) => o.value === "session_child")
    expect(child?.title).toContain("Custom title")
  })
})
