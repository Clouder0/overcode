import { describe, expect, test } from "bun:test"
import { projectSkillProjection } from "../../src/cli/cmd/tui/routes/session/skill-projection"

function text(id: string) {
  return {
    id,
    type: "text",
  }
}

function skill(id: string, name: string) {
  return {
    id,
    type: "tool",
    tool: "skill",
    state: {
      status: "completed",
      metadata: { name, applied: true },
      input: { name },
    },
  }
}

describe("tui skill projection visibility", () => {
  test("non-abort errored assistant skill load does not supersede visible load", () => {
    const projection = projectSkillProjection({
      messages: [
        { id: "u1", role: "user" },
        { id: "a1", role: "assistant" },
        { id: "u2", role: "user" },
        {
          id: "a2",
          role: "assistant",
          error: { name: "APIError", message: "boom" },
        },
      ],
      partsByMessageID: {
        u1: [text("u1p")],
        a1: [skill("p1", "brainstorming")],
        u2: [text("u2p")],
        a2: [skill("p2", "brainstorming")],
      },
    })

    expect(projection.activeByName.get("brainstorming")).toBe("p1")
    expect(Array.from(projection.supersededPartIDs)).toStrictEqual([])
  })

  test("aborted assistant message with skill output can supersede", () => {
    const projection = projectSkillProjection({
      messages: [
        { id: "u1", role: "user" },
        { id: "a1", role: "assistant" },
        { id: "u2", role: "user" },
        {
          id: "a2",
          role: "assistant",
          error: { name: "MessageAbortedError", message: "aborted" },
        },
      ],
      partsByMessageID: {
        u1: [text("u1p")],
        a1: [skill("p1", "brainstorming")],
        u2: [text("u2p")],
        a2: [skill("p2", "brainstorming")],
      },
    })

    expect(projection.activeByName.get("brainstorming")).toBe("p2")
    expect(Array.from(projection.supersededPartIDs)).toStrictEqual(["p1"])
    expect(projection.supersededNamesByMessageID.get("a1")).toStrictEqual(["brainstorming"])
  })

  test("ignores user-message skill parts for supersession authority", () => {
    const projection = projectSkillProjection({
      messages: [
        { id: "u1", role: "user" },
        { id: "a1", role: "assistant" },
        { id: "u2", role: "user" },
      ],
      partsByMessageID: {
        u1: [text("u1p")],
        a1: [skill("p1", "brainstorming")],
        u2: [text("u2p"), skill("p2", "brainstorming")],
      },
    })

    expect(projection.activeByName.get("brainstorming")).toBe("p1")
    expect(Array.from(projection.supersededPartIDs)).toStrictEqual([])
    expect(projection.supersededNamesByMessageID.size).toBe(0)
  })
})
