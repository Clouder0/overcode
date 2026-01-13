import z from "zod"
import { Agent } from "@/agent/agent"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionMessage } from "@/session/message-routing"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { PermissionNext } from "@/permission/next"
import { Log } from "@/util/log"
import { Tool } from "./tool"

const log = Log.create({ service: "tool.subagent-spawn" })

const DESCRIPTION = `Spawn subagent sessions with specific tasks.

The 'prompt' parameter is injected into the subagent's SYSTEM prompt as its mission.
The subagent will NOT automatically report back to the parent, and weak models may write a normal assistant response that never reaches the parent.
If you want results sent back to the parent session, your prompt MUST explicitly require a tool call: send_agent_message(to=PARENT_SESSION_ID, text=<results>).

Your prompt MUST include:
1. Clear task description - what the subagent should accomplish
2. Clear delivery instructions - exactly how to report results (tool name + destination + when)

Common patterns:
- Fire-and-Wait: Include "When complete, reply using send_agent_message to the Parent Session ID with your findings."
- Streaming: Include "Send updates as you discover them using send_agent_message to the Parent Session ID."
- Fire-and-Forget: No reply instruction needed for background tasks.

The subagent's system prompt will include its Current Session ID and Parent Session ID, but you must explicitly instruct it to reply if you expect a response.

Spawn permissions are evaluated from the calling agent's configuration only (session tool overrides do not apply).
If any requested agent is invalid or denied by subagent_spawn_agent, the entire call fails.`

const AGENT_DESC = "Agent type (e.g. general, explore)"
const MAX_AGENT_ENUM = 32

export const SubagentSpawnTool = Tool.define("subagent_spawn", async (init) => {
  const agent = init?.agent
  let agentSchema: z.ZodTypeAny = z.string().describe(AGENT_DESC)
  let description = DESCRIPTION

  // Get all spawnable agents (non-primary mode)
  const spawnable = await Agent.list().then((agents) => agents.filter((a) => a.mode !== "primary"))

  // Determine allowed list based on permissions
  let allowed: typeof spawnable
  if (agent) {
    const isAllowlistMode = PermissionNext.evaluate("subagent_spawn_agent", "*", agent.permission).action === "deny"

    allowed = isAllowlistMode
      ? spawnable.filter(
          (a) => PermissionNext.evaluate("subagent_spawn_agent", a.name, agent.permission).action === "allow",
        )
      : spawnable
  } else {
    allowed = spawnable
  }

  // Build description and schema based on allowed list
  if (allowed.length === 0) {
    description += "\n\nNo subagent types are available to spawn."
  } else {
    // Add <available_subagents> section (like <available_skills>)
    const section = [
      "<available_subagents>",
      ...allowed.flatMap((a) => [
        `  <subagent>`,
        `    <name>${a.name}</name>`,
        `    <description>${a.description ?? "No description"}</description>`,
        `  </subagent>`,
      ]),
      "</available_subagents>",
    ].join(" ")

    description += " " + section

    // Configure schema: use enum if ≤32 agents, otherwise string to avoid bloat
    const names = allowed.map((a) => a.name)
    if (names.length <= MAX_AGENT_ENUM) {
      agentSchema = z.enum(names as [string, ...string[]]).describe(AGENT_DESC)
    } else {
      agentSchema = z.string().describe(`${AGENT_DESC}. See <available_subagents> for available types.`)
    }
  }

  return {
    description,
    parameters: z.object({
      agents: z
        .array(
          z.object({
            agent: agentSchema,
            prompt: z.string().describe("Task prompt for the subagent (becomes part of its system prompt)"),
          }),
        )
        .describe("Agents to spawn with their task prompts"),
    }),
    async execute(params: { agents: Array<{ agent: string; prompt: string }> }, ctx) {
      const spawned: Array<{ session_id: string; agent: string }> = []

      const caller = await Agent.get(ctx.agent).catch(() => undefined)
      if (!caller) {
        throw new Error(`Unknown calling agent: ${ctx.agent}`)
      }

      const errors: string[] = []
      for (const item of params.agents) {
        const target = await Agent.get(item.agent).catch(() => undefined)
        if (!target) {
          errors.push(`Unknown agent: ${item.agent}`)
          continue
        }

        if (target.mode === "primary") {
          errors.push(`Cannot spawn primary agent as subagent: ${item.agent}`)
          continue
        }

        const rule = PermissionNext.evaluate("subagent_spawn_agent", item.agent, caller.permission)
        if (rule.action === "allow") continue

        if (rule.action === "deny") {
          errors.push(`Not allowed to spawn agent: ${item.agent} (matched pattern: ${rule.pattern})`)
          continue
        }

        errors.push(
          `subagent_spawn_agent resolved to "ask" for ${ctx.agent} spawning ${item.agent} (matched pattern: ${rule.pattern}). This tool supports only allow/deny; configure permission.subagent_spawn_agent to "allow" or an allow-list like {"*":"deny","explore":"allow"}.`,
        )
      }

      if (errors.length > 0) {
        throw new Error(["Subagent spawn preflight failed:", ...errors.map((e) => `- ${e}`)].join("\n"))
      }

      for (const item of params.agents) {
        const session = await Session.createNext({
          directory: Instance.directory,
          sessionType: "subagent",
          agentName: item.agent,
          parentID: ctx.sessionID,
          subagentPrompt: item.prompt,
          title: `Subagent - ${item.agent}`,
        })

        await Session.addChild({
          parentID: ctx.sessionID,
          childID: session.id,
        })

        const parentID = ctx.sessionID
        SessionPrompt.loop(session.id).catch(async (error) => {
          log.error("subagent crashed", {
            sessionID: session.id,
            agent: item.agent,
            error: error?.message || String(error),
          })

          await SessionMessage.deliver({
            from: session.id,
            to: parentID,
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

      return {
        title: `Spawned ${spawned.length} agent(s)`,
        metadata: {
          spawned,
          errors: [] as string[],
        },
        output: JSON.stringify({ spawned }, null, 2),
      }
    },
  }
})
