import { test, expect } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { Skill } from "../../src/skill"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SystemPrompt } from "../../src/session/system"
import { SessionToolOverrides } from "../../src/session/tool-overrides"
import { ToolRegistry } from "../../src/tool/registry"
import { SkillTool } from "../../src/tool/skill"
import { Wildcard } from "../../src/util/wildcard"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.claude/skills for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

function priorSkillPart(input: { id: string; name: string; metadata: Record<string, unknown>; compacted?: boolean }) {
  return {
    id: input.id,
    type: "tool",
    tool: "skill",
    callID: `call-${input.id}`,
    state: {
      status: "completed",
      input: { name: input.name },
      output: "prior",
      title: `Loaded skill: ${input.name}`,
      metadata: input.metadata,
      time: {
        start: 1,
        end: 2,
        ...(input.compacted ? { compacted: 3 } : {}),
      },
    },
  }
}

function assistantHistory(id: string, parts: any[]) {
  return {
    info: { id, role: "assistant" },
    parts,
  }
}

function erroredAssistantHistory(id: string, parts: any[]) {
  return {
    info: {
      id,
      role: "assistant",
      error: new MessageV2.APIError({ message: "boom", isRetryable: true }).toObject(),
    },
    parts,
  }
}

function userHistory(id: string, text = "hello") {
  return {
    info: { id, role: "user" },
    parts: [{ id: `${id}-p`, type: "text", text }],
  }
}

function markerHistory(id: string, kind: "trim" | "think" | "rctx") {
  return {
    info: { id, role: "assistant" },
    parts: [
      {
        id: `${id}-p`,
        type: "text",
        text: kind,
        synthetic: true,
        ignored: true,
        metadata: {
          opencode: {
            marker: {
              kind,
              at: Date.now(),
            },
          },
        },
      },
    ],
  }
}

test("discovers skills from .opencode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "test-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.length).toBe(1)
      const testSkill = skills.find((s) => s.name === "test-skill")
      expect(testSkill).toBeDefined()
      expect(testSkill!.description).toBe("A test skill for verification.")
      expect(testSkill!.location).toContain("skill/test-skill/SKILL.md")
    },
  })
})

test("discovers multiple skills from .opencode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir1 = path.join(dir, ".opencode", "skill", "skill-one")
      const skillDir2 = path.join(dir, ".opencode", "skill", "skill-two")
      await Bun.write(
        path.join(skillDir1, "SKILL.md"),
        `---
name: skill-one
description: First test skill.
---

# Skill One
`,
      )
      await Bun.write(
        path.join(skillDir2, "SKILL.md"),
        `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.length).toBe(2)
      expect(skills.find((s) => s.name === "skill-one")).toBeDefined()
      expect(skills.find((s) => s.name === "skill-two")).toBeDefined()
    },
  })
})

test("skips skills with missing frontmatter", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "no-frontmatter")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `# No Frontmatter

Just some content without YAML frontmatter.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills).toEqual([])
    },
  })
})

test("discovers skills from .claude/skills/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".claude", "skills", "claude-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.length).toBe(1)
      const claudeSkill = skills.find((s) => s.name === "claude-skill")
      expect(claudeSkill).toBeDefined()
      expect(claudeSkill!.location).toContain(".claude/skills/claude-skill/SKILL.md")
    },
  })
})

test("discovers global skills from ~/.claude/skills/ directory", async () => {
  await using tmp = await tmpdir({ git: true })

  const originalHome = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await createGlobalSkill(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(1)
        expect(skills[0].name).toBe("global-test-skill")
        expect(skills[0].description).toBe("A global skill from ~/.claude/skills for testing.")
        expect(skills[0].location).toContain(".claude/skills/global-test-skill/SKILL.md")
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = originalHome
  }
})

test("returns empty array when no skills exist", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills).toEqual([])
    },
  })
})

