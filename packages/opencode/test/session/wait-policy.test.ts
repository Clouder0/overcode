import { beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { WaitPolicy } from "../../src/session/wait-policy"

const projectRoot = path.join(__dirname, "../..")

const withinInstance = <T>(fn: () => T | Promise<T>) =>
  Instance.provide({
    directory: projectRoot,
    fn,
  })

beforeEach(async () => {
  await withinInstance(() => {
    WaitPolicy.clear("wait_all")
    WaitPolicy.clear("wait_any")
    WaitPolicy.clear("wait_timeout")
  })
})

test("evaluate() all mode requires all sources", async () => {
  await withinInstance(() => {
    const policy = WaitPolicy.register({
      sessionID: "wait_all",
      messageID: "msg",
      callID: "call",
      sources: ["a", "b"],
      timeout: 0,
      mode: "all",
    })

    const partial = WaitPolicy.evaluate({
      policy,
      now: policy.time.created,
      pendingFromSources: new Set(["a"]),
    })
    expect(partial.ready).toBe(false)
    expect(partial.timedOut).toBe(false)

    const full = WaitPolicy.evaluate({
      policy,
      now: policy.time.created,
      pendingFromSources: new Set(["a", "b"]),
    })
    expect(full.ready).toBe(true)
    expect(full.timedOut).toBe(false)
  })
})

test("evaluate() any mode resolves immediately on first response", async () => {
  await withinInstance(() => {
    const policy = WaitPolicy.register({
      sessionID: "wait_any",
      messageID: "msg",
      callID: "call",
      sources: ["a", "b"],
      timeout: 0,
      mode: "any",
    })

    const result = WaitPolicy.evaluate({
      policy,
      now: policy.time.created,
      pendingFromSources: new Set(["a"]),
    })

    expect(result.ready).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.respondedSources).toEqual(["a"])
    expect(result.missingSources).toEqual(["b"])
  })
})

test("register() timeout wakes via callback", async () => {
  await withinInstance(async () => {
    let wakes = 0
    WaitPolicy.setWakeFn(() => {
      wakes++
    })

    WaitPolicy.register({
      sessionID: "wait_timeout",
      messageID: "msg",
      callID: "call",
      sources: ["a"],
      timeout: 30,
      mode: "all",
    })

    await Bun.sleep(60)
    expect(wakes).toBe(1)

    WaitPolicy.clear("wait_timeout")
  })
})
