import { describe, expect, test } from "bun:test"
import type { Message, Part, PermissionRequest } from "@opencode-ai/sdk/v2"
import { applySyncEvent, type SyncStore } from "../../src/cli/cmd/tui/context/sync-reducer"

function createStore(): SyncStore {
  return {
    status: "complete",
    provider: [],
    provider_default: {},
    provider_next: { all: [], default: {}, connected: [] },
    provider_auth: {},
    agent: [],
    command: [],
    permission: {},
    question: {},
    config: {} as any,
    session: [],
    session_status: {},
    session_diff: {},
    todo: {},
    message: {},
    part: {},
    lsp: [],
    mcp: {},
    mcp_resource: {},
    formatter: [],
    vcs: undefined,
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
  }
}

function msg(id: string, sessionID: string, role: Message["role"]): Message {
  if (role === "user") {
    return {
      id,
      sessionID,
      role: "user",
      agent: "build",
      model: { providerID: "opencode", modelID: "opencode" },
      time: { created: 0 },
    }
  }

  return {
    id,
    sessionID,
    role: "assistant",
    agent: "build",
    mode: "",
    parentID: "msg_parent",
    modelID: "opencode",
    providerID: "opencode",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0 },
  }
}

function textPart(id: string, sessionID: string, messageID: string): Part {
  return {
    id,
    sessionID,
    messageID,
    type: "text",
    text: "hello",
  }
}

describe("tui sync part pruning", () => {
  test("evicts parts when messages exceed 100", () => {
    const store = createStore()
    const sessionID = "ses_1"

    for (let i = 0; i < 101; i++) {
      const messageID = `msg_${i}`
      applySyncEvent(store, {
        type: "message.updated",
        properties: { info: msg(messageID, sessionID, "user") },
      })

      applySyncEvent(store, {
        type: "message.part.updated",
        properties: { part: textPart(`prt_${i}`, sessionID, messageID) },
      })
    }

    expect(store.message[sessionID].length).toBe(100)
    expect(store.part["msg_0"]).toBeUndefined()
    expect(store.part["msg_1"]).toBeDefined()
  })

  test("does not recreate parts for evicted messages via late part update", () => {
    const store = createStore()
    const sessionID = "ses_1"

    for (let i = 0; i < 101; i++) {
      applySyncEvent(store, {
        type: "message.updated",
        properties: { info: msg(`msg_${i}`, sessionID, "user") },
      })
    }

    applySyncEvent(store, {
      type: "message.part.updated",
      properties: { part: textPart("prt_late", sessionID, "msg_0") },
    })

    expect(store.part["msg_0"]).toBeUndefined()
  })

  test("does not delete parts for message referenced by pending permission", () => {
    const store = createStore()
    const sessionID = "ses_1"

    const request: PermissionRequest = {
      id: "per_1" as any,
      sessionID,
      permission: "bash",
      patterns: ["*"] as any,
      metadata: {},
      always: [],
      tool: {
        messageID: "msg_0",
        callID: "call_0",
      },
    }

    store.permission[sessionID] = [request]

    // Fill message list so msg_0 gets evicted
    applySyncEvent(store, { type: "message.updated", properties: { info: msg("msg_0", sessionID, "user") } })
    applySyncEvent(store, {
      type: "message.part.updated",
      properties: { part: textPart("prt_0", sessionID, "msg_0") },
    })

    for (let i = 1; i < 102; i++) {
      applySyncEvent(store, {
        type: "message.updated",
        properties: { info: msg(`msg_${i}`, sessionID, "user") },
      })
    }

    expect(store.message[sessionID].length).toBe(100)
    expect(store.part["msg_0"]).toBeDefined()

    // message.removed should also respect protection
    applySyncEvent(store, {
      type: "message.removed",
      properties: { sessionID, messageID: "msg_0" },
    })

    expect(store.part["msg_0"]).toBeDefined()
  })
})
