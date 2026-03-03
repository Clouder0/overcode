import { expect, test } from "bun:test"
import { isQueued } from "../../src/cli/cmd/tui/routes/session/queued"

test("queued fallback uses message position, not lexicographic id", () => {
  const messages = [
    { id: "msg_z", role: "assistant", time: { created: 1 } },
    { id: "msg_a", role: "assistant", time: { created: 2 } },
  ]

  expect(isQueued({ messages, pending: "msg_z", current: "msg_a" })).toBe(true)
})
