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

describe("util.lock cross-process", () => {
  test("serializes storage updates across processes", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-lock-"))
    const env = {
      XDG_DATA_HOME: path.join(tmp, "data"),
      XDG_CACHE_HOME: path.join(tmp, "cache"),
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      XDG_STATE_HOME: path.join(tmp, "state"),
      HOME: path.join(tmp, "home"),
    }

    const root = path.resolve(import.meta.dir, "../..")

    const init = await run({
      cwd: root,
      env,
      code: [
        'import { Log } from "./src/util/log.ts"',
        'import { Storage } from "./src/storage/storage.ts"',
        'await Log.init({ print: true, level: "ERROR" })',
        'await Storage.write(["race", "counter"], { n: 0 })',
      ].join(";"),
    })
    expect(init.exitCode).toBe(0)

    const worker = [
      'import { Log } from "./src/util/log.ts"',
      'import { Storage } from "./src/storage/storage.ts"',
      'await Log.init({ print: true, level: "ERROR" })',
      "for (let i = 0; i < 300; i++) {",
      '  await Storage.update(["race", "counter"], (draft) => { draft.n += 1 })',
      "  if (i % 5 === 0) await Bun.sleep(1)",
      "}",
    ].join(";")

    const [one, two] = await Promise.all([run({ cwd: root, env, code: worker }), run({ cwd: root, env, code: worker })])
    expect(one.exitCode).toBe(0)
    expect(two.exitCode).toBe(0)

    const done = await run({
      cwd: root,
      env,
      code: [
        'import { Log } from "./src/util/log.ts"',
        'import { Storage } from "./src/storage/storage.ts"',
        'await Log.init({ print: true, level: "ERROR" })',
        'const value = await Storage.read(["race", "counter"])',
        "console.log(value.n)",
      ].join(";"),
    })

    expect(done.exitCode).toBe(0)
    const count = Number.parseInt(done.stdout.trim().split("\n").at(-1) ?? "", 10)
    expect(Number.isFinite(count)).toBeTrue()
    expect(count).toBe(600)
  })
})
