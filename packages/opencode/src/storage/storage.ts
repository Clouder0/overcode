import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { $ } from "bun"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"

export namespace Storage {
  const log = Log.create({ service: "storage" })

  type Migration = (dir: string) => Promise<void>

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  export const InvalidKeyError = NamedError.create(
    "StorageInvalidKeyError",
    z.object({
      key: z.array(z.string()),
      reason: z.string(),
    }),
  )

  function assertSafeSegments(segments: string[], label: string) {
    for (const segment of segments) {
      if (!segment) {
        throw new InvalidKeyError({ key: segments, reason: `${label} contains empty segment` })
      }
      if (segment.includes("\0")) {
        throw new InvalidKeyError({ key: segments, reason: `${label} contains null byte` })
      }
      if (segment === "." || segment === "..") {
        throw new InvalidKeyError({ key: segments, reason: `${label} contains traversal segment` })
      }
      if (segment.includes("/") || segment.includes("\\")) {
        throw new InvalidKeyError({ key: segments, reason: `${label} contains path separator` })
      }
      if (path.isAbsolute(segment)) {
        throw new InvalidKeyError({ key: segments, reason: `${label} contains absolute segment` })
      }
    }
  }

  const MIGRATIONS: Migration[] = [
    async (dir) => {
      const project = path.resolve(dir, "../project")
      if (!(await Filesystem.isDir(project))) return
      for await (const projectDir of new Bun.Glob("*").scan({
        cwd: project,
        onlyFiles: false,
      })) {
        log.info(`migrating project ${projectDir}`)
        let projectID = projectDir
        const fullProjectDir = path.join(project, projectDir)
        let worktree = "/"

        if (projectID !== "global") {
          for await (const msgFile of new Bun.Glob("storage/session/message/*/*.json").scan({
            cwd: path.join(project, projectDir),
            absolute: true,
          })) {
            const json = await Bun.file(msgFile).json()
            worktree = json.path?.root
            if (worktree) break
          }
          if (!worktree) continue
          if (!(await Filesystem.isDir(worktree))) continue
          const [id] = await $`git rev-list --max-parents=0 --all`
            .quiet()
            .nothrow()
            .cwd(worktree)
            .text()
            .then((x) =>
              x
                .split("\n")
                .filter(Boolean)
                .map((x) => x.trim())
                .toSorted(),
            )
          if (!id) continue
          projectID = id

          await Bun.write(
            path.join(dir, "project", projectID + ".json"),
            JSON.stringify({
              id,
              vcs: "git",
              worktree,
              time: {
                created: Date.now(),
                initialized: Date.now(),
              },
            }),
          )

          log.info(`migrating sessions for project ${projectID}`)
          for await (const sessionFile of new Bun.Glob("storage/session/info/*.json").scan({
            cwd: fullProjectDir,
            absolute: true,
          })) {
            const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
            log.info("copying", {
              sessionFile,
              dest,
            })
            const session = await Bun.file(sessionFile).json()
            await Bun.write(dest, JSON.stringify(session))
            log.info(`migrating messages for session ${session.id}`)
            for await (const msgFile of new Bun.Glob(`storage/session/message/${session.id}/*.json`).scan({
              cwd: fullProjectDir,
              absolute: true,
            })) {
              const dest = path.join(dir, "message", session.id, path.basename(msgFile))
              log.info("copying", {
                msgFile,
                dest,
              })
              const message = await Bun.file(msgFile).json()
              await Bun.write(dest, JSON.stringify(message))

              log.info(`migrating parts for message ${message.id}`)
              for await (const partFile of new Bun.Glob(`storage/session/part/${session.id}/${message.id}/*.json`).scan(
                {
                  cwd: fullProjectDir,
                  absolute: true,
                },
              )) {
                const dest = path.join(dir, "part", message.id, path.basename(partFile))
                const part = await Bun.file(partFile).json()
                log.info("copying", {
                  partFile,
                  dest,
                })
                await Bun.write(dest, JSON.stringify(part))
              }
            }
          }
        }
      }
    },
    async (dir) => {
      for await (const item of new Bun.Glob("session/*/*.json").scan({
        cwd: dir,
        absolute: true,
      })) {
        const session = await Bun.file(item).json()
        if (!session.projectID) continue
        if (!session.summary?.diffs) continue
        const { diffs } = session.summary
        await Bun.file(path.join(dir, "session_diff", session.id + ".json")).write(JSON.stringify(diffs))
        await Bun.file(path.join(dir, "session", session.projectID, session.id + ".json")).write(
          JSON.stringify({
            ...session,
            summary: {
              additions: diffs.reduce((sum: any, x: any) => sum + x.additions, 0),
              deletions: diffs.reduce((sum: any, x: any) => sum + x.deletions, 0),
            },
          }),
        )
      }
    },
    async (dir) => {
      const root = path.join(dir, "message")
      if (!(await Filesystem.isDir(root))) return

      const sessions = new Map<
        string,
        {
          file: string
          id: string
          created: number
          json: Record<string, unknown>
        }[]
      >()

      for await (const file of new Bun.Glob("message/*/*.json").scan({
        cwd: dir,
        absolute: true,
      })) {
        const json = await Bun.file(file)
          .json()
          .catch(() => undefined)
        if (!json || typeof json !== "object") continue
        if (Array.isArray(json)) continue

        const rel = path.relative(dir, file)
        const parts = rel.split(path.sep)
        const sessionID = parts.length >= 3 ? parts[1] : undefined
        if (!sessionID) continue

        const id = (() => {
          const value = (json as { id?: unknown }).id
          if (typeof value === "string") return value
          return path.basename(file, ".json")
        })()

        const created = (() => {
          const time = (json as { time?: unknown }).time
          const raw = (() => {
            if (!time || typeof time !== "object") return
            const value = (time as { created?: unknown }).created
            if (typeof value === "number") return value
          })()
          if (raw !== undefined) return raw

          const index = id.indexOf("_")
          if (index < 0) return 0
          const hex = id.slice(index + 1, index + 13)
          if (!/^[0-9a-fA-F]{12}$/.test(hex)) return 0
          const value = Number(BigInt(`0x${hex}`) / 0x1000n)
          if (!Number.isFinite(value)) return 0
          return value
        })()

        const existing = sessions.get(sessionID) ?? []
        existing.push({ file, id, created, json: json as Record<string, unknown> })
        sessions.set(sessionID, existing)
      }

      await fs.mkdir(path.join(dir, "message_order"), { recursive: true })

      for (const [sessionID, items] of sessions) {
        const byID = new Map<string, number>()

        const preserve = (() => {
          const seen = new Set<number>()
          for (const item of items) {
            const raw = item.json["order"]
            if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return false
            if (seen.has(raw)) return false
            seen.add(raw)
            byID.set(item.id, raw)
          }
          return true
        })()

        const next = await (async () => {
          if (preserve) {
            const max = Math.max(...Array.from(byID.values()), 0)
            return max + 1
          }

          items.sort((a, b) => {
            const aCreated = a.created > 0 ? a.created : Number.POSITIVE_INFINITY
            const bCreated = b.created > 0 ? b.created : Number.POSITIVE_INFINITY
            if (aCreated !== bCreated) return aCreated - bCreated
            if (a.id === b.id) return 0
            return a.id > b.id ? 1 : -1
          })

          byID.clear()
          for (const [index, item] of items.entries()) {
            const order = index + 1
            item.json["order"] = order
            byID.set(item.id, order)
            await Bun.write(item.file, JSON.stringify(item.json, null, 2))
          }

          return items.length + 1
        })()

        await Bun.write(path.join(dir, "message_order", sessionID + ".json"), JSON.stringify({ next }, null, 2))

        const cpdFile = path.join(dir, "cpd", sessionID + ".json")
        const cpd = await Bun.file(cpdFile)
          .json()
          .catch(() => undefined)
        if (!cpd || typeof cpd !== "object") continue
        if (Array.isArray(cpd)) continue
        const upto = (cpd as { upto?: unknown }).upto
        if (typeof upto !== "string") continue
        const uptoOrder = byID.get(upto)
        if (typeof uptoOrder !== "number") continue
        const current = (cpd as { uptoOrder?: unknown }).uptoOrder
        const valid = typeof current === "number" && Number.isInteger(current) && current > 0
        if (!valid || current !== uptoOrder) {
          ;(cpd as Record<string, unknown>)["uptoOrder"] = uptoOrder
          await Bun.write(cpdFile, JSON.stringify(cpd, null, 2))
        }
      }
    },
  ]

