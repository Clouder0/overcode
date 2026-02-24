import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { $ } from "bun"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.list", () => {
  test("scope=auto uses project scope only in linked git worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = tmp.path + "-wt"
    const branch = "wt-" + Math.random().toString(36).slice(2)

    await $`git worktree add ${worktree} -b ${branch}`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()

        const main = await Session.create({})
        const wt = await Instance.provide({
          directory: worktree,
          fn: async () => Session.create({}),
        })

        const wtAuto = await app.request(`/session?scope=auto`, {
          headers: {
            "x-opencode-directory": worktree,
          },
        })
        expect(wtAuto.status).toBe(200)
        const wtIDs = ((await wtAuto.json()) as Array<{ id: string }>).map((x) => x.id)
        expect(wtIDs).toContain(main.id)
        expect(wtIDs).toContain(wt.id)

        const mainAuto = await app.request(`/session?scope=auto`, {
          headers: {
            "x-opencode-directory": tmp.path,
          },
        })
        expect(mainAuto.status).toBe(200)
        const mainIDs = ((await mainAuto.json()) as Array<{ id: string }>).map((x) => x.id)
        expect(mainIDs).toContain(main.id)
        expect(mainIDs).not.toContain(wt.id)
      },
    })
  })

  test("directory query overrides scope=auto in linked git worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = tmp.path + "-wt"
    const branch = "wt-" + Math.random().toString(36).slice(2)

    await $`git worktree add ${worktree} -b ${branch}`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()

        const main = await Session.create({})
        const wt = await Instance.provide({
          directory: worktree,
          fn: async () => Session.create({}),
        })

        const filtered = await app.request(`/session?scope=auto&directory=${encodeURIComponent(tmp.path)}`, {
          headers: {
            "x-opencode-directory": worktree,
          },
        })
        expect(filtered.status).toBe(200)
        const ids = ((await filtered.json()) as Array<{ id: string }>).map((x) => x.id)
        expect(ids).toContain(main.id)
        expect(ids).not.toContain(wt.id)
      },
    })
  })

  test("defaults to current directory scope and supports explicit project scope", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const sub = path.join(projectRoot, "test", "_session_list_sub")
        await fs.mkdir(sub, { recursive: true })

        const first = await Session.create({})
        const second = await Instance.provide({
          directory: sub,
          fn: async () => Session.create({}),
        })

        const local = await app.request(`/session`, {
          headers: {
            "x-opencode-directory": projectRoot,
          },
        })
        expect(local.status).toBe(200)
        const localBody = (await local.json()) as Array<{ id: string }>
        const localIDs = localBody.map((x) => x.id)

        expect(localIDs).toContain(first.id)
        expect(localIDs).not.toContain(second.id)

        const all = await app.request(`/session?scope=project`, {
          headers: {
            "x-opencode-directory": projectRoot,
          },
        })
        expect(all.status).toBe(200)
        const allBody = (await all.json()) as Array<{ id: string }>
        const allIDs = allBody.map((x) => x.id)

        expect(allIDs).toContain(first.id)
        expect(allIDs).toContain(second.id)
      },
    })
  })

  test("filters by directory", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        const first = await Session.create({})

        const otherDir = path.join(projectRoot, "..", "__session_list_other")
        const second = await Instance.provide({
          directory: otherDir,
          fn: async () => Session.create({}),
        })

        const response = await app.request(`/session?directory=${encodeURIComponent(projectRoot)}`)
        expect(response.status).toBe(200)

        const body = (await response.json()) as unknown[]
        const ids = body
          .map((s) => (typeof s === "object" && s && "id" in s ? (s as { id: string }).id : undefined))
          .filter((x): x is string => typeof x === "string")

        expect(ids).toContain(first.id)
        expect(ids).not.toContain(second.id)
      },
    })
  })
})
