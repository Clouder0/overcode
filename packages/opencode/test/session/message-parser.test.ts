import { expect, test } from "bun:test"
import { MessageParser } from "../../src/session/message-parser"

test("formatInbox for normal message", () => {
  const result = MessageParser.formatInbox([{ from: "ses_a", text: "Hello" }])
  expect(result).toBe(`Sender Agent with session id ses_a sent a message:
<content>
Hello
</content>`)
})

test("formatInbox includes seq when provided", () => {
  const result = MessageParser.formatInbox([{ from: "ses_a", text: "Hello", seq: 42 }])
  expect(result).toBe(`Sender Agent with session id ses_a (seq: 42) sent a message:
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

test("formatWaitResult with timeout shows header and mode", () => {
  const result = MessageParser.formatWaitResult({
    status: "timedOut",
    timeoutMs: 30000,
    mode: "all",
    since: 42,
    sources: ["ses_child"],
    responded: [],
    timedOut: [{ source: "ses_child", run: "idle" }],
  })
  expect(result).toContain("Wait timed out after 30000ms")
  expect(result).toContain("Mode: all")
  expect(result).toContain("Since: 42")
  expect(result).toContain("Sources: ses_child")
  expect(result).toContain("wait_agent_message does not return message bodies")
})

test("formatWaitResult shows responded sources", () => {
  const result = MessageParser.formatWaitResult({
    status: "timedOut",
    timeoutMs: 30000,
    mode: "all",
    since: 7,
    sources: ["ses_a", "ses_b", "ses_c"],
    responded: ["ses_a", "ses_b"],
    timedOut: [{ source: "ses_c", run: "working" }],
  })
  expect(result).toContain("Responded: ses_a, ses_b")
})

test("formatWaitResult shows timed out sources with status", () => {
  const result = MessageParser.formatWaitResult({
    status: "timedOut",
    timeoutMs: 30000,
    mode: "all",
    since: 9,
    sources: ["ses_a", "ses_b"],
    responded: [],
    timedOut: [
      { source: "ses_a", run: "working" },
      { source: "ses_b", run: "idle" },
    ],
  })
  expect(result).toContain("Timed out:")
  expect(result).toContain("ses_a: working")
  expect(result).toContain("ses_b: idle")
})

test("formatWaitResult suggests waiting again for working/waiting/retry", () => {
  const result = MessageParser.formatWaitResult({
    status: "timedOut",
    timeoutMs: 30000,
    mode: "all",
    since: 1,
    sources: ["ses_child"],
    responded: [],
    timedOut: [{ source: "ses_child", run: "working" }],
  })
  expect(result).toContain("ses_child is still processing - consider waiting again")
})

test("formatWaitResult suggests sending message for idle", () => {
  const result = MessageParser.formatWaitResult({
    status: "timedOut",
    timeoutMs: 30000,
    mode: "all",
    since: 1,
    sources: ["ses_child"],
    responded: [],
    timedOut: [{ source: "ses_child", run: "idle" }],
  })
  expect(result).toContain("ses_child is idle - consider sending a message to check status")
})

test("formatWaitResult includes agent labels when provided", () => {
  const result = MessageParser.formatWaitResult({
    status: "timedOut",
    timeoutMs: 30000,
    mode: "all",
    since: 123,
    sources: ["ses_a", "ses_b"],
    responded: ["ses_a"],
    timedOut: [{ source: "ses_b", run: "working" }],
    agents: {
      ses_a: "explore",
      ses_b: "general",
    },
  })
  expect(result).toContain("Responded: ses_a (explore)")
  expect(result).toContain("ses_b (general): working")
  expect(result).toContain("ses_b (general) is still processing")
})

test("formatWaitResult resolved without timeout", () => {
  const result = MessageParser.formatWaitResult({
    status: "resolved",
    timeoutMs: 30000,
    mode: "all",
    since: 4,
    sources: ["ses_a"],
    responded: ["ses_a"],
    timedOut: [],
  })
  expect(result).toContain("Wait resolved")
  expect(result).toContain("Mode: all")
  expect(result).toContain("Reason:")
  expect(result).toContain("Responded: ses_a")
  expect(result).not.toContain("Wait timed out")
  expect(result).toContain("wait_agent_message does not return message bodies")
})

test("formatWaitResult resolved wildcard uses sources=any", () => {
  const result = MessageParser.formatWaitResult({
    status: "resolved",
    timeoutMs: 30000,
    mode: "any",
    since: 0,
    sources: ["*"],
    responded: ["ses_a"],
    respondedSeqs: {
      ses_a: 42,
    },
    timedOut: [],
  })
  expect(result).toContain("Wait resolved")
  expect(result).toContain("Mode: any")
  expect(result).toContain("Sources: any agent")
  expect(result).toContain("ses_a (seq=42)")
})
