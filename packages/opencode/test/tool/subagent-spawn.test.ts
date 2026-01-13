import { describe, expect, test } from "bun:test"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Session } from "../../src/session"
import { LLMConcurrencyMachine } from "../../src/session/llm-concurrency-machine"
import { SubagentSpawnTool } from "../../src/tool/subagent-spawn"

const ctxBase = {
  messageID: "msg_test",
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.subagent_spawn fine-grained permissions", () => {
  test("blocks spawn when global concurrency limit would be exceeded", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          build: {
            permission: {
              subagent_spawn_agent: {
                "*": "allow",
              },
            },
          },
        },
        experimental: {
          llmConcurrency: {
            global: {
              limits: {
                "*": 1,
              },
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})

        const lim = LLMConcurrencyMachine.limits(await Config.get())
        const lease = await LLMConcurrencyMachine.enter({
          limits: lim,
          providerID: "openai",
          modelName: "gpt-5",
          sessionID: parent.id,
        })

        const tool = await SubagentSpawnTool.init()
        const result = await tool.execute(
          {
            agents: [{ agent: "explore", prompt: "blocked" }],
          },
          {
            ...ctxBase,
            sessionID: parent.id,
          },
        )

        expect((result.metadata as any).ok).toBe(false)
        expect((result.metadata as any).status).toBe("blocked")

        const next = await Session.get(parent.id)
        expect(next.childrenIDs).toHaveLength(0)

        await lease?.release()
        await Session.remove(parent.id)
      },
    })
  })

  test("denies disallowed target and spawns nothing", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          build: {
            permission: {
              subagent_spawn_agent: {
                "*": "deny",
                explore: "allow",
              },
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})

        const tool = await SubagentSpawnTool.init()
        const promise = tool.execute(
          {
            agents: [{ agent: "general", prompt: "do a thing" }],
          },
          {
            ...ctxBase,
            sessionID: parent.id,
          },
        )

        await expect(promise).rejects.toThrow(/Not allowed to spawn agent/i)

        const next = await Session.get(parent.id)
        expect(next.childrenIDs).toHaveLength(0)

        await Session.remove(parent.id)
      },
    })
  })

  test("fails whole call when any target is denied", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          build: {
            permission: {
              subagent_spawn_agent: {
                "*": "deny",
                explore: "allow",
              },
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})

        const tool = await SubagentSpawnTool.init()
        const promise = tool.execute(
          {
            agents: [
              { agent: "explore", prompt: "allowed" },
              { agent: "general", prompt: "denied" },
            ],
          },
          {
            ...ctxBase,
            sessionID: parent.id,
          },
        )

        await expect(promise).rejects.toThrow(/Subagent spawn preflight failed/i)

        const next = await Session.get(parent.id)
        expect(next.childrenIDs).toHaveLength(0)

        await Session.remove(parent.id)
      },
    })
  })

  test("spawns all requested agents when all are allowed", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          build: {
            permission: {
              subagent_spawn_agent: {
                "*": "deny",
                explore: "allow",
                general: "allow",
              },
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})

        const tool = await SubagentSpawnTool.init()
        const result = await tool.execute(
          {
            agents: [
              { agent: "explore", prompt: "allowed" },
              { agent: "general", prompt: "allowed" },
            ],
          },
          {
            ...ctxBase,
            sessionID: parent.id,
          },
        )

        expect(result.metadata.spawned).toHaveLength(2)

        const next = await Session.get(parent.id)
        expect(next.childrenIDs).toHaveLength(2)

        for (const item of result.metadata.spawned) {
          await Session.remove(item.session_id)
        }
        await Session.remove(parent.id)
      },
    })
  })

  test("allow-list mode restricts schema to allowed agents", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          build: {
            permission: {
              subagent_spawn_agent: {
                "*": "deny",
                explore: "allow",
              },
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        expect(build).toBeDefined()

        const tool = await SubagentSpawnTool.init({ agent: build })
        expect(tool.parameters.safeParse({ agents: [{ agent: "explore", prompt: "ok" }] }).success).toBe(true)
        expect(tool.parameters.safeParse({ agents: [{ agent: "general", prompt: "no" }] }).success).toBe(false)
      },
    })
  })

  test("rejects ask rules for subagent_spawn_agent", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          build: {
            permission: {
              subagent_spawn_agent: "ask",
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})

        const tool = await SubagentSpawnTool.init()
        const promise = tool.execute(
          {
            agents: [{ agent: "explore", prompt: "no ask" }],
          },
          {
            ...ctxBase,
            sessionID: parent.id,
          },
        )

        await expect(promise).rejects.toThrow(/supports only allow\/deny/i)

        await Session.remove(parent.id)
      },
    })
  })

  test("rejects global ask rules for spawn targets", async () => {
    await using tmp = await tmpdir({
      config: {
        permission: {
          "*": "ask",
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})

        const tool = await SubagentSpawnTool.init()
        const promise = tool.execute(
          {
            agents: [{ agent: "explore", prompt: "no ask" }],
          },
          {
            ...ctxBase,
            sessionID: parent.id,
          },
        )

        await expect(promise).rejects.toThrow(/supports only allow\/deny/i)

        const next = await Session.get(parent.id)
        expect(next.childrenIDs).toHaveLength(0)

        await Session.remove(parent.id)
      },
    })
  })

  test("allow-list mode uses string schema and lists available_subagents when too many targets", async () => {
    const agent: NonNullable<Config.Info["agent"]> = {
      build: {
        permission: {
          subagent_spawn_agent: {
            "*": "deny",
            "w*": "allow",
          },
        },
      },
    }

    for (let i = 0; i < 40; i++) {
      agent[`w${i}`] = {}
    }

    await using tmp = await tmpdir({
      config: {
        agent,
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        expect(build).toBeDefined()

        const tool = await SubagentSpawnTool.init({ agent: build })
        // New behavior: lists all available subagents in XML format
        expect(tool.description).toContain("<available_subagents>")
        expect(tool.description).toContain("<name>w0</name>")

        // With >32 agents, should use string schema (not enum)
        expect(tool.parameters.safeParse({ agents: [{ agent: "w0", prompt: "ok" }] }).success).toBe(true)
      },
    })
  })
})
