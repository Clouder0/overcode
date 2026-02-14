import { expect, test } from "bun:test"
import path from "path"

test("cancel(force:false) keeps loop ownership until unwind", async () => {
  const root = path.resolve(import.meta.dir, "../..")

  const code = `
    import { Log } from "./src/util/log.ts"
    import { tmpdir } from "./test/fixture/fixture.ts"
    import { Instance } from "./src/project/instance.ts"
    import { Session } from "./src/session/index.ts"
    import { SessionPrompt } from "./src/session/prompt.ts"
    import { SessionProcessor } from "./src/session/processor.ts"
    import { Provider } from "./src/provider/provider.ts"
    import { Identifier } from "./src/id/id.ts"

    await Log.init({ print: false })

    const tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const userID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userID,
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userID,
          sessionID: session.id,
          type: "text",
          text: "go",
        })

        const model = Provider.getModel
        Provider.getModel = (async () => ({
          id: "dummy",
          providerID: "dummy",
          modelID: "dummy",
          api: { id: "dummy", url: "", npm: "@ai-sdk/openai-compatible" },
          limit: { context: 8192, output: 2048 },
        })) as any

        const create = SessionProcessor.create
        let running = 0
        let maxRunning = 0
        let calls = 0

        SessionProcessor.create = ((args) => ({
          message: args.assistantMessage,
          compactionRequest: undefined,
          waitSince() {
            return 0
          },
          partFromToolCall() {
            return undefined
          },
          async process() {
            calls++
            running++
            if (running > maxRunning) maxRunning = running
            await Bun.sleep(300)
            const message = args.assistantMessage
            message.finish = "end_turn"
            message.time.completed = Date.now()
            await Session.updatePart({
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: message.id,
              type: "text",
              text: "ok",
            })
            await Session.updateMessage(message)
            running--
            return "stop"
          },
        })) as any

        const first = SessionPrompt.loop(session.id).catch(() => undefined)
        await Bun.sleep(30)
        SessionPrompt.cancel(session.id, { force: false })
        const second = SessionPrompt.loop(session.id).catch(() => undefined)

        await Promise.allSettled([first, second])
        console.log(JSON.stringify({ calls, maxRunning }))

        SessionProcessor.create = create
        Provider.getModel = model as any
      },
    })

    await tmp[Symbol.asyncDispose]()
  `

  const proc = Bun.spawn(["bun", "-e", code], {
    cwd: root,
    env: {
      ...process.env,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_SHARE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  expect(stderr).toBe("")
  expect(exitCode).toBe(0)

  const line = stdout
    .trim()
    .split("\n")
    .findLast((item) => item.startsWith("{"))

  expect(line).toBeDefined()
  if (!line) return

  const result = JSON.parse(line) as {
    calls: number
    maxRunning: number
  }

  expect(result.calls).toBe(1)
  expect(result.maxRunning).toBe(1)
})
