import { test, expect, beforeEach } from "bun:test"
import { MessageWait } from "../../src/session/message-wait"

beforeEach(() => {
  MessageWait.cancel("test_session")
})

test("registerSingle creates wait state", () => {
  MessageWait.registerSingle("test_session", "source_a", 30000)
  expect(MessageWait.isWaiting("test_session")).toBe(true)
})

test("registerMulti creates wait state for multiple sources", () => {
  MessageWait.registerMulti("test_session", ["source_a", "source_b"], 60000, "all")
  expect(MessageWait.isWaiting("test_session")).toBe(true)
})

test("onMessage resolves single wait", () => {
  let resolved = false
  MessageWait.registerSingle("test_session", "source_a", 30000, () => {
    resolved = true
  })

  const result = MessageWait.onMessage("test_session", "source_a", "Response")
  expect(result).toBe(true)
  expect(resolved).toBe(true)
  expect(MessageWait.isWaiting("test_session")).toBe(false)
})

test("onMessage ignores messages from unknown sources", () => {
  MessageWait.registerSingle("test_session", "source_a", 30000)

  const result = MessageWait.onMessage("test_session", "unknown_source", "Response")
  expect(result).toBe(false)
  expect(MessageWait.isWaiting("test_session")).toBe(true)
})

test("multi-wait all mode requires all sources", () => {
  MessageWait.registerMulti("test_session", ["source_a", "source_b"], 60000, "all")

  MessageWait.onMessage("test_session", "source_a", "Response A")
  expect(MessageWait.isWaiting("test_session")).toBe(true)

  MessageWait.onMessage("test_session", "source_b", "Response B")
  expect(MessageWait.isWaiting("test_session")).toBe(false)
})

test("multi-wait any mode resolves on first message", () => {
  MessageWait.registerMulti("test_session", ["source_a", "source_b"], 60000, "any")

  MessageWait.onMessage("test_session", "source_a", "Response A")
  expect(MessageWait.isWaiting("test_session")).toBe(false)
})

test("cancel removes wait state", () => {
  MessageWait.registerSingle("test_session", "source_a", 30000)
  expect(MessageWait.isWaiting("test_session")).toBe(true)

  MessageWait.cancel("test_session")
  expect(MessageWait.isWaiting("test_session")).toBe(false)
})

test("getMissingSources returns sources without responses", () => {
  MessageWait.registerMulti("test_session", ["source_a", "source_b", "source_c"], 60000, "all")

  MessageWait.onMessage("test_session", "source_a", "Response A")

  const missing = MessageWait.getMissingSources("test_session")
  expect(missing).toContain("source_b")
  expect(missing).toContain("source_c")
  expect(missing).not.toContain("source_a")
})

test("getMissingSources returns empty array for non-waiting session", () => {
  const missing = MessageWait.getMissingSources("nonexistent_session")
  expect(missing).toEqual([])
})

// Tests for the async wait() function

test("wait() resolves with responses in 'any' mode when first message arrives", async () => {
  // Set up a simple peekPending that returns empty (no pre-existing messages)
  MessageWait.setPeekPendingFn(() => [])

  const waitPromise = MessageWait.wait({
    sessionID: "test_wait_any",
    sources: ["source_a", "source_b"],
    timeout: 5000,
    mode: "any",
  })

  // Simulate message arrival
  MessageWait.onMessage("test_wait_any", "source_a", "Response from A")

  const result = await waitPromise

  expect(result.responses).toHaveLength(1)
  expect(result.responses[0].from).toBe("source_a")
  expect(result.responses[0].text).toBe("Response from A")
  expect(result.responses[0].timedOut).toBe(false)
  expect(result.allReceived).toBe(false)
})

test("wait() resolves with all responses in 'all' mode", async () => {
  MessageWait.setPeekPendingFn(() => [])

  const waitPromise = MessageWait.wait({
    sessionID: "test_wait_all",
    sources: ["source_a", "source_b"],
    timeout: 5000,
    mode: "all",
  })

  // Simulate messages arriving
  MessageWait.onMessage("test_wait_all", "source_a", "Response from A")
  MessageWait.onMessage("test_wait_all", "source_b", "Response from B")

  const result = await waitPromise

  expect(result.responses).toHaveLength(2)
  expect(result.allReceived).toBe(true)
  expect(result.responses.every((r) => !r.timedOut)).toBe(true)
})

