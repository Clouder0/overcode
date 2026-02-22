import z from "zod"
import fs from "fs/promises"
import { existsSync } from "fs"
import { createHash, randomUUID } from "crypto"
import { Filesystem } from "../util/filesystem"
import path from "path"
import { $ } from "bun"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { Flag } from "@/flag/flag"
import { Session } from "../session"
import { work } from "../util/queue"
import { fn } from "@opencode-ai/util/fn"
import { BusEvent } from "@/bus/bus-event"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"

export namespace Project {
  const log = Log.create({ service: "project" })

  function createProjectID() {
    return "prj_" + randomUUID().replaceAll("-", "")
  }

  function directoryProjectID(directory: string) {
    const full = path.resolve(directory)
    const hash = createHash("sha256").update(full).digest("hex").slice(0, 24)
    return "prj_dir_" + hash
  }

  async function legacyGitProjectID(sandbox: string) {
    const roots = await $`git rev-list --max-parents=0 --all`
      .quiet()
      .nothrow()
      .cwd(sandbox)
      .text()
      .then((x) =>
        x
          .split("\n")
          .filter(Boolean)
          .map((item) => item.trim())
          .toSorted(),
      )
    return roots[0]
  }
  export const Info = z
    .object({
      id: z.string(),
      worktree: z.string(),
      vcs: z.literal("git").optional(),
      name: z.string().optional(),
      icon: z
        .object({
          url: z.string().optional(),
          override: z.string().optional(),
          color: z.string().optional(),
        })
        .optional(),
      commands: z
        .object({
          start: z.string().optional().describe("Startup script to run when creating a new workspace (worktree)"),
        })
        .optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        initialized: z.number().optional(),
      }),
      sandboxes: z.array(z.string()),
    })
    .meta({
      ref: "Project",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("project.updated", Info),
  }

  export async function fromDirectory(directory: string) {
    log.info("fromDirectory", { directory })

    const { id, legacy, sandbox, worktree, vcs } = await iife(async () => {
      const matches = Filesystem.up({ targets: [".git"], start: directory })
      const git = await matches.next().then((x) => x.value)
      await matches.return()
      if (git) {
        const sandbox = await $`git rev-parse --show-toplevel`
          .quiet()
          .nothrow()
          .cwd(path.dirname(git))
          .text()
          .then((x) => path.resolve(path.dirname(git), x.trim()))

        const commonDir = await $`git rev-parse --git-common-dir`
          .quiet()
          .nothrow()
          .cwd(sandbox)
          .text()
          .then((x) => path.resolve(sandbox, x.trim()))

        const opencodeFile = path.join(commonDir, "opencode")

        const cached = await Bun.file(opencodeFile)
          .text()
          .then((x) => x.trim())
          .catch(() => {})

        const legacy = await legacyGitProjectID(sandbox)
        const stale = !!cached && !!legacy && cached === legacy
        const id = cached && !stale ? cached : createProjectID()
        if (!cached || stale) await Bun.file(opencodeFile).write(id)

        const worktree = path.dirname(commonDir)
        return {
          id,
          legacy,
          sandbox,
          worktree,
          vcs: "git",
        }
      }

      const resolved = path.resolve(directory)
      return {
        id: directoryProjectID(resolved),
        legacy: undefined,
        worktree: resolved,
        sandbox: resolved,
        vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
      }
    })

    let existing = await Storage.read<Info>(["project", id]).catch(() => undefined)
    if (!existing) {
      existing = {
        id,
        worktree,
        vcs: vcs as Info["vcs"],
        sandboxes: [],
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
      if (id !== "global") {
        await migrateFromGlobal(id, sandbox, vcs === "git")
      }
    }

    if (legacy && legacy !== id) {
      await migrateFromLegacy(legacy, id, sandbox, vcs === "git")
    }

    // migrate old projects before sandboxes
    if (!existing.sandboxes) existing.sandboxes = []

    if (Flag.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY) discover(existing)

    const result: Info = {
      ...existing,
      worktree,
      vcs: vcs as Info["vcs"],
      time: {
        ...existing.time,
        updated: Date.now(),
      },
    }
    if (sandbox !== result.worktree && !result.sandboxes.includes(sandbox)) result.sandboxes.push(sandbox)
    await Storage.write<Info>(["project", id], result)
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return { project: result, sandbox }
  }

  export async function discover(input: Info) {
    if (input.vcs !== "git") return
    if (input.icon?.override) return
    if (input.icon?.url) return
    const glob = new Bun.Glob("**/{favicon}.{ico,png,svg,jpg,jpeg,webp}")
    const matches = await Array.fromAsync(
      glob.scan({
        cwd: input.worktree,
        absolute: true,
        onlyFiles: true,
        followSymlinks: false,
        dot: false,
      }),
    )
    const shortest = matches.sort((a, b) => a.length - b.length)[0]
    if (!shortest) return
    const file = Bun.file(shortest)
    const buffer = await file.arrayBuffer()
    const base64 = Buffer.from(buffer).toString("base64")
    const mime = file.type || "image/png"
    const url = `data:${mime};base64,${base64}`
    await update({
      projectID: input.id,
      icon: {
        url,
      },
    })
    return
  }

  function ownsSession(session: Session.Info, sandbox: string, isGit: boolean) {
    if (!session.directory) return false
    const root = path.resolve(sandbox)
    const directory = path.resolve(session.directory)
    if (!isGit) return directory === root
    return Filesystem.contains(root, directory)
  }

  async function migrateSessions(input: { from: string; to: string; sandbox: string; isGit: boolean; label: string }) {
    if (input.from === input.to) return

    const sessions = await Storage.list(["session", input.from]).catch(() => [])
    if (sessions.length === 0) return

    log.info("migrating sessions", {
      from: input.from,
      to: input.to,
      sandbox: input.sandbox,
      label: input.label,
      count: sessions.length,
    })

    await work(10, sessions, async (key) => {
      const sessionID = key[key.length - 1]
      const session = await Storage.read<Session.Info>(key).catch(() => undefined)
      if (!session) return
      if (!ownsSession(session, input.sandbox, input.isGit)) return

      const existing = await Storage.read<Session.Info>(["session", input.to, sessionID]).catch(() => undefined)
      if (existing?.id === session.id) {
        await Storage.remove(key)
        return
      }

      session.projectID = input.to
      log.info("migrating session", {
        sessionID,
        from: input.from,
        to: input.to,
        label: input.label,
      })
      await Storage.write(["session", input.to, sessionID], session)
      await Storage.remove(key)
    }).catch((error) => {
      log.error("failed to migrate sessions", {
        error,
        from: input.from,
        to: input.to,
        label: input.label,
      })
    })
  }

  async function migrateFromGlobal(newProjectID: string, sandbox: string, isGit: boolean) {
    await migrateSessions({
      from: "global",
      to: newProjectID,
      sandbox,
      isGit,
      label: "global",
    })
  }

  async function migrateFromLegacy(legacyProjectID: string, newProjectID: string, sandbox: string, isGit: boolean) {
    await migrateSessions({
      from: legacyProjectID,
      to: newProjectID,
      sandbox,
      isGit,
      label: "legacy",
    })
  }

  export async function setInitialized(projectID: string) {
    await Storage.update<Info>(["project", projectID], (draft) => {
      draft.time.initialized = Date.now()
    })
  }

  export async function list() {
    const keys = await Storage.list(["project"])
    const projects = await Promise.all(keys.map((x) => Storage.read<Info>(x)))
    return projects.map((project) => ({
      ...project,
      sandboxes: project.sandboxes?.filter((x) => existsSync(x)),
    }))
  }

  export const update = fn(
    z.object({
      projectID: z.string(),
      name: z.string().optional(),
      icon: Info.shape.icon.optional(),
      commands: Info.shape.commands.optional(),
    }),
    async (input) => {
      const result = await Storage.update<Info>(["project", input.projectID], (draft) => {
        if (input.name !== undefined) draft.name = input.name
        if (input.icon !== undefined) {
          draft.icon = {
            ...draft.icon,
          }
          if (input.icon.url !== undefined) draft.icon.url = input.icon.url
          if (input.icon.override !== undefined) draft.icon.override = input.icon.override || undefined
          if (input.icon.color !== undefined) draft.icon.color = input.icon.color
        }

        if (input.commands?.start !== undefined) {
          const start = input.commands.start || undefined
          draft.commands = {
            ...(draft.commands ?? {}),
          }
          draft.commands.start = start
          if (!draft.commands.start) draft.commands = undefined
        }

        draft.time.updated = Date.now()
      })
      GlobalBus.emit("event", {
        payload: {
          type: Event.Updated.type,
          properties: result,
        },
      })
      return result
    },
  )

  export async function addSandbox(projectID: string, directory: string) {
    const resolved = path.resolve(directory)
    const result = await Storage.update<Info>(["project", projectID], (draft) => {
      draft.sandboxes ??= []
      if (!draft.sandboxes.includes(resolved)) draft.sandboxes.push(resolved)
      draft.time.updated = Date.now()
    })
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return result
  }

  export async function sandboxes(projectID: string) {
    const project = await Storage.read<Info>(["project", projectID]).catch(() => undefined)
    if (!project?.sandboxes) return []
    const valid: string[] = []
    for (const dir of project.sandboxes) {
      const stat = await fs.stat(dir).catch(() => undefined)
      if (stat?.isDirectory()) valid.push(dir)
    }
    return valid
  }

  export async function removeSandbox(projectID: string, directory: string) {
    const resolved = path.resolve(directory)
    const result = await Storage.update<Info>(["project", projectID], (draft) => {
      const sandboxes = draft.sandboxes ?? []
      draft.sandboxes = sandboxes.filter((sandbox) => sandbox !== resolved)
      draft.time.updated = Date.now()
    })
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return result
  }
}
