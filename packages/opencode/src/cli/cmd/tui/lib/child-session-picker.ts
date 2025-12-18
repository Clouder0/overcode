import type { DialogSelectOption } from "@tui/ui/dialog-select"
import { Locale } from "@/util/locale"
import { getWorkerSessionID, getWorkerAgent } from "./job"

export type ChildSessionPickerSession = {
  id: string
  title: string
  parentID?: string
  time: {
    updated: number
  }
}

export type ChildSessionPickerJobStatus = "pending" | "running" | "completed" | "error" | "canceled"

export type ChildSessionPickerJob = {
  id: string
  title: string
  status: ChildSessionPickerJobStatus
  metadata?: unknown
  time: {
    created: number
    updated: number
    started?: number
    completed?: number
  }
}

type PermissionBySession = Record<string, Array<unknown> | undefined>

type WorkerInfo = {
  sessionID: string
  job?: ChildSessionPickerJob
  agent?: string
}

const JOB_STATUS_SORT: Record<ChildSessionPickerJobStatus, number> = {
  running: 0,
  pending: 1,
  error: 2,
  completed: 3,
  canceled: 4,
}

function isDefaultSessionTitle(title: string): boolean {
  const prefix = title.startsWith("New session - ") || title.startsWith("Child session - ")
  if (!prefix) return false
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

function shortID(id: string): string {
  if (!id) return ""
  if (id.length <= 8) return id
  return id.slice(-8)
}

function jobDuration(job: ChildSessionPickerJob, now: number): string {
  if (job.status === "pending") return "pending"
  const start = job.time.started ?? job.time.created
  const end = job.time.completed ?? now
  return Locale.duration(Math.max(0, end - start))
}

function permissionCount(permissions: PermissionBySession, sessionID: string): number {
  const list = permissions[sessionID]
  if (!list) return 0
  return Array.isArray(list) ? list.length : 0
}

function pickJobForWorker(jobs: ChildSessionPickerJob[]): ChildSessionPickerJob | undefined {
  if (jobs.length === 0) return
  return jobs
    .toSorted((a, b) => {
      const status = JOB_STATUS_SORT[a.status] - JOB_STATUS_SORT[b.status]
      if (status !== 0) return status
      return b.time.updated - a.time.updated
    })
    .at(0)
}

function categoryFor(input: {
  rootID: string
  sessionID: string
  job?: ChildSessionPickerJob
  permissions: PermissionBySession
}): string {
  if (input.sessionID === input.rootID) return "Parent"
  if (permissionCount(input.permissions, input.sessionID) > 0) return "Needs input"
  const status = input.job?.status
  if (!status) return "Child sessions"
  return (
    {
      running: "Running",
      pending: "Pending",
      error: "Error",
      completed: "Completed",
      canceled: "Canceled",
    } as const
  )[status]
}

function sortRank(category: string): number {
  return (
    {
      "Needs input": 0,
      Running: 1,
      Pending: 2,
      Error: 3,
      Completed: 4,
      Canceled: 5,
      "Child sessions": 6,
      Parent: 7,
    }[category] ?? 99
  )
}

export function buildChildSessionPickerOptions(input: {
  currentSessionID: string
  sessions: ChildSessionPickerSession[]
  jobs: ChildSessionPickerJob[]
  permissionsBySession: PermissionBySession
  now?: number
}): {
  rootID: string
  options: DialogSelectOption<string>[]
} {
  const now = input.now ?? Date.now()
  const sessionByID = new Map(input.sessions.map((s) => [s.id, s]))
  const current = sessionByID.get(input.currentSessionID)
  const rootID = current?.parentID ?? current?.id ?? input.currentSessionID

  const directChildren = input.sessions.filter((s) => s.parentID === rootID).map((s) => s.id)

  const jobsByWorker = new Map<string, ChildSessionPickerJob[]>()
  for (const job of input.jobs) {
    const workerSessionID = getWorkerSessionID(job.metadata)
    if (!workerSessionID) continue
    const list = jobsByWorker.get(workerSessionID) ?? []
    jobsByWorker.set(workerSessionID, [...list, job])
  }

  const workerSessions = Array.from(jobsByWorker.keys())

  const sessionIDs = new Set<string>([rootID, ...directChildren, ...workerSessions])

  const workers: WorkerInfo[] = []
  for (const sessionID of sessionIDs) {
    const jobs = jobsByWorker.get(sessionID) ?? []
    const job = pickJobForWorker(jobs)
    const agent = job ? getWorkerAgent(job.metadata) : undefined
    workers.push({ sessionID, job, agent })
  }

  const options = workers
    .map((worker) => {
      const session = sessionByID.get(worker.sessionID)
      const sid = shortID(worker.sessionID)

      const title = (() => {
        if (worker.sessionID === rootID) return `Parent session · ${sid}`
        if (worker.job) {
          const prefix = worker.agent ? `[${worker.agent}] ` : ""
          return `${prefix}${worker.job.title} · ${sid}`
        }
        if (session && !isDefaultSessionTitle(session.title)) return `${session.title} · ${sid}`
        return `Child session · ${sid}`
      })()

      const description = (() => {
        if (!session) return
        if (!isDefaultSessionTitle(session.title)) return session.title
      })()

      const category = categoryFor({
        rootID,
        sessionID: worker.sessionID,
        job: worker.job,
        permissions: input.permissionsBySession,
      })

      const footer = (() => {
        const permissionTotal = permissionCount(input.permissionsBySession, worker.sessionID)
        if (permissionTotal > 0) return `${permissionTotal} pending`
        if (worker.job) return `${worker.job.status} · ${jobDuration(worker.job, now)}`
        if (session) return Locale.todayTimeOrDateTime(session.time.updated)
      })()

      return {
        title,
        value: worker.sessionID,
        description,
        category,
        footer,
      } satisfies DialogSelectOption<string>
    })
    .toSorted((a, b) => {
      const rank = sortRank(a.category ?? "") - sortRank(b.category ?? "")
      if (rank !== 0) return rank

      const aUpdated = sessionByID.get(a.value)?.time.updated ?? 0
      const bUpdated = sessionByID.get(b.value)?.time.updated ?? 0
      if (aUpdated !== bUpdated) return bUpdated - aUpdated

      return a.value.localeCompare(b.value)
    })

  return {
    rootID,
    options,
  }
}
