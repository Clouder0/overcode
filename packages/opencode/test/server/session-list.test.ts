import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.list", () => {
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