test("loading a skill can enable tools for the session", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "opencode.json"),
        JSON.stringify(
          {
            tools: {
              heavy: false,
            },
          },
          null,
          2,
        ),
      )

      await Bun.write(
        path.join(dir, ".opencode", "tool", "heavy.ts"),
        `export default {
  description: "A heavy tool used for tests",
  args: {},
  async execute() {
    return "ok"
  },
}
`,
      )

      await Bun.write(
        path.join(dir, ".opencode", "skill", "webdev", "SKILL.md"),
        `---
name: webdev
description: Enables heavy tools
tools:
  - heavy
---

Use the heavy tool.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = "session_test"

      const ids = await ToolRegistry.ids()
      expect(ids).toContain("heavy")

      const before = {
        ...(await ToolRegistry.enabled(agent)),
        ...(await SessionToolOverrides.get(sessionID)),
      }
      expect(Wildcard.all("heavy", before)).toBe(false)

      const skillTool = await SkillTool.init({ agent })
      await skillTool.execute({ name: "webdev" }, {
        sessionID,
        messageID: "message_test",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
      } as any)

      const after = {
        ...(await ToolRegistry.enabled(agent)),
        ...(await SessionToolOverrides.get(sessionID)),
      }
      expect(Wildcard.all("heavy", after)).toBe(true)

      SessionToolOverrides.evict(sessionID)
      const persisted = await SessionToolOverrides.get(sessionID)
      expect(Wildcard.all("heavy", persisted)).toBe(true)

      await SessionToolOverrides.clear(sessionID)
    },
  })
})

test("identical skill reload no-ops within one relevant user turn", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = "session_noop_one_turn"
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-1",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      const prior = priorSkillPart({
        id: "p1",
        name: "brainstorming",
        metadata: first.metadata as any,
      })

      const second = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-2",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [assistantHistory("a1", [prior]), userHistory("u1")],
      } as any)

      expect((second.metadata as any).applied).toBe(false)
      expect((second.metadata as any).status).toBe("noop")
      expect((second.metadata as any).reason).toBe("near_context")
      expect(second.output).toContain("Do not call the skill tool again for this unresolved user turn.")
    },
  })
})

test("same-message duplicate skill call no-ops even without persisted context", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = "session_duplicate_in_turn"
      const messageID = "msg-duplicate"
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID,
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      const second = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID,
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      expect((first.metadata as any).applied).toBe(true)
      expect((first.metadata as any).reason).toBe("applied")
      expect((second.metadata as any).applied).toBe(false)
      expect((second.metadata as any).status).toBe("noop")
      expect((second.metadata as any).reason).toBe("duplicate_in_turn")
      expect(second.output).toContain("Do not call the skill tool again for this unresolved user turn.")
    },
  })
})

test("skill reload applies again after two relevant user turns", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = "session_apply_two_turns"
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-1",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      const prior = priorSkillPart({
        id: "p1",
        name: "brainstorming",
        metadata: first.metadata as any,
      })

      const second = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-2",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [assistantHistory("a1", [prior]), userHistory("u1"), userHistory("u2")],
      } as any)

      expect((second.metadata as any).applied).toBe(true)
      expect((second.metadata as any).status).toBe("applied")
    },
  })
})

test("skill reload ignores user-message skill parts when selecting prior anchor", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = "session_ignore_user_skill_parts"
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-1",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      const prior = priorSkillPart({
        id: "p1",
        name: "brainstorming",
        metadata: first.metadata as any,
      })

      const injected = priorSkillPart({
        id: "p-user",
        name: "brainstorming",
        metadata: first.metadata as any,
      })

      const second = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-2",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [
          assistantHistory("a1", [prior]),
          userHistory("u1"),
          userHistory("u2"),
          {
            info: { id: "u3", role: "user" },
            parts: [{ id: "u3-p", type: "text", text: "third user turn" }, injected],
          },
        ],
      } as any)

      expect((second.metadata as any).applied).toBe(true)
      expect((second.metadata as any).status).toBe("applied")
      expect((second.metadata as any).reason).toBe("applied")
      expect((second.metadata as any).turns).toBe(3)
    },
  })
})

test("skill reload applies again when maintenance marker exists after anchor", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = "session_apply_marker"
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-1",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      const prior = priorSkillPart({
        id: "p1",
        name: "brainstorming",
        metadata: first.metadata as any,
      })

      const second = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-2",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [assistantHistory("a1", [prior]), markerHistory("a2", "trim"), userHistory("u1")],
      } as any)

      expect((second.metadata as any).applied).toBe(true)
      expect((second.metadata as any).status).toBe("applied")
    },
  })
})

test("skill reload applies when content hash changes", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = "session_apply_content_change"
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-1",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      await Bun.write(
        path.join(tmp.path, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step two.
`,
      )

      const prior = priorSkillPart({
        id: "p1",
        name: "brainstorming",
        metadata: first.metadata as any,
      })

      const second = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-2",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [assistantHistory("a1", [prior]), userHistory("u1")],
      } as any)

      expect((second.metadata as any).applied).toBe(true)
      expect((second.metadata as any).status).toBe("applied")
      expect((second.metadata as any).hash).not.toBe((first.metadata as any).hash)
    },
  })
})

