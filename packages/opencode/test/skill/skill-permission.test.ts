import { test, expect } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Skill } from "../../src/skill"
import { SkillTool } from "../../src/tool/skill"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

test("skill tool filters available skills based on agent permissions", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      // Create two skills
      await fs.mkdir(path.join(dir, ".opencode", "skill", "allowed-skill"), { recursive: true })
      await Bun.write(
        path.join(dir, ".opencode", "skill", "allowed-skill", "SKILL.md"),
        `---
name: allowed-skill
description: A skill that should be allowed
---
Instructions
        `
      )

      await fs.mkdir(path.join(dir, ".opencode", "skill", "denied-skill"), { recursive: true })
      await Bun.write(
        path.join(dir, ".opencode", "skill", "denied-skill", "SKILL.md"),
        `---
name: denied-skill
description: A skill that should be denied
---
Instructions
        `
      )

      // Configure permissions to deny denied-skill
      await Bun.write(
        path.join(dir, ".opencode", "opencode.json"),
        JSON.stringify({
          permission: {
            skill: {
              "denied-skill": "deny"
            }
          }
        }, null, 2)
      )
    }
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")

      // Check that both skills exist
      const allSkills = await Skill.all()
      expect(allSkills.length).toBe(2)
      expect(allSkills.find(s => s.name === "allowed-skill")).toBeDefined()
      expect(allSkills.find(s => s.name === "denied-skill")).toBeDefined()

      // Initialize skill tool with agent context
      const skillToolInit = await SkillTool.init({ agent })

      // Check that only allowed-skill appears in the description
      expect(skillToolInit.description).toContain("allowed-skill")
      expect(skillToolInit.description).not.toContain("denied-skill")
    }
  })
})
