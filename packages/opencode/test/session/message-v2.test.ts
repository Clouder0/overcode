import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider/provider"

const sessionID = "session"
const model: Provider.Model = {
  id: "test-model",
  providerID: "test",
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function assistantInfo(
  id: string,
  parentID: string,
  error?: MessageV2.Assistant["error"],
  meta?: { providerID: string; modelID: string },
): MessageV2.Assistant {
  const infoModel = meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: infoModel.modelID,
    providerID: infoModel.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as MessageV2.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id,
    sessionID,
    messageID,
  }
}

describe("session.message-v2.toModelMessage", () => {
  test("modelVisible excludes assistant messages with non-abort errors", () => {
    const msg: MessageV2.WithParts = {
      info: assistantInfo(
        "m-assistant",
        "m-parent",
        new MessageV2.APIError({ message: "boom", isRetryable: true }).toObject() as MessageV2.APIError,
      ),
      parts: [
        {
          ...basePart("m-assistant", "a1"),
          type: "tool",
          callID: "call-1",
          tool: "skill",
          metadata: {},
          state: {
            status: "completed",
            input: { name: "brainstorming" },
            output: "skill-old",
            title: "Loaded skill: brainstorming",
            metadata: { name: "brainstorming", applied: true },
            time: { start: 0, end: 1 },
          },
        },
      ] as MessageV2.Part[],
    }

    expect(MessageV2.modelVisible(msg)).toBe(false)
  })

  test("modelVisible keeps aborted assistant messages with non-reasoning content", () => {
    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"]

    const msg: MessageV2.WithParts = {
      info: assistantInfo("m-assistant", "m-parent", aborted),
      parts: [
        {
          ...basePart("m-assistant", "a1"),
          type: "text",
          text: "partial",
        },
      ] as MessageV2.Part[],
    }

    expect(MessageV2.modelVisible(msg)).toBe(true)
  })

  test("filters out messages with no parts", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user"),
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hello",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("filters out messages with only ignored parts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes synthetic text parts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant", messageID),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "text",
            text: "assistant",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant" }],
      },
    ])
  })

  test("converts user text/file parts and injects subtask prompts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
          {
            ...basePart(messageID, "p3"),
            type: "file",
            mime: "image/png",
            filename: "img.png",
            url: "https://example.com/img.png",
          },
          {
            ...basePart(messageID, "p4"),
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "https://example.com/note.txt",
          },
          {
            ...basePart(messageID, "p5"),
            type: "file",
            mime: "application/x-directory",
            filename: "dir",
            url: "https://example.com/dir",
          },
          {
            ...basePart(messageID, "p6"),
            type: "compaction",
            auto: true,
          },
          {
            ...basePart(messageID, "p7"),
            type: "subtask",
            prompt: "prompt",
            description: "desc",
            agent: "agent",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "img.png",
            data: "https://example.com/img.png",
          },
          { type: "text", text: "The following tool was executed by the user" },
        ],
      },
    ])
  })

  test("converts assistant tool completion into tool-call + tool-result messages with attachments", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "attachment.png",
                  url: "data:image/png;base64,Zm9v",
                },
              ],
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done", providerOptions: { openai: { assistant: "meta" } } },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "content",
              value: [
                { type: "text", text: "ok" },
                { type: "media", mediaType: "image/png", data: "Zm9v" },
              ],
            },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("omits provider metadata when assistant model differs", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, { providerID: "other", modelID: "other" }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("replaces compacted tool output with placeholder", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "[Old tool result content cleared]" },
          },
        ],
      },
    ])
  })

  test("converts assistant tool error into error-text tool result", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "ls" },
              error: "nope",
              time: { start: 0, end: 1 },
              metadata: {},
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "error-text", value: "nope" },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("filters assistant messages with non-abort errors", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new MessageV2.APIError({ message: "boom", isRetryable: true }).toObject() as MessageV2.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes aborted assistant messages only when they have non-step-start/reasoning content", () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"]

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID1, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID1, "a2"),
            type: "text",
            text: "partial answer",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID2, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID2, "b1"),
            type: "step-start",
          },
          {
            ...basePart(assistantID2, "b2"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          { type: "text", text: "partial answer" },
        ],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "text",
            text: "first",
          },
          {
            ...basePart(assistantID, "p2"),
            type: "step-start",
          },
          {
            ...basePart(assistantID, "p3"),
            type: "text",
            text: "second",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    ])
  })

  test("includes message parts in model context", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "message",
            direction: "incoming",
            peer: "ses_child",
            peerType: "agent",
            text: "hello",
            time: { created: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Sender Agent with session id ses_child sent a message:\n<content>\nhello\n</content>",
          },
        ],
      },
    ])
  })

  test("includes seq for incoming system message parts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "message",
            direction: "incoming",
            peer: "Wait result",
            peerType: "system",
            text: "Wait resolved",
            time: { created: 0 },
            metadata: {
              opencode: {
                seq: 42,
              },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Wait result (seq: 42):\n<content>\nWait resolved\n</content>",
          },
        ],
      },
    ])
  })

  test("avoids duplicating legacy inbox synthetic text", () => {
    const messageID = "m-user"

    const inbox = "Sender Agent with session id ses_child sent a message:\n<content>\nhello\n</content>"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "message",
            direction: "incoming",
            peer: "ses_child",
            peerType: "agent",
            text: "hello",
            time: { created: 0 },
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: inbox,
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: inbox }],
      },
    ])
  })

  test("omits outgoing message parts from model context", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "message",
            direction: "outgoing",
            peer: "ses_parent",
            peerType: "agent",
            text: "hi",
            time: { created: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("avoids duplicating send_agent_message via outgoing message parts", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "send",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "send_agent_message",
            state: {
              status: "completed",
              input: { to: "ses_parent", text: "hi" },
              output: "ok",
              title: "Sent",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "message",
            direction: "outgoing",
            peer: "ses_parent",
            peerType: "agent",
            text: "hi",
            time: { created: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "send" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "send_agent_message",
            input: { to: "ses_parent", text: "hi" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "send_agent_message",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("drops messages that only contain step-start parts", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("converts pending/running tool calls to error results to prevent dangling tool_use", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { cmd: "ls" },
              raw: "",
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-running",
            tool: "read",
            state: {
              status: "running",
              input: { path: "/tmp" },
              time: { start: 0 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = MessageV2.toModelMessages(input, model)

    expect(result).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-pending",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
          {
            type: "tool-call",
            toolCallId: "call-running",
            toolName: "read",
            input: { path: "/tmp" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-pending",
            toolName: "bash",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
          {
            type: "tool-result",
            toolCallId: "call-running",
            toolName: "read",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
        ],
      },
    ])
  })

  test("keeps latest successful skill load per name and adds superseded marker", () => {
    const userID1 = "m-user-1"
    const userID2 = "m-user-2"
    const userID3 = "m-user-3"
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"
    const assistantID3 = "m-assistant-3"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID1),
        parts: [
          {
            ...basePart(userID1, "u1"),
            type: "text",
            text: "load brainstorming",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID1, userID1),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "skill",
            state: {
              status: "completed",
              input: { name: "brainstorming" },
              output: "skill-old",
              title: "Loaded skill: brainstorming",
              metadata: { name: "brainstorming" },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
      {
        info: userInfo(userID2),
        parts: [
          {
            ...basePart(userID2, "u2"),
            type: "text",
            text: "load formatter",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID2, userID2),
        parts: [
          {
            ...basePart(assistantID2, "a2"),
            type: "tool",
            callID: "call-2",
            tool: "skill",
            state: {
              status: "completed",
              input: { name: "user-output-format" },
              output: "skill-b",
              title: "Loaded skill: user-output-format",
              metadata: { name: "user-output-format" },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
      {
        info: userInfo(userID3),
        parts: [
          {
            ...basePart(userID3, "u3"),
            type: "text",
            text: "reload brainstorming",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID3, userID3),
        parts: [
          {
            ...basePart(assistantID3, "a3"),
            type: "tool",
            callID: "call-3",
            tool: "skill",
            state: {
              status: "completed",
              input: { name: "brainstorming" },
              output: "skill-new",
              title: "Loaded skill: brainstorming",
              metadata: { name: "brainstorming" },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "load brainstorming" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Context note: superseded skill loads omitted: brainstorming. Newer successful loads are authoritative.",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "load formatter" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "skill",
            input: { name: "user-output-format" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "skill",
            output: { type: "text", value: "skill-b" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "reload brainstorming" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-3",
            toolName: "skill",
            input: { name: "brainstorming" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-3",
            toolName: "skill",
            output: { type: "text", value: "skill-new" },
          },
        ],
      },
    ])
  })

  test("does not supersede visible skill load with hidden errored assistant reload", () => {
    const userID1 = "m-user-1"
    const userID2 = "m-user-2"
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID1),
        parts: [
          {
            ...basePart(userID1, "u1"),
            type: "text",
            text: "load brainstorming",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID1, userID1),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "skill",
            state: {
              status: "completed",
              input: { name: "brainstorming" },
              output: "skill-old",
              title: "Loaded skill: brainstorming",
              metadata: { name: "brainstorming" },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
      {
        info: userInfo(userID2),
        parts: [
          {
            ...basePart(userID2, "u2"),
            type: "text",
            text: "reload brainstorming",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(
          assistantID2,
          userID2,
          new MessageV2.APIError({ message: "boom", isRetryable: true }).toObject() as MessageV2.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID2, "a2"),
            type: "tool",
            callID: "call-2",
            tool: "skill",
            state: {
              status: "completed",
              input: { name: "brainstorming" },
              output: "skill-hidden",
              title: "Loaded skill: brainstorming",
              metadata: { name: "brainstorming" },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "load brainstorming" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "skill",
            input: { name: "brainstorming" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "skill",
            output: { type: "text", value: "skill-old" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "reload brainstorming" }],
      },
    ])
  })

  test("ignores user-message skill parts when resolving authoritative skill loads", () => {
    const userID1 = "m-user-1"
    const userID2 = "m-user-2"
    const assistantID1 = "m-assistant-1"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID1),
        parts: [
          {
            ...basePart(userID1, "u1"),
            type: "text",
            text: "load brainstorming",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID1, userID1),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "skill",
            state: {
              status: "completed",
              input: { name: "brainstorming" },
              output: "skill-old",
              title: "Loaded skill: brainstorming",
              metadata: { name: "brainstorming", applied: true },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
      {
        info: userInfo(userID2),
        parts: [
          {
            ...basePart(userID2, "u2"),
            type: "text",
            text: "continue",
          },
          {
            ...basePart(userID2, "u2-skill"),
            type: "tool",
            callID: "call-user",
            tool: "skill",
            state: {
              status: "completed",
              input: { name: "brainstorming" },
              output: "skill-user",
              title: "Loaded skill: brainstorming",
              metadata: { name: "brainstorming", applied: true },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "load brainstorming" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "skill",
            input: { name: "brainstorming" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "skill",
            output: { type: "text", value: "skill-old" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "continue" }],
      },
    ])
  })

  test("does not supersede successful skill load with failed reload", () => {
    const userID1 = "m-user-1"
    const userID2 = "m-user-2"
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID1),
        parts: [
          {
            ...basePart(userID1, "u1"),
            type: "text",
            text: "load brainstorming",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID1, userID1),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "skill",
            state: {
              status: "completed",
              input: { name: "brainstorming" },
              output: "skill-old",
              title: "Loaded skill: brainstorming",
              metadata: { name: "brainstorming" },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
      {
        info: userInfo(userID2),
        parts: [
          {
            ...basePart(userID2, "u2"),
            type: "text",
            text: "reload brainstorming",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID2, userID2),
        parts: [
          {
            ...basePart(assistantID2, "a2"),
            type: "tool",
            callID: "call-2",
            tool: "skill",
            state: {
              status: "error",
              input: { name: "brainstorming" },
              error: "failed to load",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "load brainstorming" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "skill",
            input: { name: "brainstorming" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "skill",
            output: { type: "text", value: "skill-old" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "reload brainstorming" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "skill",
            input: { name: "brainstorming" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "skill",
            output: { type: "error-text", value: "failed to load" },
          },
        ],
      },
    ])
  })

  test("omits no-op skill reload output from model context", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "reload skill",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "skill",
            state: {
              status: "completed",
              input: { name: "brainstorming" },
              output: "NOOP_SKILL_OUTPUT",
              title: "Skill already loaded",
              metadata: { name: "brainstorming", applied: false, status: "noop" },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "reload skill" }],
      },
    ])
  })
})

describe("session.message-v2.fileLabel", () => {
  test("does not inline data URLs", () => {
    const messageID = "m-user"
    const file: MessageV2.FilePart = {
      ...basePart(messageID, "p-file"),
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64," + "a".repeat(4096),
    }

    expect(MessageV2.fileLabel(file)).toBe("inline image/png")
  })

  test("prefers filename and strips file:// query", () => {
    const messageID = "m-user"
    const named: MessageV2.FilePart = {
      ...basePart(messageID, "p-named"),
      type: "file",
      mime: "text/plain",
      filename: "note.txt",
      url: "data:text/plain;base64," + "a".repeat(1024),
    }
    expect(MessageV2.fileLabel(named)).toBe("note.txt")

    const local: MessageV2.FilePart = {
      ...basePart(messageID, "p-local"),
      type: "file",
      mime: "application/octet-stream",
      url: "file:///tmp/demo.bin?signature=secret",
    }
    expect(MessageV2.fileLabel(local)).toBe("/tmp/demo.bin")
  })
})
