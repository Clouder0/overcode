import { Instance } from "../project/instance"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"

export namespace SessionToolOverrides {
  const log = Log.create({ service: "session.tool_overrides" })
  const KEY = "session_tool_overrides"

  type Overrides = Record<string, boolean>

  const state = Instance.state(
    () => {
      return {
        cache: new Map<string, Overrides>(),
        pending: new Map<string, Promise<Overrides>>(),
        queue: new Map<string, Promise<void>>(),
      }
    },
    async (s) => {
      s.cache.clear()
      s.pending.clear()
      s.queue.clear()
    },
  )

  function key(sessionID: string) {
    return [KEY, sessionID]
  }

  function enqueue(sessionID: string, task: () => Promise<void>) {
    const s = state()
    const prev = s.queue.get(sessionID) ?? Promise.resolve()
    const next = prev.then(task, task)
    s.queue.set(sessionID, next)

    next.then(
      () => {
        const current = s.queue.get(sessionID)
        if (current === next) s.queue.delete(sessionID)
      },
      () => {
        const current = s.queue.get(sessionID)
        if (current === next) s.queue.delete(sessionID)
      },
    )

    return next
  }

  export async function get(sessionID: string): Promise<Overrides> {
    const s = state()
    const cached = s.cache.get(sessionID)
    if (cached) return cached

    const inflight = s.pending.get(sessionID)
    if (inflight) return inflight

    const load = Storage.read<Overrides>(key(sessionID))
      .catch((e) => {
        if (e instanceof Storage.NotFoundError) return {}
        log.error("failed to load tool overrides", {
          sessionID,
          error: e instanceof Error ? e.message : String(e),
        })
        return {}
      })
      .then((value) => {
        s.pending.delete(sessionID)
        s.cache.set(sessionID, value)
        return value
      })

    s.pending.set(sessionID, load)
    return load
  }

  export function evict(sessionID: string) {
    const s = state()
    s.cache.delete(sessionID)
    s.pending.delete(sessionID)
  }

  export async function enable(sessionID: string, patterns: string[]) {
    if (patterns.length === 0) return

    await enqueue(sessionID, async () => {
      const s = state()
      const existing = await get(sessionID)
      const next: Overrides = { ...existing }

      for (const pattern of patterns) {
        if (!pattern) continue
        next[pattern] = true
      }

      await Storage.write(key(sessionID), next)
      s.cache.set(sessionID, next)
      s.pending.delete(sessionID)
    })
  }

  export async function clear(sessionID: string) {
    await enqueue(sessionID, async () => {
      evict(sessionID)
      await Storage.remove(key(sessionID)).catch(() => {})
    })
  }
}
