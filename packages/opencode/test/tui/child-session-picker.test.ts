import { describe, expect, test } from "bun:test"
import {
  buildChildSessionPickerOptions,
  type ChildSessionPickerJob,
  type ChildSessionPickerSession,
} from "../../src/cli/cmd/tui/lib/child-session-picker"

describe("buildChildSessionPickerOptions", () => {
  test("includes worker sessions referenced by job metadata", () => {
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
        id: "session_worker_outside_tree",
        title: "Child session - 2025-01-01T00:00:00.000Z",
        time: { updated: 300 },
      },
    ]

    const jobs: ChildSessionPickerJob[] = [
      {
        id: "job_1",
        title: "Explore repo structure",
        status: "running",
        metadata: {
          workerSessionID: "session_worker_outside_tree",
          agent: "explore",
        },
        time: {
          created: 10,
          updated: 20,
          started: 10,
        },
      },
    ]

    const result = buildChildSessionPickerOptions({
      currentSessionID: "session_child",
      sessions,
      jobs,
      permissionsBySession: {},
      now: 1000,
    })

    expect(result.rootID).toBe("session_parent")

    const values = result.options.map((o) => o.value)
    expect(values).toContain("session_parent")
    expect(values).toContain("session_child")
    expect(values).toContain("session_worker_outside_tree")

    const worker = result.options.find((o) => o.value === "session_worker_outside_tree")
    expect(worker?.title).toContain("[explore]")
    expect(worker?.title).toContain("Explore repo structure")
  })

  test("prioritizes sessions needing input", () => {
    const sessions: ChildSessionPickerSession[] = [
      { id: "session_parent", title: "Parent", time: { updated: 100 } },
      { id: "session_worker", title: "Worker", time: { updated: 200 } },
    ]

    const jobs: ChildSessionPickerJob[] = [
      {
        id: "job_1",
        title: "Do task",
        status: "running",
        metadata: { workerSessionID: "session_worker", agent: "general" },
        time: { created: 10, updated: 20, started: 10 },
      },
    ]

    const result = buildChildSessionPickerOptions({
      currentSessionID: "session_parent",
      sessions,
      jobs,
      permissionsBySession: {
        session_worker: [{ id: "perm_1" }],
      },
      now: 1000,
    })

    const worker = result.options.find((o) => o.value === "session_worker")
    expect(worker?.category).toBe("Needs input")
    expect(worker?.footer).toBe("1 pending")

    const firstNonParent = result.options.find((o) => o.category !== "Parent")
    expect(firstNonParent?.value).toBe("session_worker")
  })

  test("chooses best representative job for a worker", () => {
    const sessions: ChildSessionPickerSession[] = [
      { id: "session_parent", title: "Parent", time: { updated: 100 } },
      { id: "session_worker", title: "Worker", time: { updated: 200 } },
    ]

    const jobs: ChildSessionPickerJob[] = [
      {
        id: "job_old",
        title: "Old completed",
        status: "completed",
        metadata: { workerSessionID: "session_worker", agent: "explore" },
        time: { created: 10, updated: 20, started: 10, completed: 30 },
      },
      {
        id: "job_new",
        title: "New running",
        status: "running",
        metadata: { workerSessionID: "session_worker", agent: "explore" },
        time: { created: 40, updated: 50, started: 40 },
      },
    ]

    const result = buildChildSessionPickerOptions({
      currentSessionID: "session_parent",
      sessions,
      jobs,
      permissionsBySession: {},
      now: 1000,
    })

    const worker = result.options.find((o) => o.value === "session_worker")
    expect(worker?.category).toBe("Running")
    expect(worker?.title).toContain("New running")
  })
})
