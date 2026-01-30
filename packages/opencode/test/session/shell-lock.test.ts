import path from "path"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.shell lock", () => {
  test("releases prompt-loop lock after completion", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        await SessionPrompt.shell({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          command: "echo ok",
        })

        // If the previous shell left the session lock stuck, this would throw BusyError.
        await SessionPrompt.shell({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          command: "echo ok2",
        })

        await Session.remove(session.id)
      },
    })
  })
})
