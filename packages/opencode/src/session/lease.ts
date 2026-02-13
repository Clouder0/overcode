import { randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"

export namespace SessionLease {
  type Entry = {
    file: string
    token: string
    count: number
  }

  const root = path.join(Global.Path.state, "session-lease")
  const stale = 12 * 60 * 60_000
  const state = new Map<string, Entry>()

  function file(sessionID: string) {
    return path.join(root, sessionID + ".json")
  }

  function alive(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      const errno = error as NodeJS.ErrnoException
      if (errno.code === "EPERM") return true
      return false
    }
  }

  async function clearOrphan(filepath: string) {
    const info = await Bun.file(filepath)
      .json()
      .catch(() => undefined)

    if (!info || typeof info !== "object") {
      await fs.unlink(filepath).catch(() => {})
      return true
    }

    const pid = (info as { pid?: unknown }).pid
    const time = (info as { time?: unknown }).time
    if (typeof pid !== "number") {
      await fs.unlink(filepath).catch(() => {})
      return true
    }

    if (typeof time !== "number") {
      await fs.unlink(filepath).catch(() => {})
      return true
    }

    if (!alive(pid)) {
      await fs.unlink(filepath).catch(() => {})
      return true
    }

    if (Date.now() - time > stale) {
      await fs.unlink(filepath).catch(() => {})
      return true
    }

    return false
  }

  async function release(sessionID: string, token: string) {
    const current = state.get(sessionID)
    if (!current) return
    if (current.token !== token) return

    current.count -= 1
    if (current.count > 0) return

    state.delete(sessionID)

    const info = await Bun.file(current.file)
      .json()
      .catch(() => undefined)

    if (info && typeof info === "object") {
      const match = (info as { token?: unknown }).token
      if (typeof match === "string" && match !== token) return
    }

    await fs.unlink(current.file).catch(() => {})
  }

  export async function acquire(sessionID: string) {
    const active = state.get(sessionID)
    if (active) {
      active.count += 1
      const local = { done: false }
      return {
        async release() {
          if (local.done) return
          local.done = true
          await release(sessionID, active.token)
        },
      }
    }

    await fs.mkdir(root, { recursive: true })
    const filepath = file(sessionID)
    const token = randomUUID()

    for (const _ of [0, 1]) {
      const opened = await fs.open(filepath, "wx").catch((error) => {
        const errno = error as NodeJS.ErrnoException
        if (errno.code === "EEXIST") return
        throw error
      })

      if (opened) {
        const payload = JSON.stringify({
          token,
          pid: process.pid,
          time: Date.now(),
        })

        const written = await opened
          .writeFile(payload)
          .then(() => true)
          .catch(() => false)

        await opened.close().catch(() => {})

        if (!written) {
          await fs.unlink(filepath).catch(() => {})
          return
        }

        state.set(sessionID, {
          file: filepath,
          token,
          count: 1,
        })

        const local = { done: false }
        return {
          async release() {
            if (local.done) return
            local.done = true
            await release(sessionID, token)
          },
        }
      }

      const reclaimed = await clearOrphan(filepath)
      if (reclaimed) continue
      return
    }

    return
  }
}
