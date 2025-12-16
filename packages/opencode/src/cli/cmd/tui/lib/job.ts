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
