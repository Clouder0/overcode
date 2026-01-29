import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"

export namespace FileTime {
  const log = Log.create({ service: "file.time" })

  export type Stamp = {
    mtimeMs: number
    size: number
    hash: bigint
  }

  // Per-session read stamps plus per-file write locks.
  // All tools that overwrite existing files should run their
  // assert/read/write/update sequence inside withLock(filepath, ...)
  // so concurrent writes to the same file are serialized.
  export const state = Instance.state(() => {
    const read: {
      [sessionID: string]: {
        [path: string]: Stamp | undefined
      }
    } = {}
    const locks = new Map<string, Promise<void>>()
    return {
      read,
      locks,
    }
  })

  export function stamp(mtime: Date, data: string | ArrayBuffer | Uint8Array): Stamp {
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength
    return {
      mtimeMs: mtime.getTime(),
      size,
      hash: Bun.hash.xxHash64(data),
    }
  }

  export function read(sessionID: string, file: string, value: Stamp) {
    log.info("read", { sessionID, file })
    const { read } = state()
    read[sessionID] = read[sessionID] || {}
    read[sessionID][file] = value
  }

  export function clear(sessionID: string, file: string) {
    const map = state().read[sessionID]
    if (!map) return
    delete map[file]
  }

  export function get(sessionID: string, file: string) {
    return state().read[sessionID]?.[file]
  }

  export async function withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
    const current = state()
    const currentLock = current.locks.get(filepath) ?? Promise.resolve()
    let release: () => void = () => {}
    const nextLock = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = currentLock.then(() => nextLock)
    current.locks.set(filepath, chained)
    await currentLock
    try {
      return await fn()
    } finally {
      release()
      if (current.locks.get(filepath) === chained) {
        current.locks.delete(filepath)
      }
    }
  }

  export async function withLocks<T>(filepaths: string[], fn: () => Promise<T>): Promise<T> {
    const unique = Array.from(new Set(filepaths)).sort()

    const run = (index: number): Promise<T> => {
      const filepath = unique[index]
      if (!filepath) return fn()
      return withLock(filepath, () => run(index + 1))
    }

    return run(0)
  }

  export async function assert(sessionID: string, filepath: string) {
    if (Flag.OPENCODE_DISABLE_FILETIME_CHECK === true) return

    const prev = get(sessionID, filepath)
    if (!prev) throw new Error(`You must read the file ${filepath} before overwriting it. Use the Read tool first`)

    const file = Bun.file(filepath)
    const stats = await file.stat()
    const currentMtimeMs = stats.mtime.getTime()

    if (currentMtimeMs <= prev.mtimeMs) return

    if (stats.size !== prev.size) {
      throw new Error(
        `File ${filepath} has been modified since it was last read.\nLast modification: ${stats.mtime.toISOString()}\nLast read: ${new Date(prev.mtimeMs).toISOString()}\n\nPlease read the file again before modifying it.`,
      )
    }

    const buf = await file.arrayBuffer()
    const currentHash = Bun.hash.xxHash64(buf)

    if (currentHash === prev.hash) {
      read(sessionID, filepath, {
        mtimeMs: currentMtimeMs,
        size: stats.size,
        hash: currentHash,
      })
      return
    }

    throw new Error(
      `File ${filepath} has been modified since it was last read.\nLast modification: ${stats.mtime.toISOString()}\nLast read: ${new Date(prev.mtimeMs).toISOString()}\n\nPlease read the file again before modifying it.`,
    )
  }
}