test("noop reload still applies tool enablement semantics", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "opencode.json"),
        JSON.stringify(
          {
            tools: {
              heavy: false,
            },
          },
          null,
          2,
        ),
      )

      await Bun.write(
        path.join(dir, ".opencode", "tool", "heavy.ts"),
        `export default {
  description: "A heavy tool used for tests",
  args: {},
  async execute() {
    return "ok"
  },
}
`,
      )

      await Bun.write(
        path.join(dir, ".opencode", "skill", "webdev", "SKILL.md"),
        `---
name: webdev
description: Enables heavy tools
tools:
  - heavy
---

Use the heavy tool.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = "session_noop_enablement"
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "webdev" }, {
        sessionID,
        messageID: "msg-1",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      await SessionToolOverrides.clear(sessionID)

      const before = {
        ...(await ToolRegistry.enabled(agent)),
        ...(await SessionToolOverrides.get(sessionID)),
      }
      expect(Wildcard.all("heavy", before)).toBe(false)

      const prior = priorSkillPart({
        id: "p1",
        name: "webdev",
        metadata: first.metadata as any,
      })

      const second = await skillTool.execute({ name: "webdev" }, {
        sessionID,
        messageID: "msg-2",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [assistantHistory("a1", [prior]), userHistory("u1")],
      } as any)

      const after = {
        ...(await ToolRegistry.enabled(agent)),
        ...(await SessionToolOverrides.get(sessionID)),
      }

      expect((second.metadata as any).applied).toBe(false)
      expect((second.metadata as any).status).toBe("noop")
      expect((second.metadata as any).reason).toBe("near_context")
      expect(Wildcard.all("heavy", after)).toBe(true)
      await SessionToolOverrides.clear(sessionID)
    },
  })
})

test("reload applies when prior load is not in visible context", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = "session_visible_context"
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-1",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      const prior = priorSkillPart({
        id: "p1",
        name: "brainstorming",
        metadata: first.metadata as any,
      })

      const second = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-2",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [assistantHistory("a1", [prior]), userHistory("u1")],
        extra: {
          skillContext: {
            messageIDs: ["u1"],
          },
        },
      } as any)

      expect((second.metadata as any).applied).toBe(true)
      expect((second.metadata as any).status).toBe("applied")
    },
  })
})

test("reload applies when transformed skill context contains marker omitted from raw history", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = Identifier.ascending("session")
      const previousID = Identifier.ascending("message")
      const currentID = Identifier.ascending("message")
      const userID = Identifier.ascending("message")
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: previousID,
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      const prior = priorSkillPart({
        id: Identifier.ascending("part"),
        name: "brainstorming",
        metadata: first.metadata as any,
      })

      const marker = markerHistory("m1", "trim").parts[0]
      const second = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: currentID,
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [assistantHistory(previousID, [prior]), userHistory(userID)],
        extra: {
          skillContext: {
            messageIDs: [previousID, userID],
            messages: [assistantHistory(previousID, [prior, marker]), userHistory(userID)],
          },
        },
      } as any)

      expect((second.metadata as any).applied).toBe(true)
      expect((second.metadata as any).status).toBe("applied")
      expect((second.metadata as any).reason).toBe("applied")
    },
  })
})

test("reload applies when prior load is only in non-abort errored assistant message", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = Identifier.ascending("session")
      const previousID = Identifier.ascending("message")
      const currentID = Identifier.ascending("message")
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: previousID,
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      const prior = priorSkillPart({
        id: Identifier.ascending("part"),
        name: "brainstorming",
        metadata: first.metadata as any,
      })

      const userID = Identifier.ascending("message")
      const second = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: currentID,
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [erroredAssistantHistory(previousID, [prior]), userHistory(userID)],
        extra: {
          skillContext: {
            messageIDs: [previousID, userID],
          },
        },
      } as any)

      expect((second.metadata as any).applied).toBe(true)
      expect((second.metadata as any).status).toBe("applied")
      expect((second.metadata as any).reason).toBe("applied")
    },
  })
})

test("reload applies when same skill content comes from a different base directory", async () => {
  let prior: any

  await using first = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: first.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const skillTool = await SkillTool.init({ agent })
      const loaded = await skillTool.execute({ name: "brainstorming" }, {
        sessionID: "session_hash_dir_1",
        messageID: "msg-1",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      prior = priorSkillPart({
        id: "p1",
        name: "brainstorming",
        metadata: loaded.metadata as any,
      })
    },
  })

  await using second = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: second.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const skillTool = await SkillTool.init({ agent })

      const loaded = await skillTool.execute({ name: "brainstorming" }, {
        sessionID: "session_hash_dir_2",
        messageID: "msg-2",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [assistantHistory("a1", [prior]), userHistory("u1")],
      } as any)

      expect((loaded.metadata as any).applied).toBe(true)
      expect((loaded.metadata as any).status).toBe("applied")
    },
  })
})

test("identical reload no-ops when prior load exists only on current message", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = Identifier.ascending("session")
      const previousID = Identifier.ascending("message")
      const currentID = Identifier.ascending("message")
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: previousID,
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      const prior = priorSkillPart({
        id: Identifier.ascending("part"),
        name: "brainstorming",
        metadata: first.metadata as any,
      })

      await Session.updatePart({
        ...prior,
        sessionID,
        messageID: currentID,
      } as any)

      const second = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: currentID,
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [userHistory("u1")],
      } as any)

      expect((second.metadata as any).applied).toBe(false)
      expect((second.metadata as any).status).toBe("noop")
      expect((second.metadata as any).reason).toBe("near_context")
    },
  })
})

test("reload applies when current-message marker appears after historical anchor", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = Identifier.ascending("session")
      const previousID = Identifier.ascending("message")
      const currentID = Identifier.ascending("message")
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: previousID,
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
      } as any)

      const prior = priorSkillPart({
        id: Identifier.ascending("part"),
        name: "brainstorming",
        metadata: first.metadata as any,
      })

      const markerID = Identifier.ascending("part")
      await Session.updatePart({
        id: markerID,
        sessionID,
        messageID: currentID,
        type: "text",
        text: "trim",
        synthetic: true,
        ignored: true,
        metadata: {
          opencode: {
            marker: {
              kind: "trim",
              at: Date.now(),
            },
          },
        },
      } as any)

      const second = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: currentID,
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [assistantHistory("a1", [prior]), userHistory("u1")],
      } as any)

      expect((second.metadata as any).applied).toBe(true)
      expect((second.metadata as any).status).toBe("applied")
    },
  })
})

test("same-turn dedup no-ops despite marker boundaries when anchor matches", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const sessionID = Identifier.ascending("session")
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-1",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
        extra: {
          turnContext: {
            anchorUserID: "u1",
          },
        },
      } as any)

      const prior = priorSkillPart({
        id: "p1",
        name: "brainstorming",
        metadata: first.metadata as any,
      })

      const second = await skillTool.execute({ name: "brainstorming" }, {
        sessionID,
        messageID: "msg-2",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [assistantHistory("a1", [prior]), markerHistory("m1", "trim"), userHistory("u1")],
        extra: {
          turnContext: {
            anchorUserID: "u1",
          },
        },
      } as any)

      expect((second.metadata as any).applied).toBe(false)
      expect((second.metadata as any).status).toBe("noop")
      expect((second.metadata as any).reason).toBe("same_turn")
      expect(second.output).toContain("Do not call the skill tool again for this unresolved user turn.")
    },
  })
})

test("promotes repeated near-context no-op to same-turn on next attempt", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      const skillTool = await SkillTool.init({ agent })

      const first = await skillTool.execute({ name: "brainstorming" }, {
        sessionID: "session_promote_same_turn",
        messageID: "msg-1",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [],
        extra: {
          turnContext: {
            anchorUserID: "u0",
          },
        },
      } as any)

      const applied = priorSkillPart({
        id: "p-applied",
        name: "brainstorming",
        metadata: first.metadata as any,
      })

      const second = await skillTool.execute({ name: "brainstorming" }, {
        sessionID: "session_promote_same_turn",
        messageID: "msg-2",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [assistantHistory("a1", [applied]), userHistory("u1")],
        extra: {
          turnContext: {
            anchorUserID: "u1",
          },
        },
      } as any)

      expect((second.metadata as any).reason).toBe("near_context")

      const near = priorSkillPart({
        id: "p-near",
        name: "brainstorming",
        metadata: second.metadata as any,
      })

      const third = await skillTool.execute({ name: "brainstorming" }, {
        sessionID: "session_promote_same_turn",
        messageID: "msg-3",
        agent: agent.name,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
        messages: [assistantHistory("a1", [applied]), assistantHistory("a2", [near]), userHistory("u1")],
        extra: {
          turnContext: {
            anchorUserID: "u1",
          },
        },
      } as any)

      expect((third.metadata as any).applied).toBe(false)
      expect((third.metadata as any).status).toBe("noop")
      expect((third.metadata as any).reason).toBe("same_turn")
    },
  })
})
