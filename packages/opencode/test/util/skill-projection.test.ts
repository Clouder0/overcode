import { describe, expect, test } from "bun:test"
import { SkillProjection } from "../../src/util/skill-projection"

function skill(input: {
  id: string
  status?: "completed" | "error"
  name?: string
  inputName?: string
  applied?: boolean
}) {
  return {
    id: input.id,
    type: "tool",
    tool: "skill",
    state: {
      status: input.status ?? "completed",
      metadata: {
        ...(input.name ? { name: input.name } : {}),
        ...(typeof input.applied === "boolean" ? { applied: input.applied } : {}),
      },
      input: input.inputName ? { name: input.inputName } : {},
    },
  }
}

function text(id: string) {
  return {
    id,
    type: "text",
    text: "noop",
  }
}

describe("util.skill-projection", () => {
  test("latest successful load per skill name is active", () => {
    const projection = SkillProjection.project([
      {
        id: "m1",
        role: "assistant",
        parts: [skill({ id: "p1", name: "brainstorming" })],
      },
      {
        id: "m2",
        role: "assistant",
        parts: [skill({ id: "p2", name: "user-output-format" })],
      },
      {
        id: "m3",
        role: "assistant",
        parts: [skill({ id: "p3", name: "brainstorming" })],
      },
    ])

    expect(projection.activeByName.get("brainstorming")).toBe("p3")
    expect(projection.activeByName.get("user-output-format")).toBe("p2")
    expect(Array.from(projection.supersededPartIDs)).toStrictEqual(["p1"])
    expect(projection.supersededNamesByMessageID.get("m1")).toStrictEqual(["brainstorming"])
  })

  test("failed reload does not supersede prior successful load", () => {
    const projection = SkillProjection.project([
      {
        id: "m1",
        role: "assistant",
        parts: [skill({ id: "p1", name: "brainstorming", status: "completed" })],
      },
      {
        id: "m2",
        role: "assistant",
        parts: [skill({ id: "p2", inputName: "brainstorming", status: "error" })],
      },
    ])

    expect(projection.activeByName.get("brainstorming")).toBe("p1")
    expect(Array.from(projection.supersededPartIDs)).toStrictEqual([])
    expect(projection.supersededNamesByMessageID.size).toBe(0)
  })

  test("noop reload does not supersede prior applied load", () => {
    const projection = SkillProjection.project([
      {
        id: "m1",
        role: "assistant",
        parts: [skill({ id: "p1", name: "brainstorming", applied: true })],
      },
      {
        id: "m2",
        role: "assistant",
        parts: [skill({ id: "p2", name: "brainstorming", applied: false })],
      },
    ])

    expect(projection.activeByName.get("brainstorming")).toBe("p1")
    expect(Array.from(projection.supersededPartIDs)).toStrictEqual([])
    expect(projection.supersededNamesByMessageID.size).toBe(0)
  })

  test("ignores non-assistant skill loads for supersession authority", () => {
    const projection = SkillProjection.project([
      {
        id: "m1",
        role: "assistant",
        parts: [skill({ id: "p1", name: "brainstorming", applied: true })],
      },
      {
        id: "m2",
        role: "user",
        parts: [skill({ id: "p2", name: "brainstorming", applied: true })],
      },
    ])

    expect(projection.activeByName.get("brainstorming")).toBe("p1")
    expect(Array.from(projection.supersededPartIDs)).toStrictEqual([])
    expect(projection.supersededNamesByMessageID.size).toBe(0)
  })

  test("uses input.name when metadata.name is missing", () => {
    const projection = SkillProjection.project([
      {
        id: "m1",
        role: "assistant",
        parts: [skill({ id: "p1", inputName: "brainstorming" })],
      },
      {
        id: "m2",
        role: "assistant",
        parts: [skill({ id: "p2", inputName: "brainstorming" })],
      },
      {
        id: "m3",
        role: "assistant",
        parts: [text("t1")],
      },
    ])

    expect(projection.activeByName.get("brainstorming")).toBe("p2")
    expect(Array.from(projection.supersededPartIDs)).toStrictEqual(["p1"])
    expect(projection.supersededNamesByMessageID.get("m1")).toStrictEqual(["brainstorming"])
  })
})
