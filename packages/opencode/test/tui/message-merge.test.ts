import { expect, test } from "bun:test"
import { mergeMessages } from "../../src/cli/cmd/tui/context/message-merge"

type Msg = {
  id: string
  role: "user" | "assistant"
  order?: number
  time: {
    created: number
    completed?: number
  }
}

test("tui merge keeps newer in-memory messages not in snapshot", () => {
  const current: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m2", role: "assistant", order: 2, time: { created: 2 } },
    { id: "m3", role: "assistant", order: 3, time: { created: 3 } },
  ]
  const snapshot: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m2", role: "assistant", order: 2, time: { created: 2 } },
  ]

  const next = mergeMessages({ current, snapshot, limit: 100 })
  expect(next.map((m) => m.id)).toEqual(["m1", "m2", "m3"])
})

test("tui merge drops in-memory messages missing from snapshot within order window", () => {
  const current: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m2", role: "assistant", order: 2, time: { created: 2 } },
    { id: "m3", role: "assistant", order: 3, time: { created: 3 } },
  ]
  const snapshot: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m3", role: "assistant", order: 3, time: { created: 3 } },
  ]

  const next = mergeMessages({ current, snapshot, limit: 100 })
  expect(next.map((m) => m.id)).toEqual(["m1", "m3"])
})

test("tui merge retains pinned messages even when missing within order window", () => {
  const current: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m2", role: "assistant", order: 2, time: { created: 2 } },
    { id: "m3", role: "assistant", order: 3, time: { created: 3 } },
  ]
  const snapshot: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m3", role: "assistant", order: 3, time: { created: 3 } },
  ]

  const next = mergeMessages({ current, snapshot, limit: 100, pinned: new Set(["m2"]) })
  expect(next.map((m) => m.id)).toEqual(["m1", "m2", "m3"])
})

test("tui merge keeps completed assistant when snapshot is stale", () => {
  const current: Msg[] = [
    {
      id: "a1",
      role: "assistant",
      order: 1,
      time: { created: 1, completed: 2 },
    },
  ]
  const snapshot: Msg[] = [
    {
      id: "a1",
      role: "assistant",
      order: 1,
      time: { created: 1 },
    },
  ]
  const next = mergeMessages({ current, snapshot, limit: 100 })
  expect(next[0]?.time.completed).toBe(2)
})

test("tui merge excludes tombstoned messages", () => {
  const current: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m2", role: "assistant", order: 2, time: { created: 2 } },
  ]
  const snapshot: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m2", role: "assistant", order: 2, time: { created: 2 } },
  ]

  const next = mergeMessages({ current, snapshot, limit: 100, tombstone: new Set(["m2"]) })
  expect(next.map((m) => m.id)).toEqual(["m1"])
})

test("tui seal only applies to completed assistant messages", async () => {
  const mod = (await import("../../src/cli/cmd/tui/context/message-merge")) as unknown as {
    seal?: unknown
  }
  expect(typeof mod.seal).toBe("function")
  if (typeof mod.seal !== "function") return

  const seal = mod.seal as (input: unknown) => boolean

  expect(seal({ role: "user", time: { created: 1 } })).toBe(false)
  expect(seal({ role: "assistant", time: { created: 1 } })).toBe(false)
  expect(seal({ role: "assistant", time: { created: 1, completed: 2 } })).toBe(true)
})

test("tui mergeParts keeps ids sorted for Binary.search", async () => {
  const mod = (await import("../../src/cli/cmd/tui/context/message-merge")) as unknown as {
    mergeParts?: unknown
  }
  expect(typeof mod.mergeParts).toBe("function")
  if (typeof mod.mergeParts !== "function") return

  type Part = { id: string; type: string }
  const mergeParts = mod.mergeParts as (input: {
    current: Part[]
    snapshot: Part[]
    tombstone?: Set<string>
    sealed?: boolean
  }) => Part[]

  const current = [
    { id: "p2", type: "text" },
    { id: "p1", type: "tool" },
  ]
  const snapshot = [{ id: "p2", type: "text" }]
  const next = mergeParts({ current, snapshot })
  expect(next.map((p) => p.id)).toEqual(["p1", "p2"])
})

test("tui mergeParts keeps newer extra parts when sealed", async () => {
  const mod = (await import("../../src/cli/cmd/tui/context/message-merge")) as unknown as {
    mergeParts?: unknown
  }
  expect(typeof mod.mergeParts).toBe("function")
  if (typeof mod.mergeParts !== "function") return

  type Part = { id: string; type: string }
  const mergeParts = mod.mergeParts as (input: {
    current: Part[]
    snapshot: Part[]
    tombstone?: Set<string>
    sealed?: boolean
  }) => Part[]

  const current = [
    { id: "p1", type: "text" },
    { id: "p2", type: "tool" },
  ]
  const snapshot = [{ id: "p1", type: "text" }]

  const next = mergeParts({ current, snapshot, sealed: true })
  expect(next.map((p) => p.id)).toEqual(["p1", "p2"])
})

test("tui mergeParts drops older extra parts when sealed", async () => {
  const mod = (await import("../../src/cli/cmd/tui/context/message-merge")) as unknown as {
    mergeParts?: unknown
  }
  expect(typeof mod.mergeParts).toBe("function")
  if (typeof mod.mergeParts !== "function") return

  type Part = { id: string; type: string }
  const mergeParts = mod.mergeParts as (input: {
    current: Part[]
    snapshot: Part[]
    tombstone?: Set<string>
    sealed?: boolean
  }) => Part[]

  const current = [
    { id: "p1", type: "text" },
    { id: "p2", type: "tool" },
  ]
  const snapshot = [{ id: "p2", type: "tool" }]

  const next = mergeParts({ current, snapshot, sealed: true })
  expect(next.map((p) => p.id)).toEqual(["p2"])
})
