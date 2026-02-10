import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { formatMessage, formatPart, formatTranscript } from "../../../src/cli/cmd/tui/util/transcript"

describe("tui.transcript formatting", () => {
  describe("formatPart", () => {
    const options = { thinking: true, toolDetails: true, assistantMetadata: true }

    test("formats tool error", () => {
      const part: Part = {
        id: "part_1",
        sessionID: "ses_123",
        messageID: "msg_123",
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: {
          status: "error",
          input: { command: "invalid" },
          error: "Command failed",
          time: { start: 1000, end: 1100 },
        },
      }
      const result = formatPart(part, options)
      expect(result).toContain("**Error:**")
      expect(result).toContain("Command failed")
    })

    test("formats wait tool fallback output when completed output is empty", () => {
      const part: Part = {
        id: "part_wait",
        sessionID: "ses_123",
        messageID: "msg_123",
        type: "tool",
        callID: "call_wait",
        tool: "wait_agent_message",
        state: {
          status: "completed",
          input: {
            sources: ["ses_child"],
            timeout: 1000,
            mode: "all",
            since: 12,
          },
          output: "",
          title: "Wait resolved",
          metadata: {
            status: "resolved",
            since: 12,
            respondedSources: ["ses_child"],
            timedOutSources: [],
          },
          time: { start: 1000, end: 1100 },
        },
      }

      const result = formatPart(part, options)
      expect(result).toContain("**Output:**")
      expect(result).toContain("Wait resolved")
      expect(result).toContain("status: resolved")
      expect(result).toContain("since: 12")
      expect(result).toContain("responded: ses_child")
    })

    test("formats message part", () => {
      const part: Part = {
        id: "part_1",
        sessionID: "ses_123",
        messageID: "msg_123",
        type: "message",
        direction: "incoming",
        peer: "ses_child",
        peerType: "agent",
        text: "Hello from child",
        time: { created: 1000 },
      }

      const result = formatPart(part, options)
      expect(result).toContain("_Message from agent ses_child:_")
      expect(result).toContain("Hello from child")
    })

    test("formats message part with seq metadata", () => {
      const part = {
        id: "part_1",
        sessionID: "ses_123",
        messageID: "msg_123",
        type: "message",
        direction: "incoming",
        peer: "ses_child",
        peerType: "agent",
        text: "Hello from child",
        time: { created: 1000 },
        metadata: {
          opencode: {
            seq: 123,
          },
        },
      } as any

      const result = formatPart(part, options)
      expect(result).toContain("seq: 123")
    })

    test("formats system message part", () => {
      const part: Part = {
        id: "part_1",
        sessionID: "ses_123",
        messageID: "msg_123",
        type: "message",
        direction: "incoming",
        peer: "Wait result",
        peerType: "system",
        text: "Wait timed out after 30000ms\nResponded: ses_ok\nTimed out: ses_timeout",
        time: { created: 1000 },
      }

      const result = formatPart(part, options)
      expect(result).toContain("_Message from system Wait result:_")
      expect(result).toContain("Wait timed out")
    })
  })

  describe("formatMessage", () => {
    const options = { thinking: true, toolDetails: true, assistantMetadata: true }

    test("formats user message", () => {
      const msg: UserMessage = {
        id: "msg_123",
        sessionID: "ses_123",
        role: "user",
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
        time: { created: 1000000 },
      }
      const parts: Part[] = [{ id: "p1", sessionID: "ses_123", messageID: "msg_123", type: "text", text: "Hello" }]
      const result = formatMessage(msg, parts, options)
      expect(result).toContain("## User")
      expect(result).toContain("Hello")
    })

    test("formats assistant message with metadata", () => {
      const msg: AssistantMessage = {
        id: "msg_123",
        sessionID: "ses_123",
        role: "assistant",
        agent: "build",
        modelID: "claude-sonnet-4-20250514",
        providerID: "anthropic",
        mode: "",
        parentID: "msg_parent",
        path: { cwd: "/test", root: "/test" },
        cost: 0.001,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1000000, completed: 1005400 },
      }
      const parts: Part[] = [{ id: "p1", sessionID: "ses_123", messageID: "msg_123", type: "text", text: "Hi there" }]
      const result = formatMessage(msg, parts, options)
      expect(result).toContain("## Assistant (Build · claude-sonnet-4-20250514 · 5.4s)")
      expect(result).toContain("Hi there")
    })
  })

  describe("formatTranscript", () => {
    test("formats complete transcript", () => {
      const session = {
        id: "ses_abc123",
        title: "Test Session",
        time: { created: 1000000000000, updated: 1000000001000 },
      }
      const messages = [
        {
          info: {
            id: "msg_1",
            sessionID: "ses_abc123",
            role: "user" as const,
            agent: "build",
            model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
            time: { created: 1000000000000 },
          },
          parts: [{ id: "p1", sessionID: "ses_abc123", messageID: "msg_1", type: "text" as const, text: "Hello" }],
        },
        {
          info: {
            id: "msg_2",
            sessionID: "ses_abc123",
            role: "assistant" as const,
            agent: "build",
            modelID: "claude-sonnet-4-20250514",
            providerID: "anthropic",
            mode: "",
            parentID: "msg_1",
            path: { cwd: "/test", root: "/test" },
            cost: 0.001,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1000000000500, completed: 1000000001000 },
          },
          parts: [{ id: "p2", sessionID: "ses_abc123", messageID: "msg_2", type: "text" as const, text: "Hi" }],
        },
      ]

      const options = { thinking: true, toolDetails: true, assistantMetadata: true }
      const result = formatTranscript(session, messages as any, options)
      expect(result).toContain("# Test Session")
      expect(result).toContain("## User")
      expect(result).toContain("## Assistant")
    })
  })
})