test("wait() resolves immediately if messages already pending (race condition fix)", async () => {
  // Set up peekPending to return an already-pending message
  MessageWait.setPeekPendingFn((sessionID) => {
    if (sessionID === "test_race") {
      return [{ from: "source_a", text: "Already arrived" }]
    }
    return []
  })

  const result = await MessageWait.wait({
    sessionID: "test_race",
    sources: ["source_a"],
    timeout: 5000,
    mode: "any",
  })

  // Should resolve immediately with the pending message
  expect(result.responses).toHaveLength(1)
  expect(result.responses[0].from).toBe("source_a")
  expect(result.responses[0].text).toBe("Already arrived")
  expect(result.responses[0].timedOut).toBe(false)
})

test("wait() times out for missing sources", async () => {
  MessageWait.setPeekPendingFn(() => [])

  const result = await MessageWait.wait({
    sessionID: "test_timeout",
    sources: ["source_a", "source_b"],
    timeout: 50, // Short timeout for test
    mode: "all",
  })

  // Should have timeout responses for both sources
  expect(result.responses).toHaveLength(2)
  expect(result.allReceived).toBe(false)
  expect(result.responses.every((r) => r.timedOut)).toBe(true)
})

test("wait() partial timeout - some sources respond, others timeout", async () => {
  MessageWait.setPeekPendingFn(() => [])

  const waitPromise = MessageWait.wait({
    sessionID: "test_partial_timeout",
    sources: ["source_a", "source_b"],
    timeout: 100, // Short timeout for test
    mode: "all",
  })

  // Only source_a responds before timeout
  MessageWait.onMessage("test_partial_timeout", "source_a", "Response from A")

  const result = await waitPromise

  expect(result.responses).toHaveLength(2)
  expect(result.allReceived).toBe(false)

  const responseA = result.responses.find((r) => r.from === "source_a")
  const responseB = result.responses.find((r) => r.from === "source_b")

  expect(responseA?.timedOut).toBe(false)
  expect(responseA?.text).toBe("Response from A")
  expect(responseB?.timedOut).toBe(true)
})

test("registering new wait cancels previous wait's timer", () => {
  MessageWait.setPeekPendingFn(() => [])

  // Register first wait
  MessageWait.registerMulti("test_cancel_timer", ["source_a"], 60000, "all")
  expect(MessageWait.isWaiting("test_cancel_timer")).toBe(true)

  // Register new wait - should cancel the previous
  MessageWait.registerMulti("test_cancel_timer", ["source_b"], 60000, "all")
  expect(MessageWait.isWaiting("test_cancel_timer")).toBe(true)

  // Only source_b should be expected now
  const missing = MessageWait.getMissingSources("test_cancel_timer")
  expect(missing).toContain("source_b")
  expect(missing).not.toContain("source_a")
})

test("multiple sessions can wait independently", async () => {
  MessageWait.setPeekPendingFn(() => [])

  const wait1 = MessageWait.wait({
    sessionID: "session_1",
    sources: ["child_1"],
    timeout: 5000,
    mode: "any",
  })

  const wait2 = MessageWait.wait({
    sessionID: "session_2",
    sources: ["child_2"],
    timeout: 5000,
    mode: "any",
  })

  // Session 2 gets a response first
  MessageWait.onMessage("session_2", "child_2", "Response 2")
  const result2 = await wait2
  expect(result2.responses[0].text).toBe("Response 2")

  // Session 1 should still be waiting
  expect(MessageWait.isWaiting("session_1")).toBe(true)

  // Now session 1 gets a response
  MessageWait.onMessage("session_1", "child_1", "Response 1")
  const result1 = await wait1
  expect(result1.responses[0].text).toBe("Response 1")
})
