import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { classifySkillReuse } from "../../src/util/skill-dedupe"

const tokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

function text(id: string, messageID: string, value: string): MessageV2.TextPart {
  return {
    id,
    sessionID: "s1",
    messageID,
    type: "text",
    text: value,
  }
}

function skill(
  id: string,
  messageID: string,
  input: {
    name?: string
    hash?: string
    applied?: boolean
    anchorUserID?: string
  } = {},
): MessageV2.ToolPart {
  return {
    id,
    sessionID: "s1",
    messageID,
    type: "tool",
    callID: `call-${id}`,
    tool: "skill",
    state: {
      status: "completed",
      input: { name: input.name ?? "brainstorming" },
      output: "loaded",
      title: "Loaded skill",
      metadata: {
        name: input.name ?? "brainstorming",
        hash: input.hash ?? "hash-1",
        applied: input.applied ?? true,
        reason: input.applied === false ? "same_turn" : "applied",
        ...(input.anchorUserID ? { anchorUserID: input.anchorUserID } : {}),
      },
      time: {
        start: 1,
        end: 2,
      },
    },
  }
}

function assistant(id: string, parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "s1",
      role: "assistant",
      time: { created: 1 },
      parentID: "parent",
      modelID: "model",
      providerID: "provider",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens,
    },
    parts,
  }
}

function user(id: string): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "s1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    },
    parts: [text(`${id}-text`, id, "hello")],
  }
}

function marker(id: string, messageID: string): MessageV2.TextPart {
  return {
    id,
    sessionID: "s1",
    messageID,
    type: "text",
    text: "trim",
    synthetic: true,
    ignored: true,
    metadata: {
      opencode: {
        marker: {
          kind: "trim",
          at: 1,
        },
      },
    },
  }
}

describe("util.skill-dedupe", () => {
  test("same_turn requires visible applied prior load and no marker after it", () => {
    expect(
      classifySkillReuse({
        name: "brainstorming",
        hash: "hash-1",
        anchorUserID: "u1",
        visible: [assistant("a1", [skill("p1", "a1", { anchorUserID: "u1" })]), user("u1")],
        currentMessageID: "a2",
        current: [],
      }),
    ).toEqual({ kind: "same_turn", turns: 1 })

    expect(
      classifySkillReuse({
        name: "brainstorming",
        hash: "hash-1",
        anchorUserID: "u1",
        visible: [assistant("a1", [skill("p1", "a1", { anchorUserID: "u1", applied: false })]), user("u1")],
        currentMessageID: "a2",
        current: [],
      }),
    ).toBeUndefined()
  })

  test("near_context ignores noop loads as authority", () => {
    expect(
      classifySkillReuse({
        name: "brainstorming",
        hash: "hash-1",
        visible: [assistant("a1", [skill("p1", "a1")]), user("u1")],
        currentMessageID: "a2",
        current: [],
      }),
    ).toEqual({ kind: "near_context", turns: 1 })

    expect(
      classifySkillReuse({
        name: "brainstorming",
        hash: "hash-1",
        visible: [assistant("a1", [skill("p1", "a1", { applied: false })]), user("u1")],
        currentMessageID: "a2",
        current: [],
      }),
    ).toBeUndefined()

    expect(
      classifySkillReuse({
        name: "brainstorming",
        hash: "hash-1",
        anchorUserID: "u1",
        visible: [
          assistant("a0", [skill("p0", "a0", { anchorUserID: "u0" })]),
          assistant("a1", [skill("p1", "a1", { applied: false, anchorUserID: "u1" })]),
          user("u1"),
        ],
        currentMessageID: "a2",
        current: [],
      }),
    ).toEqual({ kind: "near_context", turns: 1 })
  })

  test("duplicate_in_turn requires current message completed applied load", () => {
    expect(
      classifySkillReuse({
        name: "brainstorming",
        hash: "hash-1",
        visible: [assistant("current", [skill("stale", "current", { applied: false })])],
        currentMessageID: "current",
        current: [skill("p1", "current")],
      }),
    ).toEqual({ kind: "duplicate_in_turn", turns: 0 })

    expect(
      classifySkillReuse({
        name: "brainstorming",
        hash: "hash-1",
        visible: [],
        currentMessageID: "current",
        current: [skill("p1", "current", { applied: false })],
      }),
    ).toBeUndefined()
  })

  test("marker after prior load invalidates same_turn and near_context", () => {
    expect(
      classifySkillReuse({
        name: "brainstorming",
        hash: "hash-1",
        anchorUserID: "u1",
        visible: [
          assistant("a1", [skill("p1", "a1", { anchorUserID: "u1" })]),
          assistant("m1", [marker("m1-p", "m1")]),
          user("u1"),
        ],
        currentMessageID: "a2",
        current: [],
      }),
    ).toBeUndefined()

    expect(
      classifySkillReuse({
        name: "brainstorming",
        hash: "hash-1",
        visible: [assistant("a1", [skill("p1", "a1")]), assistant("m1", [marker("m1-p", "m1")]), user("u1")],
        currentMessageID: "a2",
        current: [],
      }),
    ).toBeUndefined()
  })

  test("marker before prior load does not invalidate dedupe", () => {
    expect(
      classifySkillReuse({
        name: "brainstorming",
        hash: "hash-1",
        anchorUserID: "u1",
        visible: [
          assistant("m1", [marker("m1-p", "m1")]),
          assistant("a1", [skill("p1", "a1", { anchorUserID: "u1" })]),
          user("u1"),
        ],
        currentMessageID: "a2",
        current: [],
      }),
    ).toEqual({ kind: "same_turn", turns: 1 })
  })
})
