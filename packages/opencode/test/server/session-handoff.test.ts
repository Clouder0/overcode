import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { $ } from "bun"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionStatus } from "../../src/session/status"
import { WaitPolicy } from "../../src/session/wait-policy"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

describe("session.handoff", () => {
  test("moves session directory to the request directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = tmp.path + "-wt"
    const branch = "wt-" + Math.random().toString(36).slice(2)
    await $`git worktree add ${worktree} -b ${branch}`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})
        expect(session.directory).toBe(tmp.path)

        const moved = await app.request(`/session/${session.id}/handoff`, {
          method: "POST",
          headers: {
            "x-opencode-directory": worktree,
          },
        })
        expect(moved.status).toBe(200)
        const body = (await moved.json()) as { id: string; directory: string }
        expect(body.id).toBe(session.id)
        expect(body.directory).toBe(worktree)

        const read = await app.request(`/session/${session.id}`, {
          headers: {
            "x-opencode-directory": worktree,
          },
        })
        expect(read.status).toBe(200)
        const readBody = (await read.json()) as { id: string; directory: string }
        expect(readBody.id).toBe(session.id)
        expect(readBody.directory).toBe(worktree)
      },
    })
  })

  test("returns 409 when session is leased", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = tmp.path + "-wt"
    const branch = "wt-" + Math.random().toString(36).slice(2)
    await $`git worktree add ${worktree} -b ${branch}`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const file = path.join(Global.Path.state, "session-lease", session.id + ".json")
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(
          file,
          JSON.stringify({
            token: "test",
            pid: process.pid,
            time: Date.now(),
          }),
        )

        try {
          const moved = await app.request(`/session/${session.id}/handoff`, {
            method: "POST",
            headers: {
              "x-opencode-directory": worktree,
            },
          })
          expect(moved.status).toBe(409)
        } finally {
          await fs.unlink(file).catch(() => {})
        }
      },
    })
  })

  test("returns 409 when session is waiting", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = tmp.path + "-wt"
    const branch = "wt-" + Math.random().toString(36).slice(2)
    await $`git worktree add ${worktree} -b ${branch}`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        WaitPolicy.register({
          sessionID: session.id,
          messageID: "msg",
          callID: "call",
          sources: ["ses_src"],
          timeout: 0,
          mode: "all",
          since: 0,
        })

        try {
          const moved = await app.request(`/session/${session.id}/handoff`, {
            method: "POST",
            headers: {
              "x-opencode-directory": worktree,
            },
          })
          expect(moved.status).toBe(409)
        } finally {
          WaitPolicy.clear(session.id)
        }
      },
    })
  })

  test("returns 409 when manual compaction is active", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = tmp.path + "-wt"
    const branch = "wt-" + Math.random().toString(36).slice(2)
    await $`git worktree add ${worktree} -b ${branch}`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        SessionCompaction.beginManual({
          sessionID: session.id,
          requestID: "req",
          startedAt: Date.now(),
        })

        try {
          const moved = await app.request(`/session/${session.id}/handoff`, {
            method: "POST",
            headers: {
              "x-opencode-directory": worktree,
            },
          })
          expect(moved.status).toBe(409)
        } finally {
          SessionCompaction.forceEndManual(session.id)
        }
      },
    })
  })

  test("returns 409 when session status is not idle", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = tmp.path + "-wt"
    const branch = "wt-" + Math.random().toString(36).slice(2)
    await $`git worktree add ${worktree} -b ${branch}`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})
        SessionStatus.set(session.id, { type: "busy" })

        const moved = await app.request(`/session/${session.id}/handoff`, {
          method: "POST",
          headers: {
            "x-opencode-directory": worktree,
          },
        })
        expect(moved.status).toBe(409)
      },
    })
  })
})
