import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { mkdtemp } from "fs/promises"

type RunResult = {
  stdout: string
  stderr: string
  exitCode: number
}

async function run(input: { code: string; cwd: string; env: Record<string, string> }): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "-e", input.code], {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...input.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return {
    stdout,
    stderr,
    exitCode: code,
  }
}

describe("session prompt ownership", () => {
  test("rejects prompt while another process owns session lease", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-own-"))
    const env = {
      XDG_DATA_HOME: path.join(tmp, "data"),
      XDG_CACHE_HOME: path.join(tmp, "cache"),
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      XDG_STATE_HOME: path.join(tmp, "state"),
      HOME: path.join(tmp, "home"),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_SHARE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    }

    const root = path.resolve(import.meta.dir, "../..")

    const initCode = `
      import { Log } from "./src/util/log.ts"
      import { Instance } from "./src/project/instance.ts"
      import { InstanceBootstrap } from "./src/project/bootstrap.ts"
      import { Session } from "./src/session/index.ts"

      await Log.init({ print: true, level: "ERROR" })
      const sid = await Instance.provide({
        directory: process.cwd(),
        init: InstanceBootstrap,
        fn: async () => (await Session.create({ title: "ownership" })).id,
      })
      console.log(sid)
    `

    const init = await run({
      cwd: root,
      env,
      code: initCode,
    })
    if (init.exitCode !== 0) {
      throw new Error(`init failed: ${init.stderr || init.stdout}`)
    }
    const sessionID = init.stdout.trim().split("\n").at(-1) ?? ""
    expect(sessionID.startsWith("ses_")).toBeTrue()

    const holderCode = `
      import path from "path"
      import fs from "fs/promises"
      import { Global } from "./src/global/index.ts"

      const sid = process.env.SID
      const file = path.join(Global.Path.state, "session-lease", sid + ".json")
      await fs.mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, JSON.stringify({ token: "holder", pid: process.pid, time: Date.now() }))
      await Bun.sleep(1200)
    `

    const holder = Bun.spawn(["bun", "-e", holderCode], {
      cwd: root,
      env: {
        ...process.env,
        ...env,
        SID: sessionID,
      },
    })

    await Bun.sleep(120)

    const promptCode = `
      import { Log } from "./src/util/log.ts"
      import { Instance } from "./src/project/instance.ts"
      import { InstanceBootstrap } from "./src/project/bootstrap.ts"
      import { SessionPrompt } from "./src/session/prompt.ts"
      import { Identifier } from "./src/id/id.ts"

      await Log.init({ print: true, level: "ERROR" })
      const sid = process.env.SID
      try {
        await Instance.provide({
          directory: process.cwd(),
          init: InstanceBootstrap,
          fn: async () =>
            SessionPrompt.prompt({
              sessionID: sid,
              messageID: Identifier.ascending("message"),
              parts: [{ type: "text", text: "hello" }],
              noReply: true,
            }),
        })
        console.log("ok")
      } catch (error) {
        const name = error instanceof Error ? error.name : ""
        console.log(name === "SessionBusyError" ? "busy" : "error")
      }
    `

    const prompt = await run({
      cwd: root,
      env: {
        ...env,
        SID: sessionID,
      },
      code: promptCode,
    })

    await holder.exited

    expect(prompt.exitCode).toBe(0)
    const result = prompt.stdout.trim().split("\n").at(-1) ?? ""
    expect(result).toBe("busy")
  })
})
