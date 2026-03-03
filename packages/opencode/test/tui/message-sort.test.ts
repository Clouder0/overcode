import { expect, test } from "bun:test"
import { sortMessages } from "../../src/cli/cmd/tui/context/message-sort"

test("tui message sort places missing order last", () => {
  const list = [
    { id: "b", order: 2, time: { created: 2 } },
    { id: "c", time: { created: 3 } },
    { id: "a", order: 1, time: { created: 1 } },
  ]

  const sorted = list.toSorted(sortMessages)
  expect(sorted.map((m) => m.id)).toEqual(["a", "b", "c"])
})

test("tui message sort ties by created time", () => {
  const list = [
    { id: "msg_z", time: { created: 2 } },
    { id: "msg_a", time: { created: 1 } },
  ]
  const sorted = list.toSorted(sortMessages)
  expect(sorted.map((m) => m.id)).toEqual(["msg_a", "msg_z"])
})
