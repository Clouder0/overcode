import type { DialogSelectOption } from "@tui/ui/dialog-select"
import { Locale } from "@/util/locale"

export type ChildSessionPickerSession = {
  id: string
  title: string
  parentID?: string
  time: {
    updated: number
  }
}

type PermissionBySession = Record<string, Array<unknown> | undefined>

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

function permissionCount(permissions: PermissionBySession, sessionID: string): number {
  const list = permissions[sessionID]
  if (!list) return 0
  return Array.isArray(list) ? list.length : 0
}

function categoryFor(input: { rootID: string; sessionID: string; permissions: PermissionBySession }): string {
  if (input.sessionID === input.rootID) return "Parent"
  if (permissionCount(input.permissions, input.sessionID) > 0) return "Needs input"
  return "Child sessions"
}

function sortRank(category: string): number {
  return (
    {
      "Needs input": 0,
      "Child sessions": 1,
      Parent: 2,
    }[category] ?? 99
  )
}

export function buildChildSessionPickerOptions(input: {
  currentSessionID: string
  sessions: ChildSessionPickerSession[]
  permissionsBySession: PermissionBySession
}): {
  rootID: string
  options: DialogSelectOption<string>[]
} {
  const sessionByID = new Map(input.sessions.map((s) => [s.id, s]))
  const current = sessionByID.get(input.currentSessionID)
  const rootID = current?.parentID ?? current?.id ?? input.currentSessionID

  const directChildren = input.sessions.filter((s) => s.parentID === rootID).map((s) => s.id)
  const sessionIDs = new Set<string>([rootID, ...directChildren])

  const options = Array.from(sessionIDs)
    .map((sessionID) => {
      const session = sessionByID.get(sessionID)
      const sid = shortID(sessionID)

      const title = (() => {
        if (sessionID === rootID) return `Parent session · ${sid}`
        if (session && !isDefaultSessionTitle(session.title)) return `${session.title} · ${sid}`
        return `Child session · ${sid}`
      })()

      const description = (() => {
        if (!session) return
        if (!isDefaultSessionTitle(session.title)) return session.title
      })()

      const category = categoryFor({
        rootID,
        sessionID,
        permissions: input.permissionsBySession,
      })

      const footer = (() => {
        const permissionTotal = permissionCount(input.permissionsBySession, sessionID)
        if (permissionTotal > 0) return `${permissionTotal} pending`
        if (session) return Locale.todayTimeOrDateTime(session.time.updated)
      })()

      return {
        title,
        value: sessionID,
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
