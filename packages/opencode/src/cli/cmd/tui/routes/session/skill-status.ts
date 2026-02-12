export type SkillStatus = "failed" | "loading" | "hidden" | "noop" | "superseded" | "active"

export function resolveSkillStatus(input: {
  status: string
  applied: unknown
  superseded: boolean
  reason?: unknown
}): SkillStatus {
  if (input.status === "error") return "failed"
  if (input.status !== "completed") return "loading"
  if (input.applied === false && typeof input.reason === "string") return "hidden"
  if (input.applied === false) return "noop"
  if (input.superseded) return "superseded"
  return "active"
}
