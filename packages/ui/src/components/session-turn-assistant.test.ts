import { expect, test } from "bun:test"
import { collectAssistants } from "./session-turn-assistant"

test("groups assistant messages by parentID across full list", () => {
  const messages = [
    { id: "u1", role: "user" },
    { id: "u2", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1", order: 3, time: { created: 3 } },
  ]

  const list = collectAssistants(messages, "u1", 1)
  expect(list.map((m) => m.id)).toEqual(["a1"])
})