  const state = lazy(async () => {
    const dir = path.join(Global.Path.data, "storage")
    const migration = await Bun.file(path.join(dir, "migration"))
      .json()
      .then((x) => parseInt(x))
      .catch(() => 0)
    for (let index = migration; index < MIGRATIONS.length; index++) {
      log.info("running migration", { index })
      const migration = MIGRATIONS[index]

      const ok = await migration(dir).then(
        () => true,
        (error) => {
          log.error("failed to run migration", { index, error })
          return false
        },
      )

      if (!ok) break
      await Bun.write(path.join(dir, "migration"), (index + 1).toString())
    }
    return {
      dir,
    }
  })

  export async function remove(key: string[]) {
    assertSafeSegments(key, "key")
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      await fs.unlink(target).catch(() => {})
    })
  }

  export async function read<T>(key: string[]) {
    assertSafeSegments(key, "key")
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.read(target)
      const result = await Bun.file(target).json()
      return result as T
    })
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    assertSafeSegments(key, "key")
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      const content = await Bun.file(target).json()
      fn(content)
      await Bun.write(target, JSON.stringify(content, null, 2))
      return content as T
    })
  }

  export async function upsert<T>(
    key: string[],
    create: () => T,
    fn: (draft: T) => boolean | void,
  ): Promise<{ value: T; wrote: boolean }> {
    assertSafeSegments(key, "key")
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)

      const file = Bun.file(target)

      const existing = await (async () => {
        if (!(await file.exists())) return

        const raw = await file.text().catch((error) => {
          // The file can be deleted between exists() and text() across processes.
          // Treat it as missing and proceed with create().
          const errno = error as NodeJS.ErrnoException
          if (errno?.code === "ENOENT") return
          throw error
        })
        if (!raw) return
        try {
          return JSON.parse(raw) as T
        } catch (error) {
          // CPD/marker data is derived; if the JSON is corrupt, recover by
          // moving it aside so the next write can proceed.
          if (!(error instanceof SyntaxError)) throw error

          const moved = await fs
            .rename(target, target + `.corrupt.${Date.now()}`)
            .then(() => true)
            .catch(() => false)
          if (!moved) {
            await fs.unlink(target).catch(() => {})
          }
          return
        }
      })()

      const value = existing ?? create()
      const wrote = fn(value) !== false
      if (wrote) {
        await Bun.write(target, JSON.stringify(value, null, 2))
      }
      return { value, wrote }
    })
  }

  export async function write<T>(key: string[], content: T) {
    assertSafeSegments(key, "key")
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      await Bun.write(target, JSON.stringify(content, null, 2))
    })
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      throw e
    })
  }

  const glob = new Bun.Glob("**/*.json")
  export async function list(prefix: string[]) {
    assertSafeSegments(prefix, "prefix")
    const dir = await state().then((x) => x.dir)
    try {
      const result = await Array.fromAsync(
        glob.scan({
          cwd: path.join(dir, ...prefix),
          onlyFiles: true,
        }),
      ).then((results) => results.map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)]))
      result.sort()
      return result
    } catch (e) {
      // Only return empty for "directory not found" - re-throw other errors
      if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
        return []
      }
      throw e
    }
  }
}
