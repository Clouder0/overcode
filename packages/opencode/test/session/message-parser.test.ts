import { test, expect } from "bun:test"
import { MessageParser } from "../../src/session/message-parser"

test("parse single message", () => {
  const input = `<message to="human" timeout="-1">Hello world</message>`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].to).toBe("human")
  expect(result.messages[0].timeout).toBe(-1)
  expect(result.messages[0].content).toBe("Hello world")
  expect(result.malformed).toBe(false)
})

test("parse multiple messages", () => {
  const input = `<message to="ses_a" timeout="0">Task A</message>
<message to="ses_b" timeout="0">Task B</message>`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(2)
  expect(result.messages[0].to).toBe("ses_a")
  expect(result.messages[1].to).toBe("ses_b")
  expect(result.malformed).toBe(false)
})

test("parse wait element", () => {
  const input = `<message to="ses_a" timeout="0">Task A</message>
<message to="ses_b" timeout="0">Task B</message>
<wait sources="ses_a,ses_b" timeout="60000" mode="all"/>`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(2)
  expect(result.wait).toBeDefined()
  expect(result.wait?.sources).toEqual(["ses_a", "ses_b"])
  expect(result.wait?.timeout).toBe(60000)
  expect(result.wait?.mode).toBe("all")
  expect(result.malformed).toBe(false)
})

test("parse wait with any mode", () => {
  const input = `<wait sources="ses_a,ses_b" timeout="30000" mode="any"/>`
  const result = MessageParser.parse(input)
  expect(result.wait).toBeDefined()
  expect(result.wait?.mode).toBe("any")
  expect(result.malformed).toBe(false)
})

// STRICT STRUCTURAL OUTPUT: remaining text is now malformed
test("raw text outside tags is malformed", () => {
  const input = `
    Some thinking here
    <message to="human" timeout="-1">Response</message>
    More text
  `
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(1)
  expect(result.remainingText).toContain("Some thinking here")
  expect(result.remainingText).toContain("More text")
  expect(result.malformed).toBe(true) // Raw text not allowed
})

test("handles malformed XML gracefully", () => {
  const input = `<message to="human">No closing tag or timeout`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(0)
  expect(result.malformed).toBe(true)
})

test("handles multiline content", () => {
  const input = `<message to="human" timeout="-1">
Line 1
Line 2
Line 3
</message>`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].content).toContain("Line 1")
  expect(result.messages[0].content).toContain("Line 3")
  expect(result.malformed).toBe(false)
})

test("serialize message", () => {
  const message = { to: "human", timeout: -1, content: "Hello" }
  const result = MessageParser.serialize(message)
  expect(result).toContain('to="human"')
  expect(result).toContain('timeout="-1"')
  expect(result).toContain("Hello")
})

test("formatIncoming for normal message", () => {
  const result = MessageParser.formatIncoming("ses_001", "Found the file")
  expect(result).toBe("[From ses_001]:\nFound the file")
})

test("formatIncoming for timeout message", () => {
  const result = MessageParser.formatIncoming("ses_001", "Timeout message", true)
  expect(result).toBe("[From system timeout ses_001]:\nTimeout message")
})

test("formatTimeoutMessage", () => {
  const result = MessageParser.formatTimeoutMessage(30000)
  expect(result).toBe("Timeout after 30000ms waiting for response")
})

// Tests for different attribute orders in <wait> tag

test("parse wait with sources, mode, timeout order", () => {
  const input = `<wait sources="ses_a,ses_b" mode="all" timeout="60000"/>`
  const result = MessageParser.parse(input)
  expect(result.wait).toBeDefined()
  expect(result.wait?.sources).toEqual(["ses_a", "ses_b"])
  expect(result.wait?.timeout).toBe(60000)
  expect(result.wait?.mode).toBe("all")
})

test("parse wait with timeout, sources, mode order", () => {
  const input = `<wait timeout="45000" sources="child1" mode="any"/>`
  const result = MessageParser.parse(input)
  expect(result.wait).toBeDefined()
  expect(result.wait?.sources).toEqual(["child1"])
  expect(result.wait?.timeout).toBe(45000)
  expect(result.wait?.mode).toBe("any")
})

