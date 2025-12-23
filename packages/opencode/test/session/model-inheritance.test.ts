import fs from "fs/promises"
import path from "path"
import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"

Log.init({ print: false })

test("subagent child session inherits parent model when unset", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const agentDir = path.join(dir, ".opencode", "agent")
      await fs.mkdir(agentDir, { recursive: true })
      await Bun.write(
        path.join(agentDir, "inherit_model.md"),
        `---
mode: subagent
description: Test subagent without explicit model
---
You are a test subagent.`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(parent.id)
        },
      }

      const agents = await Agent.list()
      const primary = agents.find((a) => a.mode !== "subagent" && !a.hidden)
      if (!primary) {
        throw new Error("no primary agent available")
      }

      const parentModel = { providerID: "openai", modelID: "gpt-5" }

      await SessionPrompt.prompt({
        sessionID: parent.id,
        agent: primary.name,
        model: parentModel,
        parts: [{ type: "text", text: "parent" }],
        noReply: true,
      })

      const child = await Session.create({ parentID: parent.id })
      const msg = await SessionPrompt.prompt({
        sessionID: child.id,
        agent: "inherit_model",
        parts: [{ type: "text", text: "child" }],
        noReply: true,
      })

      expect(msg.info.role).toBe("user")
      if (msg.info.role !== "user") {
        throw new Error("expected user message")
      }

      expect(msg.info.model.providerID).toBe(parentModel.providerID)
      expect(msg.info.model.modelID).toBe(parentModel.modelID)
    },
  })
})

test("subagent child session prefers agent model over parent", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const agentDir = path.join(dir, ".opencode", "agent")
      await fs.mkdir(agentDir, { recursive: true })
      await Bun.write(
        path.join(agentDir, "explicit_model.md"),
        `---
mode: subagent
description: Test subagent with explicit model
model: test/explicit
---
You are a test subagent.`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(parent.id)
        },
      }

      const agents = await Agent.list()
      const primary = agents.find((a) => a.mode !== "subagent" && !a.hidden)
      if (!primary) {
        throw new Error("no primary agent available")
      }

      await SessionPrompt.prompt({
        sessionID: parent.id,
        agent: primary.name,
        model: { providerID: "openai", modelID: "gpt-5" },
        parts: [{ type: "text", text: "parent" }],
        noReply: true,
      })

      const child = await Session.create({ parentID: parent.id })
      const msg = await SessionPrompt.prompt({
        sessionID: child.id,
        agent: "explicit_model",
        parts: [{ type: "text", text: "child" }],
        noReply: true,
      })

      expect(msg.info.role).toBe("user")
      if (msg.info.role !== "user") {
        throw new Error("expected user message")
      }

      expect(msg.info.model.providerID).toBe("test")
      expect(msg.info.model.modelID).toBe("explicit")
    },
  })
})
