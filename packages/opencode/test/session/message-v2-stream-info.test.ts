import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  mock.restore()
})

test("streamInfo yields newest-first infos without hydrating parts", async () => {
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

      const ids = [] as string[]
      for (const text of ["first", "second", "third"]) {
        const id = Identifier.ascending("message")
        ids.push(id)
        await Session.updateMessage({
          id,
          sessionID: session.id,
          role: "user",
          agent: "build",
          model: {
            providerID: "dummy",
            modelID: "dummy",
          },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: id,
          type: "text",
          text,
        })
      }

      const expected = (await Array.fromAsync(MessageV2.stream(session.id))).map((item) => item.info.id)
      const partsSpy = spyOn(MessageV2, "parts")
      const infos = (await Array.fromAsync(MessageV2.streamInfo(session.id))) as MessageV2.Info[]

      expect(infos.map((item) => item.id)).toEqual(expected)
      expect(partsSpy).not.toHaveBeenCalled()
      expect(infos.map((item) => item.id)).toEqual(ids.slice().reverse())
    },
  })
})
