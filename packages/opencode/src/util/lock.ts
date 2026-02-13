import { createHash, randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"

export namespace Lock {
  const root = path.join(Global.Path.state, "lock")
  const stale = 12 * 60 * 60_000

  const locks = new Map<
    string,
    {
      readers: number
      writer: boolean
      waitingReaders: (() => void)[]
      waitingWriters: (() => void)[]
    }
  >()

  function lockfile(key: string) {
    const hash = createHash("sha256").update(key).digest("hex")
    return path.join(root, hash + ".lock")
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

  async function claim(key: string) {
    await fs.mkdir(root, { recursive: true })
    const file = lockfile(key)
    const token = randomUUID()

    while (true) {
      const opened = await fs.open(file, "wx").catch((error) => {
        const errno = error as NodeJS.ErrnoException
        if (errno.code === "EEXIST") return
        throw error
      })

      if (opened) {
        await opened
          .writeFile(
            JSON.stringify({
              token,
              pid: process.pid,
              time: Date.now(),
            }),
          )
          .catch(() => {})
        await opened.close().catch(() => {})

        const state = { done: false }
        return {
          async release() {
            if (state.done) return
            state.done = true

            const existing = await Bun.file(file)
              .json()
              .catch(() => undefined)
            if (existing && typeof existing === "object") {
              const match = (existing as { token?: unknown }).token
              if (typeof match === "string" && match !== token) return
            }

            await fs.unlink(file).catch(() => {})
          },
        }
      }

      const existing = await Bun.file(file)
        .json()
        .catch(() => undefined)
      const owner = (() => {
        if (!existing || typeof existing !== "object") return
        const time = (existing as { time?: unknown }).time
        const pid = (existing as { pid?: unknown }).pid
        if (typeof time !== "number") return
        if (typeof pid !== "number") return
        return {
          pid,
          time,
        }
      })()

      const orphaned = owner ? !alive(owner.pid) : true
      const expired = owner ? Date.now() - owner.time > stale : true
      if (orphaned || expired) {
        await fs.unlink(file).catch(() => {})
      }

      await Bun.sleep(20)
    }
  }

  function hold(input: {
    key: string
    releaseLocal: () => void
    resolve: (value: Disposable) => void
    reject: (reason?: unknown) => void
  }) {
    claim(input.key)
      .then((claimed) => {
        const state = { done: false }
        input.resolve({
          [Symbol.dispose]: () => {
            if (state.done) return
            state.done = true
            void claimed.release().finally(input.releaseLocal)
          },
        })
      })
      .catch((error) => {
        input.releaseLocal()
        input.reject(error)
      })
  }

  function get(key: string) {
    if (!locks.has(key)) {
      locks.set(key, {
        readers: 0,
        writer: false,
        waitingReaders: [],
        waitingWriters: [],
      })
    }
    return locks.get(key)!
  }

  function wake(key: string) {
    const lock = locks.get(key)
    if (!lock || lock.writer || lock.readers > 0) return

    // Prioritize writers to prevent starvation
    if (lock.waitingWriters.length > 0) {
      const nextWriter = lock.waitingWriters.shift()!
      nextWriter()
      return
    }

    // Wake up all waiting readers
    while (lock.waitingReaders.length > 0) {
      const nextReader = lock.waitingReaders.shift()!
      nextReader()
    }

    // Clean up empty locks
    if (lock.readers === 0 && !lock.writer && lock.waitingReaders.length === 0 && lock.waitingWriters.length === 0) {
      locks.delete(key)
    }
  }

  export async function read(key: string): Promise<Disposable> {
    const lock = get(key)

    return new Promise((resolve, reject) => {
      if (!lock.writer && lock.waitingWriters.length === 0) {
        lock.readers++
        hold({
          key,
          releaseLocal: () => {
            lock.readers--
            wake(key)
          },
          resolve,
          reject,
        })
        return
      }

      lock.waitingReaders.push(() => {
        lock.readers++
        hold({
          key,
          releaseLocal: () => {
            lock.readers--
            wake(key)
          },
          resolve,
          reject,
        })
      })
    })
  }

  export async function write(key: string): Promise<Disposable> {
    const lock = get(key)

    return new Promise((resolve, reject) => {
      if (!lock.writer && lock.readers === 0) {
        lock.writer = true
        hold({
          key,
          releaseLocal: () => {
            lock.writer = false
            wake(key)
          },
          resolve,
          reject,
        })
        return
      }

      lock.waitingWriters.push(() => {
        lock.writer = true
        hold({
          key,
          releaseLocal: () => {
            lock.writer = false
            wake(key)
          },
          resolve,
          reject,
        })
      })
    })
  }
}
