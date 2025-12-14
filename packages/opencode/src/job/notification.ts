import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { JobContext } from "./context"
import type { JobStream } from "./stream"

export namespace JobNotification {
  // State: Map<sessionID, notification[]>
  const state = Instance.state(() => ({
    notifications: new Map<string, Notification[]>(),
    initialized: false,
  }))

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

      // Lazy import to avoid circular dependency
      const { Job } = await import(".")

      // Get job info for type and title
      const job = await Job.get(jobID).catch(() => null)
      if (!job) return

      const notifications = state().notifications
      if (!notifications.has(sessionID)) {
        notifications.set(sessionID, [])
      }
      const queue = notifications.get(sessionID)
      if (queue) {
        queue.push({
          jobID,
          jobType: job.type,
          jobTitle: job.title,
          frame,
        })
      }

      // Auto-trigger prompt loop if session is idle
      const { SessionStatus } = await import("@/session/status")
      const status = SessionStatus.get(sessionID)
      if (status.type === "idle") {
        const { SessionPrompt } = await import("@/session/prompt")
        SessionPrompt.loop(sessionID).catch(() => {
          // Ignore errors - notification will be processed on next user interaction
        })
      }
    })
  }

  // Check if there are pending notifications for a session
  export function hasPending(sessionID: string): boolean {
    const notifications = state().notifications.get(sessionID)
    return notifications !== undefined && notifications.length > 0
  }

  // Drain all notifications for a session (returns and clears)
  export function drain(sessionID: string): Notification[] {
    const notifications = state().notifications
    const pending = notifications.get(sessionID) ?? []
    notifications.delete(sessionID)
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
