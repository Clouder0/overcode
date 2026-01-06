import { expect, test } from "bun:test"
import { MessageParser } from "../../src/session/message-parser"

test("formatInbox for normal message", () => {
  const result = MessageParser.formatInbox([{ from: "ses_a", text: "Hello" }])
  expect(result).toBe(`Sender Agent with session id ses_a sent a message:
<content>
Hello
</content>`)
})

test("formatInbox for timeout message", () => {
  const result = MessageParser.formatInbox([{ from: "ses_b", text: "Timeout", messageType: "timeout" }])
  expect(result).toBe(`Sender Agent with session id ses_b did not respond before your timeout:
<content>
Timeout
</content>`)
})

test("formatInbox for multiple messages", () => {
  const result = MessageParser.formatInbox([
    { from: "ses_a", text: "Hello", messageType: "normal" },
    { from: "ses_b", text: "World", messageType: "timeout" },
  ])
  expect(result).toContain("Sender Agent with session id ses_a sent a message:")
  expect(result).toContain("Sender Agent with session id ses_b did not respond before your timeout:")
})

test("formatTimeoutMessage", () => {
  const result = MessageParser.formatTimeoutMessage(30000)
  expect(result).toBe("Timeout after 30000ms waiting for response")
})

test("formatWaitTimeoutMessage includes idle status and ping suggestion", () => {
  const result = MessageParser.formatWaitTimeoutMessage({
    timeoutMs: 30000,
    snapshot: {
      source: "ses_child",
      run: "idle",
    },
  })
  expect(result).toContain("Timeout after 30000ms waiting for response")
  expect(result).toContain("Source status snapshot: idle")
  expect(result).toContain("ping ses_child")
})

test("formatWaitTimeoutMessage includes waiting details", () => {
  const result = MessageParser.formatWaitTimeoutMessage({
    timeoutMs: 1000,
    snapshot: {
      source: "ses_child",
      run: "waiting",
      waiting: {
        sources: ["ses_a", "ses_b"],
        mode: "all",
        deadline: 123,
      },
    },
  })
  expect(result).toContain("Source status snapshot: waiting")
  expect(result).toContain("mode=all")
  expect(result).toContain("ses_a, ses_b")
  expect(result).toContain("Wait deadline: 123")
})

test("formatWaitTimeoutMessage includes retry details", () => {
  const result = MessageParser.formatWaitTimeoutMessage({
    timeoutMs: 1000,
    snapshot: {
      source: "ses_child",
      run: "retry",
      retry: {
        attempt: 2,
        message: "Provider is overloaded",
        next: 999,
      },
    },
  })
  expect(result).toContain("Source status snapshot: retry")
  expect(result).toContain("attempt=2")
  expect(result).toContain("next=999")
  expect(result).toContain("Provider is overloaded")
})
