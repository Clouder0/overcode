import { expect, test } from "bun:test"

import "../../src/session/prompt"

import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { WaitPolicy } from "../../src/session/wait-policy"
import { tmpdir } from "../fixture/fixture"

test("WaitPolicy timeout can be missed if wall clock goes backward (Date.now is not monotonic)", async () => {
  await using tmp = await tmpdir({ git: true })

  const originalNow = Date.now
  const base = 1_000_000
  let mockNow = base
  Date.now = () => mockNow

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})

        try {
          const timeoutMs = 50
          const policy = WaitPolicy.register({
            sessionID: session.id,
            messageID: "msg_test",
            callID: "call_test",
            sources: [source.id],
            timeout: timeoutMs,
            mode: "all",
          })

          // Real time passes...
          await Bun.sleep(timeoutMs + 50)

          // ...but the wall clock is stuck/backwards, so evaluate() thinks we haven't hit the deadline.
          mockNow = base

          const evaluated = WaitPolicy.evaluate({
            policy,
            pendingFromSources: new Set(),
          })

          // Desired behavior: wait timeouts should be based on elapsed (monotonic) time.
          // Current behavior: timeouts can be missed under clock skew.
          expect(evaluated.timedOut).toBe(true)
        } finally {
          WaitPolicy.clear(session.id)
          WaitPolicy.clear(source.id)
          await Session.remove(source.id)
          await Session.remove(session.id)
        }
      },
    })
  } finally {
    Date.now = originalNow
  }
})

test("Instance AsyncLocalStorage context survives setTimeout callbacks", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let observed: string | undefined
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          observed = Instance.directory
          resolve()
        }, 10)
      })

      expect(observed).toBe(tmp.path)
    },
  })
})
