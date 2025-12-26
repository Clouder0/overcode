import { expect, test } from "bun:test"
import { MessageParser } from "../../src/session/message-parser"

test("formatInbox for normal message", () => {
  const result = MessageParser.formatInbox([{ from: "ses_a", text: "Hello" }])
  expect(result).toBe(`Agent session ses_a sent a message to you:
<content>
Hello
</content>`)
})

test("formatInbox for timeout message", () => {
  const result = MessageParser.formatInbox([{ from: "ses_b", text: "Timeout", messageType: "timeout" }])
  expect(result).toBe(`Agent session ses_b timed out:
<content>
Timeout
</content>`)
})

test("formatInbox for multiple messages", () => {
  const result = MessageParser.formatInbox([
    { from: "ses_a", text: "Hello", messageType: "normal" },
    { from: "ses_b", text: "World", messageType: "timeout" },
  ])
  expect(result).toContain("Agent session ses_a sent a message to you:")
  expect(result).toContain("Agent session ses_b timed out:")
})

test("formatTimeoutMessage", () => {
  const result = MessageParser.formatTimeoutMessage(30000)
  expect(result).toBe("Timeout after 30000ms waiting for response")
})
