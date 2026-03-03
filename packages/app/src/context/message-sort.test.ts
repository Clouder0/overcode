import { expect, test } from "bun:test"
import { upsertMessage } from "./message-sort"

type Msg = {
  id: string
  role: "user" | "assistant"
  order?: number
  time: {
    created: number
  }
}

test("upsertMessage keeps ordered before orderless", () => {
  const list: Msg[] = [{ id: "u1", role: "user", time: { created: 1 } }]
  const next = upsertMessage(list, { id: "a1", role: "assistant", order: 101, time: { created: 2 } })
  expect(next.map((m) => m.id)).toEqual(["a1", "u1"])
})

test("upsertMessage re-sorts when order arrives later", () => {
  const list: Msg[] = [
    { id: "u1", role: "user", time: { created: 1 } },
    { id: "a1", role: "assistant", order: 101, time: { created: 2 } },
  ]
  const next = upsertMessage(list, { id: "u1", role: "user", order: 102, time: { created: 1 } })
  expect(next.map((m) => m.id)).toEqual(["a1", "u1"])
})