test("parse wait with mode, sources, timeout order", () => {
  const input = `<wait mode="all" sources="a,b,c" timeout="30000"/>`
  const result = MessageParser.parse(input)
  expect(result.wait).toBeDefined()
  expect(result.wait?.sources).toEqual(["a", "b", "c"])
  expect(result.wait?.timeout).toBe(30000)
  expect(result.wait?.mode).toBe("all")
})

test("parse wait with children as source", () => {
  const input = `<wait sources="children" timeout="60000" mode="all"/>`
  const result = MessageParser.parse(input)
  expect(result.wait).toBeDefined()
  expect(result.wait?.sources).toEqual(["children"])
  expect(result.wait?.timeout).toBe(60000)
  expect(result.wait?.mode).toBe("all")
})

// Tests for flexible message attribute order

test("parse message with timeout before to", () => {
  const input = `<message timeout="-1" to="human">Hello world</message>`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].to).toBe("human")
  expect(result.messages[0].timeout).toBe(-1)
  expect(result.messages[0].content).toBe("Hello world")
})

test("parse message with extra whitespace in attributes", () => {
  const input = `<message   to="caller"   timeout="0"  >Progress update</message>`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].to).toBe("caller")
  expect(result.messages[0].timeout).toBe(0)
})

test("parse message with single quotes", () => {
  const input = `<message to='human' timeout='30000'>Question?</message>`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].to).toBe("human")
  expect(result.messages[0].timeout).toBe(30000)
})

// STRICT STRUCTURAL OUTPUT tests

test("clean parse with only structural tags", () => {
  const input = `<message to="human" timeout="-1">Response</message>`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(1)
  expect(result.remainingText).toBe("")
  expect(result.malformed).toBe(false)
})

test("malformed when raw text before message", () => {
  const input = `Thinking...\n<message to="human" timeout="-1">Response</message>`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(1)
  expect(result.remainingText).toBe("Thinking...")
  expect(result.malformed).toBe(true) // Raw text not allowed
})

test("malformed for pure thinking without structural tags", () => {
  const input = `Just some thinking text without any message tags`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(0)
  expect(result.malformed).toBe(true) // Raw text not allowed
})

test("malformed when missing attributes", () => {
  const input = `<message to="human">Missing timeout</message>`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(0)
  expect(result.malformed).toBe(true)
  expect(result.errors).toBeDefined()
})

// Protocol rule tests: at most ONE wait, must be last

test("malformed when multiple wait tags", () => {
  const input = `<message to="ses_a" timeout="0">Task A</message>
<wait sources="ses_a" timeout="60000" mode="all"/>
<message to="ses_b" timeout="0">Task B</message>
<wait sources="ses_b" timeout="30000" mode="any"/>`
  const result = MessageParser.parse(input)
  expect(result.malformed).toBe(true)
  expect(result.errors).toContain("Multiple <wait> tags not allowed. Found 2, expected at most 1.")
})

test("malformed when message after wait", () => {
  const input = `<message to="ses_a" timeout="0">Task A</message>
<wait sources="ses_a" timeout="60000" mode="all"/>
<message to="ses_b" timeout="0">Task B after wait</message>`
  const result = MessageParser.parse(input)
  expect(result.malformed).toBe(true)
  expect(result.errors).toContain("<wait> must be the last element. Found <message> tag after <wait>.")
})

test("valid: messages then single wait at end", () => {
  const input = `<message to="ses_a" timeout="0">Task A</message>
<message to="ses_b" timeout="0">Task B</message>
<message to="ses_c" timeout="0">Task C</message>
<wait sources="ses_a,ses_b,ses_c" timeout="60000" mode="all"/>`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(3)
  expect(result.wait).toBeDefined()
  expect(result.wait?.sources).toEqual(["ses_a", "ses_b", "ses_c"])
  expect(result.malformed).toBe(false)
})

test("valid: messages only, no wait", () => {
  const input = `<message to="ses_a" timeout="0">Task A</message>
<message to="ses_b" timeout="0">Task B</message>`
  const result = MessageParser.parse(input)
  expect(result.messages).toHaveLength(2)
  expect(result.wait).toBeUndefined()
  expect(result.malformed).toBe(false)
})
