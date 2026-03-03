import { expect, test } from "bun:test"
import { mergeMessages, mergeParts } from "./message-merge"

type Msg = {
  id: string
  role: "user" | "assistant"
  order?: number
  time: {
    created: number
    completed?: number
  }
}

test("mergeMessages retains newer in-memory messages not in snapshot", () => {
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

test("mergeMessages drops in-memory messages missing from snapshot within order window", () => {
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

test("mergeMessages retains in-memory messages outside snapshot order window", () => {
  const current: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m2", role: "assistant", order: 2, time: { created: 2 } },
    { id: "m3", role: "assistant", order: 3, time: { created: 3 } },
    { id: "m4", role: "assistant", order: 4, time: { created: 4 } },
  ]
  const snapshot: Msg[] = [
    { id: "m3", role: "assistant", order: 3, time: { created: 3 } },
    { id: "m4", role: "assistant", order: 4, time: { created: 4 } },
  ]

  const next = mergeMessages({ current, snapshot, limit: 100 })
  expect(next.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"])
})

test("mergeMessages retains orderless optimistic messages", () => {
  const current: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "optim", role: "user", time: { created: 2 } },
  ]
  const snapshot: Msg[] = [{ id: "m1", role: "user", order: 1, time: { created: 1 } }]

  const next = mergeMessages({ current, snapshot, limit: 100 })
  expect(next.map((m) => m.id)).toEqual(["m1", "optim"])
})

test("seal only applies to completed assistant messages", async () => {
  const mod = (await import("./message-merge")) as unknown as {
    seal?: unknown
  }
  expect(typeof mod.seal).toBe("function")
  if (typeof mod.seal !== "function") return

  const seal = mod.seal as (input: unknown) => boolean

  expect(seal({ role: "user", time: { created: 1 } })).toBe(false)
  expect(seal({ role: "assistant", time: { created: 1 } })).toBe(false)
  expect(seal({ role: "assistant", time: { created: 1, completed: 2 } })).toBe(true)
})

test("mergeParts retains newer in-memory parts not in snapshot", () => {
  const current = [
    { id: "p1", type: "text" },
    { id: "p2", type: "tool" },
  ]
  const snapshot = [{ id: "p1", type: "text" }]
  const next = mergeParts({ current, snapshot })
  expect(next.map((p) => p.id)).toEqual(["p1", "p2"])
})

test("mergeParts keeps ids sorted for Binary.search", () => {
  const current = [
    { id: "p2", type: "text" },
    { id: "p1", type: "tool" },
  ]
  const snapshot = [{ id: "p2", type: "text" }]
  const next = mergeParts({ current, snapshot })
  expect(next.map((p) => p.id)).toEqual(["p1", "p2"])
})

test("mergeMessages keeps completed assistant when snapshot is stale", () => {
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

test("mergeMessages excludes tombstoned messages", () => {
  const current: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m2", role: "assistant", order: 2, time: { created: 2 } },
  ]
  const snapshot: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m2", role: "assistant", order: 2, time: { created: 2 } },
  ]

  const next = mergeMessages({ current, snapshot, limit: 100, tombstone: { m2: true } })
  expect(next.map((m) => m.id)).toEqual(["m1"])
})

test("mergeParts excludes tombstoned parts", () => {
  const current = [
    { id: "p1", type: "text" },
    { id: "p2", type: "tool" },
  ]
  const snapshot = [
    { id: "p1", type: "text" },
    { id: "p2", type: "tool" },
  ]

  const next = mergeParts({ current, snapshot, tombstone: { p2: true } })
  expect(next.map((p) => p.id)).toEqual(["p1"])
})

test("mergeParts keeps newer extra parts when sealed", () => {
  const current = [
    { id: "p1", type: "text" },
    { id: "p2", type: "tool" },
  ]
  const snapshot = [{ id: "p1", type: "text" }]

  const next = mergeParts({
    current,
    snapshot,
    sealed: true,
  } as unknown as {
    current: typeof current
    snapshot: typeof snapshot
    tombstone?: Record<string, true>
  })
  expect(next.map((p) => p.id)).toEqual(["p1", "p2"])
})

test("mergeParts drops older extra parts when sealed", () => {
  const current = [
    { id: "p1", type: "text" },
    { id: "p2", type: "tool" },
  ]
  const snapshot = [{ id: "p2", type: "tool" }]

  const next = mergeParts({
    current,
    snapshot,
    sealed: true,
  } as unknown as {
    current: typeof current
    snapshot: typeof snapshot
    tombstone?: Record<string, true>
  })
  expect(next.map((p) => p.id)).toEqual(["p2"])
})
