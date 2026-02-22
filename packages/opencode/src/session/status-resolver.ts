import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Session } from "@/session"
import { SessionStatus } from "./status"

export namespace SessionStatusResolver {
  export async function get(sessionID: string) {
    const session = await Session.get(sessionID).catch(() => undefined)
    if (!session) return

    return Instance.provide({
      directory: session.directory,
      init: InstanceBootstrap,
      fn: async () => {
        return SessionStatus.get(sessionID)
      },
    }).catch(() => undefined)
  }

  export async function many(sessionIDs: string[]) {
    const result: Record<string, SessionStatus.Info | undefined> = {}
    const unique = Array.from(new Set(sessionIDs))

    const byDirectory = new Map<string, string[]>()
    for (const sessionID of unique) {
      const session = await Session.get(sessionID).catch(() => undefined)
      if (!session) {
        result[sessionID] = undefined
        continue
      }

      const list = byDirectory.get(session.directory) ?? []
      list.push(sessionID)
      byDirectory.set(session.directory, list)
    }

    for (const [directory, ids] of byDirectory.entries()) {
      const resolved = await Instance.provide({
        directory,
        init: InstanceBootstrap,
        fn: async () => {
          const local: Record<string, SessionStatus.Info> = {}
          for (const sessionID of ids) {
            local[sessionID] = SessionStatus.get(sessionID)
          }
          return local
        },
      }).catch(() => ({}) as Record<string, SessionStatus.Info>)

      for (const sessionID of ids) {
        result[sessionID] = resolved[sessionID]
      }
    }

    return result
  }

  export async function all() {
    const sessions: Session.Info[] = []
    for await (const session of Session.list()) {
      sessions.push(session)
    }

    const byDirectory = new Map<string, string[]>()
    for (const session of sessions) {
      const list = byDirectory.get(session.directory) ?? []
      list.push(session.id)
      byDirectory.set(session.directory, list)
    }

    const result: Record<string, SessionStatus.Info> = {}
    for (const [directory, ids] of byDirectory.entries()) {
      const resolved = await Instance.provide({
        directory,
        init: InstanceBootstrap,
        fn: async () => {
          const local: Record<string, SessionStatus.Info> = {}
          for (const sessionID of ids) {
            local[sessionID] = SessionStatus.get(sessionID)
          }
          return local
        },
      }).catch(() => ({}) as Record<string, SessionStatus.Info>)

      for (const sessionID of ids) {
        const status = resolved[sessionID]
        if (!status) continue
        result[sessionID] = status
      }
    }

    return result
  }
}
