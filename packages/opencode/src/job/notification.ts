import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { JobContext } from "./context"
import type { JobStream } from "./stream"

export namespace JobNotification {
  // State: Map<sessionID, notification[]>
  const state = Instance.state(() => ({
    notifications: new Map<string, Notification[]>(),
    // Used to prevent duplicate surfacing when the caller already received
    // a notification via job_wait.
    acked: new Map<string, Set<string>>(),
    initialized: false,
  }))

  function token(jobID: string, frameID: string) {
    return `${jobID}:${frameID}`
  }

  interface Notification {
    jobID: string
    jobType: string
    jobTitle: string
    frame: JobStream.Frame
  }

  // Initialize subscription (called once per instance)
  export function init(): void {
    const s = state()
    if (s.initialized) return
    s.initialized = true

    Bus.subscribe(JobContext.Event.Notify, async (event) => {
      const sessionID = event.properties.sessionID
      const jobID = event.properties.jobID
      const frame = event.properties.frame

      const key = token(jobID, frame.id)

      const acked = s.acked.get(sessionID)
      if (acked?.has(key)) {
        acked.delete(key)
        if (acked.size === 0) {
          s.acked.delete(sessionID)
        }
        return
      }

      const item: Notification = {
        jobID,
        jobType: "",
        jobTitle: "",
        frame,
      }

      const notifications = s.notifications.get(sessionID) ?? []
      notifications.push(item)
      s.notifications.set(sessionID, notifications)

      // Lazy import to avoid circular dependency
      const { Job } = await import(".")

      // Get job info for type and title
      const { jobs } = await Job.get({ jobIDs: [jobID] })
      const job = jobs[0]
      if (!job?.found) {
        const queue = s.notifications.get(sessionID)
        if (!queue) return

        const next = queue.filter((n) => token(n.jobID, n.frame.id) !== key)
        if (next.length === 0) {
          s.notifications.delete(sessionID)
          return
        }
        s.notifications.set(sessionID, next)
        return
      }

      item.jobType = job.type ?? ""
      item.jobTitle = job.title ?? ""

      // Auto-trigger prompt loop if session is idle
      const { SessionStatus } = await import("@/session/status")
      const status = SessionStatus.get(sessionID)
      if (status.type !== "idle") return

      const pending = s.notifications.get(sessionID)
      if (!pending || pending.length === 0) return

      const { SessionPrompt } = await import("@/session/prompt")
      SessionPrompt.loop(sessionID).catch(() => {
        // Ignore errors - notification will be processed on next user interaction
      })
    })
  }

  // Check if there are pending notifications for a session
  export function hasPending(sessionID: string): boolean {
    const notifications = state().notifications.get(sessionID)
    return notifications !== undefined && notifications.length > 0
  }

  export function ack(sessionID: string, input: { jobID: string; frameID: string }): void {
    const key = token(input.jobID, input.frameID)
    const s = state()

    const acked = s.acked.get(sessionID) ?? new Set<string>()
    acked.add(key)
    s.acked.set(sessionID, acked)

    // Ensure we don't leak ack tokens in the case where the notification
    // was already queued (and removed by this ack).
    const timer = setTimeout(() => {
      const s = state()
      const acked = s.acked.get(sessionID)
      if (!acked) return

      acked.delete(key)
      if (acked.size === 0) {
        s.acked.delete(sessionID)
      }
    }, 0)
    timer.unref?.()

    const queue = s.notifications.get(sessionID)
    if (!queue) return

    const next = queue.filter((n) => token(n.jobID, n.frame.id) !== key)
    if (next.length === 0) {
      s.notifications.delete(sessionID)
      return
    }
    s.notifications.set(sessionID, next)
  }

  // Drain all notifications for a session (returns and clears)
  export function drain(sessionID: string): Notification[] {
    const s = state()
    const pending = s.notifications.get(sessionID) ?? []
    s.notifications.delete(sessionID)
    s.acked.delete(sessionID)
    return pending
  }

  // Format notifications for injection into agent context
  export function format(notifications: Notification[]): string {
    if (notifications.length === 0) return ""

    return notifications
      .map(
        (n) => `[Job Notification]
Type: ${n.jobType}
Title: ${n.jobTitle}
ID: ${n.jobID}

${JSON.stringify(n.frame.data, null, 2)}`,
      )
      .join("\n\n---\n\n")
  }
}
