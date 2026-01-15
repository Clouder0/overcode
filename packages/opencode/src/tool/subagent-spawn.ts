import z from "zod"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { LLMConcurrencyMachine } from "@/session/llm-concurrency-machine"
import { MessageV2 } from "@/session/message-v2"
import { SessionMessage } from "@/session/message-routing"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { PermissionNext } from "@/permission/next"
import { Log } from "@/util/log"
import { Tool } from "./tool"

const log = Log.create({ service: "tool.subagent-spawn" })

const DESCRIPTION = `Spawn subagent sessions to run tasks in parallel.

The 'prompt' parameter becomes the subagent's task. The subagent receives your session ID as their Parent Session ID.

If you want the subagent to communicate with any agent session, include the target session ID(s) and explicitly ask it to use send_agent_message.
Example: When done, call send_agent_message(to="ses_...", text="<findings>")`

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

      const req = [] as Array<{ agent: string; prompt: string; info: Agent.Info }>

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
        if (rule.action === "deny") {
          errors.push(`Not allowed to spawn agent: ${item.agent} (matched pattern: ${rule.pattern})`)
          continue
        }

        if (rule.action !== "allow") {
          errors.push(
            `subagent_spawn_agent resolved to "ask" for ${ctx.agent} spawning ${item.agent} (matched pattern: ${rule.pattern}). This tool supports only allow/deny; configure permission.subagent_spawn_agent to "allow" or an allow-list like {"*":"deny","explore":"allow"}.`,
          )
          continue
        }

        req.push({ agent: item.agent, prompt: item.prompt, info: target })
      }

      if (errors.length > 0) {
        throw new Error(["Subagent spawn preflight failed:", ...errors.map((e) => `- ${e}`)].join("\n"))
      }

      const limits = await Config.get().then((cfg) => LLMConcurrencyMachine.limits(cfg))
      if (limits) {
        async function lastModel(sessionID: string) {
          const visited = new Set<string>()
          let current = sessionID

          while (!visited.has(current)) {
            visited.add(current)

            for await (const item of MessageV2.stream(current)) {
              if (item.info.role === "user" && item.info.model) return item.info.model
            }

            const session = await Session.get(current).catch(() => undefined)
            if (!session?.parentID) break
            current = session.parentID
          }

          return Provider.defaultModel()
        }

        const inherited = await lastModel(ctx.sessionID)

        const keys = await Promise.all(
          req.map(async (item) => {
            const ref = item.info.model ?? inherited
            const model = await Provider.getModel(ref.providerID, ref.modelID).catch(() => undefined)
            const modelName = model?.api.id ?? ref.modelID
            return LLMConcurrencyMachine.bucketKey({ providerID: ref.providerID, modelName })
          }),
        )

        const request = LLMConcurrencyMachine.request(limits, keys)
        const current = await LLMConcurrencyMachine.snapshot(limits)
        const blocked = LLMConcurrencyMachine.blocked(limits, current, request)

        if (blocked.length > 0) {
          const map = LLMConcurrencyMachine.limitMap(limits)

          const lines: string[] = []
          lines.push(
            "Global (machine-wide) LLM concurrency limit reached. No subagents were spawned.",
            "",
            "Blocked patterns:",
          )

          for (const pattern of blocked) {
            const lim = map[pattern]
            const cur = current.counts[pattern] ?? (pattern === "*" ? current.total : 0)
            const add = request.counts[pattern] ?? (pattern === "*" ? request.total : 0)
            lines.push(`- ${pattern}: ${cur}/${lim} (requested +${add})`)
          }

          lines.push(
            "",
            "For the assistant:",
            "- Continue without spawning subagents, or retry with fewer subagents after current work finishes.",
            "- If parallelism is required, ask the human to adjust global concurrency limits.",
            "",
            "For the human:",
            "- Set experimental.llmConcurrency.global in your global opencode config (e.g. ~/.config/opencode/opencode.json).",
            "- You can raise limits there if your provider rate limits allow it, or close other opencode clients to reduce load.",
          )

          const output = lines.join("\n")

          return {
            title: "subagent_spawn blocked: global concurrency limit reached",
            metadata: {
              ok: false,
              status: "blocked",
              reason: "global_llm_concurrency_limit",
              blocked,
              limits: map,
              staleMs: limits.staleMs,
              current,
              requested: request,
              spawned,
              errors: ["Blocked by global LLM concurrency limit"],
            } as any,
            output,
          }
        }
      }

      for (const item of req) {
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

      const lines = [`Spawned ${spawned.length} agent(s):`, ...spawned.map((s) => `- ${s.session_id} (${s.agent})`)]
      return {
        title: `Spawned ${spawned.length} agent(s)`,
        metadata: {
          ok: true,
          status: "spawned",
          spawned,
          errors: [] as string[],
        } as any,
        output: lines.join("\n"),
      }
    },
  }
})
