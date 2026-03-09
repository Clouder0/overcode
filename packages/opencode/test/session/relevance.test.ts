import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { isAssistantAnsweredMessage } from "../../src/session/relevance"

const tokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

function assistant(input: { id: string; finish: string; parts?: MessageV2.Part[] }) {
  return {
    info: {
      id: input.id,
      sessionID: "ses_test",
      role: "assistant",
      parentID: "u1",
      modelID: "dummy",
      providerID: "dummy",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens,
      time: { created: 1, completed: 2 },
      finish: input.finish,
    },
    parts: input.parts ?? [],
  } satisfies MessageV2.WithParts
}

function text(id: string, messageID: string, value: string) {
  return {
    id,
    sessionID: "ses_test",
    messageID,
    type: "text",
    text: value,
  } satisfies MessageV2.TextPart
}

function handoff(id: string, messageID: string, value: string) {
  return {
    id,
    sessionID: "ses_test",
    messageID,
    type: "message",
    direction: "outgoing",
    peer: "ses_parent",
    peerType: "agent",
    text: value,
    time: { created: 1 },
  } satisfies MessageV2.MessagePart
}

describe("session.relevance", () => {
  test("completed stop assistant without outgoing handoff is answered", () => {
    const msg = assistant({ id: "a1", finish: "stop" })

    expect(isAssistantAnsweredMessage(msg)).toBe(true)
  })

  test("completed stop assistant with only outgoing agent handoff is not answered", () => {
    const id = "a2"
    const msg = assistant({
      id,
      finish: "stop",
      parts: [handoff("p1", id, "report")],
    })

    expect(isAssistantAnsweredMessage(msg)).toBe(false)
  })

  test("completed stop assistant with handoff and local text is answered", () => {
    const id = "a3"
    const msg = assistant({
      id,
      finish: "stop",
      parts: [handoff("p1", id, "report"), text("p2", id, "done")],
    })

    expect(isAssistantAnsweredMessage(msg)).toBe(true)
  })

  test("completed tool-calls assistant stays non-terminal", () => {
    const id = "a4"
    const msg = assistant({
      id,
      finish: "tool-calls",
      parts: [text("p1", id, "working")],
    })

    expect(isAssistantAnsweredMessage(msg)).toBe(false)
  })
})
