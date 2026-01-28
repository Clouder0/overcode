import { afterEach, describe, expect, mock, test } from "bun:test"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.prompt data: text/plain decode", () => {
  test("decodes base64 payload (not the full data URL)", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(session.id)
          },
        }

        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          noReply: true,
          parts: [
            {
              type: "file",
              url: "data:text/plain;base64,SGVsbG8=",
              filename: "hello.txt",
              mime: "text/plain",
            },
          ],
        })

        const decoded = msg.parts.find((p) => p.type === "text" && p.synthetic && p.text.trim() === "Hello")
        expect(decoded).toBeDefined()
      },
    })
  })
})
