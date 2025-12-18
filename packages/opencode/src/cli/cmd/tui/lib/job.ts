import type { Job } from "@/job"

export type JobStatus = Job.Status

export interface JobInfo {
  id: string
  parentSessionID: string
  type: string
  title: string
  status: JobStatus
  error?: string
  metadata?: unknown
  time: {
    created: number
    updated: number
    started?: number
    completed?: number
  }
}

export interface JobNotification {
  id: string
  text: string
  time: number
}

export function statusIcon(status: JobStatus): string {
  return (
    {
      pending: "○",
      running: "●",
      completed: "✓",
      error: "✗",
      canceled: "⊘",
    }[status] ?? "?"
  )
}

export function jobStatusColor<T>(
  status: JobStatus,
  theme: { text: T; textMuted: T; accent: T; success: T; error: T; warning: T },
): T {
  return (
    {
      pending: theme.textMuted,
      running: theme.accent,
      completed: theme.success,
      error: theme.error,
      canceled: theme.warning,
    }[status] ?? theme.text
  )
}

export function getWorkerSessionID(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return
  const candidate = (meta as { workerSessionID?: unknown }).workerSessionID
  if (typeof candidate === "string" && candidate.length > 0) return candidate
}

export function getWorkerAgent(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return
  const candidate = (meta as { agent?: unknown }).agent
  if (typeof candidate === "string" && candidate.length > 0) return candidate
}

export function getJobTitleForSession(jobs: JobInfo[], sessionID: string): string | undefined {
  const match = jobs
    .filter((job) => getWorkerSessionID(job.metadata) === sessionID)
    .toSorted((a, b) => b.time.updated - a.time.updated)
    .at(0)

  if (!match) return

  const agent = getWorkerAgent(match.metadata)
  if (agent) return `[${agent}] ${match.title}`
  return match.title
}
