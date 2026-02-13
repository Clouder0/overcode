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

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  return {
    stdout,
    stderr,
    exitCode,
  }
}

function script(mode: "body" | "fetch") {
  return `
const mode = ${JSON.stringify(mode)}
const unhandled = []

process.on("unhandledRejection", (error) => {
  const message = error instanceof Error ? error.message : String(error)
  unhandled.push(message)
  console.error("UNHANDLED", message)
})

const server = Bun.serve({
  port: 0,
  async fetch() {
    if (mode === "fetch") {
      await Bun.sleep(200)
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    }

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'))
      },
    })

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    })
  },
})

const originalTimeout = AbortSignal.timeout
Object.defineProperty(AbortSignal, "timeout", {
  configurable: true,
  value(ms) {
    return originalTimeout(Math.min(ms, 75))
  },
})

process.env.OPENCODE_MODELS_URL = server.url.toString().replace(/\\\/$/, "")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "false"

await import("./src/provider/models.ts")
await Bun.sleep(300)

server.stop(true)

console.log("UNHANDLED_COUNT", unhandled.length)
process.exit(unhandled.length > 0 ? 1 : 0)
`
}

describe("models refresh timeout handling", () => {
  test("does not produce unhandled rejection when response body stalls", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-models-timeout-"))
    const root = path.resolve(import.meta.dir, "../..")
    const env = {
      XDG_DATA_HOME: path.join(tmp, "data"),
      XDG_CACHE_HOME: path.join(tmp, "cache"),
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      XDG_STATE_HOME: path.join(tmp, "state"),
      HOME: path.join(tmp, "home"),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "false",
    }

    const result = await run({
      cwd: root,
      env,
      code: script("body"),
    })

    if (result.exitCode !== 0) {
      throw new Error(`child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("UNHANDLED_COUNT 0")
    expect(result.stderr).not.toContain("UNHANDLED")
  })

  test("does not produce unhandled rejection when request times out before response", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-models-timeout-"))
    const root = path.resolve(import.meta.dir, "../..")
    const env = {
      XDG_DATA_HOME: path.join(tmp, "data"),
      XDG_CACHE_HOME: path.join(tmp, "cache"),
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      XDG_STATE_HOME: path.join(tmp, "state"),
      HOME: path.join(tmp, "home"),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "false",
    }

    const result = await run({
      cwd: root,
      env,
      code: script("fetch"),
    })

    if (result.exitCode !== 0) {
      throw new Error(`child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("UNHANDLED_COUNT 0")
    expect(result.stderr).not.toContain("UNHANDLED")
  })
})
