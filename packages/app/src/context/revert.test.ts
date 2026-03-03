import { expect, test } from "bun:test"
import { after, cut } from "./revert"

type Msg = {
  id: string
  role: "user" | "assistant"
  order?: number
  time: {
    created: number
  }
}

test("cut returns full list when no revert", () => {
  const list: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m2", role: "assistant", order: 2, time: { created: 2 } },
  ]
  const next = cut({ list, revert: undefined })
  expect(next.map((m) => m.id)).toEqual(["m1", "m2"])
})

test("cut hides everything when revert boundary is missing and unknown", () => {
  const list: Msg[] = [
    { id: "m3", role: "assistant", order: 3, time: { created: 3 } },
    { id: "m4", role: "assistant", order: 4, time: { created: 4 } },
  ]
  const next = cut({
    list,
    revert: {
      messageID: "m2",
    },
  })
  expect(next.map((m) => m.id)).toEqual([])
})

test("cut hides messages at/after boundary by order when boundary not loaded", () => {
  const list: Msg[] = [
    { id: "m3", role: "assistant", order: 3, time: { created: 3 } },
    { id: "m4", role: "assistant", order: 4, time: { created: 4 } },
    { id: "m5", role: "assistant", order: 5, time: { created: 5 } },
  ]
  const next = cut({
    list,
    revert: {
      messageID: "m2",
    },
    boundary: { id: "m2", order: 2, time: { created: 2 } },
  })
  expect(next.map((m) => m.id)).toEqual([])
})

test("cut keeps messages when boundary is after window", () => {
  const list: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m2", role: "assistant", order: 2, time: { created: 2 } },
  ]
  const next = cut({
    list,
    revert: {
      messageID: "m10",
    },
    boundary: { id: "m10", order: 10, time: { created: 10 } },
  })
  expect(next.map((m) => m.id)).toEqual(["m1", "m2"])
})

test("cut keeps boundary message for part revert when loaded", () => {
  const list: Msg[] = [
    { id: "m1", role: "user", order: 1, time: { created: 1 } },
    { id: "m2", role: "assistant", order: 2, time: { created: 2 } },
    { id: "m3", role: "assistant", order: 3, time: { created: 3 } },
  ]
  const next = cut({
    list,
    revert: {
      messageID: "m2",
      partID: "p2",
    },
  })
  expect(next.map((m) => m.id)).toEqual(["m1", "m2"])
})

test("after finds first matching role after boundary", () => {
  const list: Msg[] = [
    { id: "u1", role: "user", order: 1, time: { created: 1 } },
    { id: "a1", role: "assistant", order: 2, time: { created: 2 } },
    { id: "u2", role: "user", order: 3, time: { created: 3 } },
    { id: "u3", role: "user", order: 5, time: { created: 5 } },
  ]
  const msg = after({
    list,
    boundary: { id: "a1", order: 2, time: { created: 2 } },
    role: "user",
  })
  expect(msg?.id).toBe("u2")
})

test("after returns undefined when nothing matches", () => {
  const list: Msg[] = [{ id: "u1", role: "user", order: 1, time: { created: 1 } }]
  const msg = after({
    list,
    boundary: { id: "u1", order: 1, time: { created: 1 } },
    role: "user",
  })
  expect(msg).toBeUndefined()
})
