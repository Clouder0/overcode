import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { SessionToolOverrides } from "../session/tool-overrides"
import { ConfigMarkdown } from "../config/markdown"
import { PermissionNext } from "../permission/next"
import { MessageV2 } from "../session/message-v2"
import { isUserRelevant } from "../session/relevance"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"

const MESSAGE_ID_SCHEMA = Identifier.schema("message")
const CACHE_LIMIT = 4096
const cache = Instance.state(() => ({
  keys: new Set<string>(),
}))

export const SkillTool = Tool.define("skill", async (ctx) => {
  const skills = await Skill.all()

  // Filter skills by agent permissions if agent provided
  const agent = ctx?.agent
  const accessibleSkills = agent
    ? skills.filter((skill) => {
        const rule = PermissionNext.evaluate("skill", skill.name, agent.permission)
        return rule.action !== "deny"
      })
    : skills

  const description =
    accessibleSkills.length === 0
      ? "Load a skill to get detailed instructions for a specific task. No skills are currently available."
      : [
          "Load a skill to get detailed instructions for a specific task.",
          "Skills provide specialized knowledge and step-by-step guidance.",
          "Use this when a task matches an available skill's description.",
          "Only the skills listed here are available:",
          "<available_skills>",
          ...accessibleSkills.flatMap((skill) => [
            `  <skill>`,
            `    <name>${skill.name}</name>`,
            `    <description>${skill.description}</description>`,
            `  </skill>`,
          ]),
          "</available_skills>",
        ].join(" ")

  const examples = accessibleSkills
    .map((skill) => `'${skill.name}'`)
    .slice(0, 3)
    .join(", ")
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ""

  const parameters = z.object({
    name: z.string().describe(`The skill identifier from available_skills${hint}`),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const skill = await Skill.get(params.name)

      if (!skill) {
        const available = await Skill.all().then((x) => x.map((s) => s.name).join(", "))
        throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
      }

      await ctx.ask({
        permission: "skill",
        patterns: [params.name],
        always: [params.name],
        metadata: {},
      })

      const parsed = await ConfigMarkdown.parse(skill.location)
      const dir = path.dirname(skill.location)

      const toolsField = (parsed.data as { tools?: unknown }).tools
      const parsedTools = z.union([z.string(), z.array(z.string())]).safeParse(toolsField)
      const requestedTools = parsedTools.success
        ? Array.isArray(parsedTools.data)
          ? parsedTools.data
          : [parsedTools.data]
        : []

      const hash = await crypto.subtle
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify({
              name: skill.name,
              dir,
              content: parsed.content.trim(),
              tools: requestedTools,
            }),
          ),
        )
        .then((value) => Buffer.from(value).toString("hex"))

      const nameForPart = (part: Tool.Context["messages"][number]["parts"][number]) => {
        if (part.type !== "tool") return
        if (part.tool !== "skill") return
        if (part.state.status !== "completed") return

        const meta = part.state.metadata
        if (meta && typeof meta === "object") {
          const value = (meta as { name?: unknown }).name
          if (typeof value === "string" && value.trim().length > 0) return value.trim()
        }

        const input = part.state.input
        const value = input && typeof input === "object" ? (input as { name?: unknown }).name : undefined
        if (typeof value !== "string") return
        if (value.trim().length === 0) return
        return value.trim()
      }

      const markerForPart = (part: Tool.Context["messages"][number]["parts"][number]) => {
        const hasMetadata = "metadata" in part
        if (!hasMetadata) return
        const metadata = part.metadata
        if (!metadata || typeof metadata !== "object") return
        const opencode = (metadata as { opencode?: unknown }).opencode
        if (!opencode || typeof opencode !== "object") return
        const marker = (opencode as { marker?: unknown }).marker
        if (!marker || typeof marker !== "object") return
        const kind = (marker as { kind?: unknown }).kind
        if (kind === "trim" || kind === "think" || kind === "rctx") return kind
      }

      const skillContext = (ctx.extra as { skillContext?: unknown } | undefined)?.skillContext
      const turnContext = (ctx.extra as { turnContext?: unknown } | undefined)?.turnContext
      const skillData =
        skillContext && typeof skillContext === "object"
          ? (skillContext as {
              messageIDs?: unknown
              visibleMessageIDs?: unknown
              messages?: MessageV2.WithParts[]
            })
          : undefined
      const turnData =
        turnContext && typeof turnContext === "object"
          ? (turnContext as {
              anchorUserID?: unknown
            })
          : undefined
      const anchorUserID =
        typeof turnData?.anchorUserID === "string" && turnData.anchorUserID.length > 0
          ? turnData.anchorUserID
          : undefined
      const history = Array.isArray(skillData?.messages)
        ? skillData.messages
        : ((ctx.messages ?? []) as MessageV2.WithParts[])
      const ids = (() => {
        if (!skillData) return
        const value = Array.isArray(skillData.messageIDs)
          ? skillData.messageIDs
          : Array.isArray(skillData.visibleMessageIDs)
            ? skillData.visibleMessageIDs
            : undefined
        if (!value) return
        return value.filter((item): item is string => typeof item === "string")
      })()

      const current = MESSAGE_ID_SCHEMA.safeParse(ctx.messageID).success ? await MessageV2.parts(ctx.messageID) : []

      const visible = (() => {
        const list = (() => {
          if (!ids) return history
          const set = new Set(ids)
          set.add(ctx.messageID)
          return history.filter((message) => set.has(message.info.id))
        })()

        return list.filter((message) => MessageV2.modelVisible(message))
      })()

      const merged = (() => {
        const base = visible.map((message) => ({
          id: message.info.id,
          role: message.info.role,
          parts: message.parts,
          user: isUserRelevant(message),
        }))
        const found = base.findIndex((message) => message.id === ctx.messageID)

        if (found === -1) {
          return [
            ...base,
            {
              id: ctx.messageID,
              role: "assistant",
              parts: current,
              user: false,
            },
          ]
        }

        if (current.length === 0) return base
        return base.map((message, index) => {
          if (index !== found) return message
          return {
            ...message,
            parts: current,
          }
        })
      })()

      const indexed = merged.flatMap((message, messageIndex) =>
        message.parts.map((part, partIndex) => ({
          message,
          messageIndex,
          part,
          partIndex,
        })),
      )

      const prior = indexed.findLast((item) => {
        if (item.message.role !== "assistant") return false
        if (item.part.type !== "tool") return false
        if (item.part.tool !== "skill") return false
        if (item.part.state.status !== "completed") return false
        if (nameForPart(item.part) !== skill.name) return false
        return true
      })

      const priorState =
        prior && prior.part.type === "tool" && prior.part.tool === "skill" && prior.part.state.status === "completed"
          ? prior.part.state
          : undefined

      const priorMeta = (() => {
        if (!priorState) return
        const meta = priorState.metadata
        if (!meta || typeof meta !== "object") return
        return meta as Record<string, unknown>
      })()
      const priorHash = typeof priorMeta?.hash === "string" ? priorMeta.hash : undefined
      const priorAnchor = typeof priorMeta?.anchorUserID === "string" ? priorMeta.anchorUserID : undefined
      const sameHash = priorHash === hash
      const compacted = !!priorState?.time.compacted
      const sameTurn = !!prior && !!priorState && !!anchorUserID && sameHash && priorAnchor === anchorUserID

      const sincePrior = prior
        ? [
            ...prior.message.parts.slice(prior.partIndex + 1),
            ...merged.slice(prior.messageIndex + 1).flatMap((message) => message.parts),
          ]
        : []

      const marker = sincePrior.find(markerForPart)
      const turns = prior ? merged.slice(prior.messageIndex + 1).filter((message) => message.user).length : 0
      const near = !!prior && !!priorState && !compacted && sameHash && turns <= 1 && !marker

      const session = (ctx.extra as any)?.session as { parentID?: string; sessionType?: string } | undefined
      const isChildSession = session?.sessionType === "subagent" || !!session?.parentID

      const enabledTools = isChildSession ? [] : requestedTools
      if (enabledTools.length > 0) {
        await SessionToolOverrides.enable(ctx.sessionID, enabledTools)
      }

      const key = `${ctx.sessionID}:${ctx.messageID}:${skill.name}:${hash}`
      const duplicate = (() => {
        const s = cache()
        if (s.keys.has(key)) return true
        s.keys.add(key)
        if (s.keys.size <= CACHE_LIMIT) return false
        const first = s.keys.values().next().value
        if (typeof first === "string") s.keys.delete(first)
        return false
      })()

      if (duplicate) {
        return {
          title: `Skill up-to-date: ${skill.name}`,
          output: [
            `Skill "${skill.name}" is already active in this assistant message.`,
            "Do not call the skill tool again in this response; continue with the task directly.",
          ].join("\n"),
          metadata: {
            name: skill.name,
            dir,
            enabledTools,
            applied: false,
            status: "noop",
            hash,
            turns: 0,
            maxTurns: 1,
            reason: "duplicate_in_turn",
            ...(anchorUserID ? { anchorUserID } : {}),
          },
        }
      }

      if (sameTurn) {
        return {
          title: `Skill up-to-date: ${skill.name}`,
          output: [
            `Skill "${skill.name}" is already loaded for this unresolved user turn.`,
            "Skipped duplicate reload.",
          ].join("\n"),
          metadata: {
            name: skill.name,
            dir,
            enabledTools,
            applied: false,
            status: "noop",
            hash,
            turns,
            maxTurns: 1,
            reason: "same_turn",
            ...(anchorUserID ? { anchorUserID } : {}),
          },
        }
      }

      if (near) {
        return {
          title: `Skill already loaded: ${skill.name}`,
          output: [
            `Skill "${skill.name}" is already loaded and context is still near.`,
            "Skipped duplicate reload.",
          ].join("\n"),
          metadata: {
            name: skill.name,
            dir,
            enabledTools,
            applied: false,
            status: "noop",
            hash,
            turns,
            maxTurns: 1,
            reason: "near_context",
            ...(anchorUserID ? { anchorUserID } : {}),
          },
        }
      }

      const output = [
        `## Skill: ${skill.name}`,
        "",
        `**Base directory**: ${dir}`,
        ...(enabledTools.length > 0 ? ["", `**Enabled tools**: ${enabledTools.join(", ")}`] : []),
        "",
        parsed.content.trim(),
      ].join("\n")

      return {
        title: `Loaded skill: ${skill.name}`,
        output,
        metadata: {
          name: skill.name,
          dir,
          enabledTools,
          applied: true,
          status: "applied",
          hash,
          turns,
          maxTurns: 1,
          reason: "applied",
          ...(anchorUserID ? { anchorUserID } : {}),
        },
      }
    },
  }
})
