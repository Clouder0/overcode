export type SkillStatus = "failed" | "loading" | "noop" | "superseded" | "active"

export function resolveSkillStatus(input: { status: string; applied: unknown; superseded: boolean }): SkillStatus {
  if (input.status === "error") return "failed"
  if (input.status !== "completed") return "loading"
  if (input.applied === false) return "noop"
  if (input.superseded) return "superseded"
  return "active"
}
