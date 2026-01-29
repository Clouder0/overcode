import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { SessionToolOverrides } from "../session/tool-overrides"
import { ConfigMarkdown } from "../config/markdown"
import { PermissionNext } from "../permission/next"

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

      const session = (ctx.extra as any)?.session as { parentID?: string; sessionType?: string } | undefined
      const isChildSession = session?.sessionType === "subagent" || !!session?.parentID

      const enabledTools = isChildSession ? [] : requestedTools
      if (enabledTools.length > 0) {
        await SessionToolOverrides.enable(ctx.sessionID, enabledTools)
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
        },
      }
    },
  }
})
