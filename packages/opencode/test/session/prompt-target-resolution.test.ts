import { expect, test } from "bun:test"

import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

test("prompt does not livelock when target user is not relevant", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})

      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(session.id).catch(() => {})
        },
      }

      const now = Date.now()
      const userID = Identifier.ascending("message")

      await Session.updateMessage({
        id: userID,
        sessionID: session.id,
        role: "user",
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-4",
        },
        time: { created: now },
      })

      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: userID,
        type: "text",
        text: "seed",
      })

      const seedAssistantID = Identifier.ascending("message")
      await Session.updateMessage({
        id: seedAssistantID,
        sessionID: session.id,
        role: "assistant",
        parentID: userID,
        modelID: "gpt-4",
        providerID: "openai",
        mode: "build",
        agent: "build",
        path: {
          cwd: tmp.path,
          root: tmp.path,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        time: {
          created: now + 1,
          completed: now + 1,
        },
        finish: "stop",
      })

      const run = SessionPrompt.prompt({
        sessionID: session.id,
        parts: [],
      })

      const race = await Promise.race([
        run.then((value) => ({ status: "resolved" as const, value })),
        Bun.sleep(350).then(() => ({ status: "timeout" as const })),
      ])

      if (race.status === "timeout") {
        await Session.remove(session.id).catch(() => {})
        await run.catch(() => {})
      }

      expect(race.status).toBe("resolved")
      if (race.status !== "resolved") return

      expect(race.value.info.role).toBe("assistant")
      expect((race.value.info as MessageV2.Assistant).id).toBe(seedAssistantID)
    },
  })
})
