import path from "path"
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session prompt_async route", () => {
  test("uses noReply mode and schedules loop", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const result = {
          info: {
            id: "msg_placeholder",
            role: "assistant",
            sessionID: session.id,
            parentID: "msg_parent",
            modelID: "dummy",
            providerID: "dummy",
            mode: "build",
            agent: "build",
            path: { cwd: projectRoot, root: projectRoot },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            time: { created: Date.now(), completed: Date.now() },
            finish: "end_turn",
          },
          parts: [],
        } as MessageV2.WithParts

        const promptSpy = spyOn(SessionPrompt, "prompt").mockResolvedValue(result)
        const loopSpy = spyOn(SessionPrompt, "loop").mockResolvedValue(result)

        const response = await app.request(`/session/${session.id}/prompt_async`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({
            mode: "build",
            model: { providerID: "openrouter", modelID: "openai/gpt-5" },
            parts: [{ type: "text", text: "ping" }],
          }),
        })

        expect(response.status).toBe(204)
        expect(promptSpy).toHaveBeenCalledTimes(1)
        expect(promptSpy.mock.calls[0]?.[0].noReply).toBe(true)
        expect(loopSpy).toHaveBeenCalledTimes(1)
        expect(loopSpy.mock.calls[0]?.[0]).toBe(session.id)

        promptSpy.mockRestore()
        loopSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("does not leak stack traces from unknown server errors", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const response = await app.request(`/session/${session.id}/message/msg_path/part/part_path`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({
            id: "part_body",
            sessionID: "session_mismatch",
            messageID: "msg_mismatch",
            type: "text",
            text: "mismatch",
          }),
        })

        const message = await response.text()
        expect(response.status).toBe(500)
        expect(message).toContain("Part mismatch")
        expect(message).not.toContain("Error: Part mismatch")
        expect(message).not.toContain("\n    at")
        await Session.remove(session.id)
      },
    })
  })
})
