import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { batchEnd, coveredUsers, isAnswered, settingsKey } from "../../src/session/queue-batch"

function user(input: {
  id: string
  modelID?: string
  providerID?: string
  agent?: string
  system?: string
  tools?: Record<string, boolean>
  variant?: string
  serviceTier?: "auto" | "flex" | "priority"
}) {
  const info: MessageV2.User = {
    id: input.id,
    sessionID: "ses_test",
    role: "user",
    time: { created: 1 },
    agent: input.agent ?? "build",
    model: {
      providerID: input.providerID ?? "dummy",
      modelID: input.modelID ?? "dummy",
    },
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.variant === undefined ? {} : { variant: input.variant }),
    ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
  }

  return {
    info,
    parts: [
      {
        id: `prt_${input.id}`,
        messageID: input.id,
        sessionID: "ses_test",
        type: "text",
        text: "u",
      } satisfies MessageV2.TextPart,
    ],
  } satisfies MessageV2.WithParts
}

function assistant(input: { id: string; parentID: string; completed?: boolean; finish?: string; error?: boolean }) {
  return {
    info: {
      id: input.id,
      sessionID: "ses_test",
      role: "assistant",
      parentID: input.parentID,
      modelID: "dummy",
      providerID: "dummy",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: {
        created: 1,
        ...(input.completed === true ? { completed: 2 } : {}),
      },
      ...(input.finish === undefined ? {} : { finish: input.finish }),
      ...(input.error === true
        ? {
            error: {
              name: "UnknownError",
              message: "failed",
            },
          }
        : {}),
    } as MessageV2.Assistant,
    parts: [],
  } satisfies MessageV2.WithParts
}

describe("queue batch helpers", () => {
  test("settingsKey is stable for equivalent user settings", () => {
    const a = user({
      id: "u1",
      tools: { bash: true, read: false },
      system: "sys",
      variant: "v1",
      serviceTier: "priority",
    })
    const b = user({
      id: "u2",
      tools: { read: false, bash: true },
      system: "sys",
      variant: "v1",
      serviceTier: "priority",
    })

    expect(settingsKey(a.info as MessageV2.User)).toBe(settingsKey(b.info as MessageV2.User))
  })

  test("settingsKey changes when service tier changes", () => {
    const base = user({ id: "u1", serviceTier: "auto" })
    const fast = user({ id: "u2", serviceTier: "priority" })

    expect(settingsKey(base.info as MessageV2.User)).not.toBe(settingsKey(fast.info as MessageV2.User))
  })

  test("coveredUsers reads hidden assistant batch metadata", () => {
    const msg: MessageV2.WithParts = {
      info: assistant({ id: "a1", parentID: "u1", completed: true, finish: "end_turn" }).info,
      parts: [
        {
          id: "prt_1",
          messageID: "a1",
          sessionID: "ses_test",
          type: "text",
          text: "",
          synthetic: true,
          ignored: true,
          metadata: {
            opencode: {
              batch: {
                users: ["u1", "u2"],
              },
            },
          },
        },
      ],
    }

    expect(coveredUsers(msg)).toEqual(["u1", "u2"])
  })

  test("isAnswered returns true for direct or covered terminal replies", () => {
    const direct = assistant({ id: "a1", parentID: "u1", completed: true, finish: "end_turn" })
    const pending = assistant({ id: "a2", parentID: "u1", completed: true, finish: "tool-calls" })

    expect(isAnswered({ userID: "u1", replies: [direct], covered: new Set<string>() })).toBe(true)
    expect(isAnswered({ userID: "u1", replies: [pending], covered: new Set<string>() })).toBe(false)
    expect(isAnswered({ userID: "u2", replies: [], covered: new Set<string>(["u2"]) })).toBe(true)
  })

  test("batchEnd stops at first settings boundary", () => {
    const users = [
      user({ id: "u1", modelID: "a" }),
      user({ id: "u2", modelID: "a" }),
      user({ id: "u3", modelID: "b" }),
      user({ id: "u4", modelID: "a" }),
    ]

    const end = batchEnd({
      users,
      start: 0,
      isUnanswered: () => true,
    })

    expect(end).toBe(1)
  })
})
