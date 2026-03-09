import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { SessionToolOverrides } from "../session/tool-overrides"
import { ConfigMarkdown } from "../config/markdown"
import { PermissionNext } from "../permission/next"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { inspectSkillReuse } from "../util/skill-dedupe"
import { Instance } from "../project/instance"

const MESSAGE_ID_SCHEMA = Identifier.schema("message")
const CACHE_LIMIT = 4096
const inflight = Instance.state(() => ({
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
      const key = `${ctx.sessionID}:${ctx.messageID}:${skill.name}:${hash}`

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
      const dedupe = inflight().keys.has(key)
        ? {
            turns: 0,
            reuse: { kind: "duplicate_in_turn", turns: 0 } as const,
          }
        : inspectSkillReuse({
            name: skill.name,
            hash,
            anchorUserID,
            visible,
            currentMessageID: ctx.messageID,
            current,
          })
      const turns = dedupe.turns
      const reuse = dedupe.reuse

      const session = (ctx.extra as any)?.session as { parentID?: string; sessionType?: string } | undefined
      const isChildSession = session?.sessionType === "subagent" || !!session?.parentID

      const enabledTools = isChildSession ? [] : requestedTools
      if (enabledTools.length > 0) {
        await SessionToolOverrides.enable(ctx.sessionID, enabledTools)
      }

      const currentNoReload =
        "Treat the skill requirement as satisfied for this assistant message. Do not call the skill tool again unless you are in a new assistant message. Continue with the task directly."
      const visibleNoReload =
        "Treat the skill requirement as satisfied only while the previously applied skill content remains visible in recent context. If the visible context changes and that applied skill content is no longer present, call the skill tool again. Continue with the task directly."

      if (reuse?.kind === "duplicate_in_turn") {
        return {
          title: `Skill up-to-date: ${skill.name}`,
          output: [`Skill "${skill.name}" is already active in this assistant message.`, currentNoReload].join("\n"),
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

      if (reuse?.kind === "same_turn") {
        return {
          title: `Skill up-to-date: ${skill.name}`,
          output: [
            `Skill "${skill.name}" is already loaded for this unresolved user turn and still visible in recent context.`,
            visibleNoReload,
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

      if (reuse?.kind === "near_context") {
        return {
          title: `Skill already loaded: ${skill.name}`,
          output: [
            `Skill "${skill.name}" is already loaded and the applied content is still visible in recent context.`,
            visibleNoReload,
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

      const s = inflight()
      s.keys.add(key)
      if (s.keys.size > CACHE_LIMIT) {
        const first = s.keys.values().next().value
        if (typeof first === "string") s.keys.delete(first)
      }

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
