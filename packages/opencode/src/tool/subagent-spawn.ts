import z from "zod"
import { Agent } from "@/agent/agent"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionMessage } from "@/session/message-routing"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { Log } from "@/util/log"
import { Tool } from "./tool"

const log = Log.create({ service: "tool.subagent-spawn" })

export const SubagentSpawnTool = Tool.define("subagent_spawn", {
  description: `Spawn subagent sessions with specific tasks.

The 'prompt' parameter becomes the subagent's mission in its system prompt. Your prompt MUST include:
1. Clear task description - what the subagent should accomplish
2. Communication expectations - what to do when done or during execution

Common patterns:
- Fire-and-Wait: Include "When complete, reply using send_agent_message to the Caller Session ID with your findings."
- Streaming: Include "Send updates as you discover them using send_agent_message to the Caller Session ID."
- Fire-and-Forget: No reply instruction needed for background tasks.

The subagent's system prompt will include its Current Session ID and Caller Session ID, but you must explicitly instruct it to reply if you expect a response.`,
  parameters: z.object({
    agents: z
      .array(
        z.object({
          agent: z.string().describe("Agent type (e.g. general_sub, explore)"),
          prompt: z.string().describe("Task prompt for the subagent (becomes part of its system prompt)"),
        }),
      )
      .describe("Agents to spawn with their task prompts"),
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
        agentName: item.agent,
        parentID: ctx.sessionID,
        callerID: ctx.sessionID,
        subagentPrompt: item.prompt,
        title: `Subagent - ${item.agent}`,
      })

      await Session.addChild({
        parentID: ctx.sessionID,
        childID: session.id,
      })

      // Start subagent loop with proper error handling
      const callerID = ctx.sessionID
      SessionPrompt.loop(session.id).catch(async (error) => {
        log.error("subagent crashed", {
          sessionID: session.id,
          agent: item.agent,
          error: error?.message || String(error),
        })

        await SessionMessage.deliver({
          from: session.id,
          to: callerID,
          text: `Subagent error: ${error?.message || "Unknown error"}`,
          messageType: "error",
        })

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
