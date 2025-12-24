import z from "zod"
import { Tool } from "./tool"
import { Session } from "@/session"
import { Agent } from "@/agent/agent"
import { SessionMessage } from "@/session/message-routing"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

const log = Log.create({ service: "tool.subagent-spawn" })

export const SubagentSpawnTool = Tool.define("subagent_spawn", {
  description: `Spawn one or more subagent sessions. Each agent receives an initial message and runs in the background.
Use this to delegate work to specialized agents like "explore" or "librarian".
After spawning, use <wait> to collect responses from the spawned agents.`,
  parameters: z.object({
    agents: z
      .array(
        z.object({
          agent: z.string().describe("Agent type: explore, librarian, etc."),
          message: z.string().describe("Initial task/prompt for this agent"),
        }),
      )
      .describe("List of agents to spawn with their initial messages"),
  }),
  async execute(params, ctx) {
    const spawned: Array<{ session_id: string; agent: string }> = []
    const errors: string[] = []

    for (const item of params.agents) {
      const agentInfo = await Agent.get(item.agent).catch(() => undefined)
      if (!agentInfo) {
        errors.push(`Unknown agent: ${item.agent}`)
        continue
      }

      if (agentInfo.mode === "primary") {
        errors.push(`Cannot spawn primary agent as subagent: ${item.agent}`)
        continue
      }

      const session = await Session.createNext({
        directory: Instance.directory,
        sessionType: "subagent",
        agentName: item.agent, // Store the agent type for this subagent
        parentID: ctx.sessionID,
        callerID: ctx.sessionID,
        title: `Subagent - ${item.agent}`,
      })

      await Session.addChild({
        parentID: ctx.sessionID,
        childID: session.id,
      })

      SessionMessage.deliver({
        from: ctx.sessionID,
        to: session.id,
        text: item.message,
      })

      // Start subagent loop with proper error handling
      // On crash, deliver error message to parent so it knows the subagent failed
      const callerID = ctx.sessionID
      SessionPrompt.loop(session.id).catch(async (error) => {
        log.error("subagent crashed", {
          sessionID: session.id,
          agent: item.agent,
          error: error?.message || String(error),
        })

        // Deliver error message to parent - this will also resolve any pending waits
        await SessionMessage.deliver({
          from: session.id,
          to: callerID,
          text: `Subagent error: ${error?.message || "Unknown error"}`,
          messageType: "error",
        })

        // Set session status to idle
        SessionStatus.set(session.id, { type: "idle" })
      })

      spawned.push({
        session_id: session.id,
        agent: item.agent,
      })
    }

    const output: string[] = []
    if (spawned.length > 0) {
      output.push(JSON.stringify({ spawned }, null, 2))
    }
    if (errors.length > 0) {
      output.push("Errors:")
      output.push(...errors)
    }

    return {
      title: `Spawned ${spawned.length} agent(s)`,
      metadata: {
        spawned,
        errors,
      },
      output: output.join("\n"),
    }
  },
})
