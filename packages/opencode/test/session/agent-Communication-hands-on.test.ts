import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { SessionMessage } from "../../src/session/message-routing"
import { WaitPolicy } from "../../src/session/wait-policy"
import { SendAgentMessageTool } from "../../src/tool/send-agent-message"
import { WaitAgentMessageTool } from "../../src/tool/wait-agent-message"
import path from "node:path"

const projectRoot = path.join(__dirname, "../..")

const ctxBase = {
  messageID: "msg_test",
  callID: "call_test",
  agent: "test",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async (_req: unknown) => {},
}

describe("Agent Communication - Smoke Tests", () => {
  const created: string[] = []

  afterEach(async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        for (const id of created) {
          WaitPolicy.clear(id)
          SessionMessage.clear(id)
          SessionStatus.set(id, { type: "idle" })
          await Session.remove(id).catch(() => {})
        }
        created.length = 0
      },
    })
  })

  test("Test 1: Simple Echo - Send and Receive", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sender = await Session.create({})
        const receiver = await Session.create({})
        created.push(sender.id, receiver.id)

        // Send message from sender to receiver
        const sendTool = await SendAgentMessageTool.init()
        const sendResult = await sendTool.execute(
          { to: receiver.id, text: "Hello from sender" },
          { ...ctxBase, sessionID: sender.id },
        )

        expect(sendResult.metadata.ok).toBe(true)
        expect(sendResult.metadata.target).toBe(receiver.id)
        expect(sendResult.metadata.seq).toBeDefined()
        const seq = sendResult.metadata.seq!
        expect(seq > 0).toBe(true)
        expect((sendResult.metadata as { deliverySeq?: number }).deliverySeq).toBeUndefined()

        // Verify message was delivered
        const lastSeq = SessionMessage.lastSeq(receiver.id, sender.id)
        expect(lastSeq).toBeGreaterThan(0)
      },
    })
  })

  test("Test 2: Wait for Message with since=-1", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sender = await Session.create({})
        const receiver = await Session.create({})
        created.push(sender.id, receiver.id)

        // Send message first
        const sendTool = await SendAgentMessageTool.init()
        await sendTool.execute(
          { to: receiver.id, text: "Message before wait" },
          { ...ctxBase, messageID: "msg1", callID: "call1", sessionID: sender.id },
        )

        // Now wait with since=-1 (should see message)
        const waitTool = await WaitAgentMessageTool.init()
        const seq = SessionMessage.lastSeq(receiver.id, sender.id)
        const waitResult = await waitTool.execute(
          {
            sources: [sender.id],
            timeout: 5000,
            mode: "any",
            since: -1,
          },
          {
            ...ctxBase,
            messageID: "msg2",
            callID: "call2",
            sessionID: receiver.id,
            extra: {
              waitContext: {
                maxSeqBySource: {
                  [sender.id]: seq,
                },
              },
            },
          },
        )

        expect(waitResult.metadata.ok).toBe(true)
        expect(waitResult.metadata.status).toBe("resolved")
        expect(waitResult.metadata.respondedSources).toEqual([sender.id])

        const policy = WaitPolicy.get(receiver.id)
        expect(policy).toBeUndefined()
      },
    })
  })

  test("Test 3: Wait with checkpoint (only future messages)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sender = await Session.create({})
        const receiver = await Session.create({})
        created.push(sender.id, receiver.id)

        // Send message before wait
        const sendTool = await SendAgentMessageTool.init()
        await sendTool.execute(
          { to: receiver.id, text: "Old message" },
          { ...ctxBase, messageID: "msg1", callID: "call1", sessionID: sender.id },
        )

        // Get current seq position
        const currentSeq = SessionMessage.nowSeq(receiver.id)

        // Wait with since=currentSeq (should NOT see old message)
        const waitTool = await WaitAgentMessageTool.init()
        const waitResult = await waitTool.execute(
          {
            sources: [sender.id],
            timeout: 5000,
            mode: "any",
            since: currentSeq,
          },
          {
            ...ctxBase,
            messageID: "msg2",
            callID: "call2",
            sessionID: receiver.id,
          },
        )

        expect(waitResult.metadata.ok).toBe(true)

        // Evaluate - should NOT be ready yet
        const policy = WaitPolicy.get(receiver.id)
        const responded = SessionMessage.responded({
          to: receiver.id,
          sources: [sender.id],
          since: policy!.since,
        })

        expect(responded.has(sender.id)).toBe(false) // No new messages yet

        // Now send new message
        await sendTool.execute(
          { to: receiver.id, text: "New message" },
          { ...ctxBase, messageID: "msg3", callID: "call3", sessionID: sender.id },
        )

        // Evaluate again - now should be ready
        const responded2 = SessionMessage.responded({
          to: receiver.id,
          sources: [sender.id],
          since: policy!.since,
        })

        expect(responded2.has(sender.id)).toBe(true)
      },
    })
  })

  test("Test 4: Wildcard wait with sources=['*']", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const waiter = await Session.create({})
        const source1 = await Session.create({})
        const source2 = await Session.create({})
        created.push(waiter.id, source1.id, source2.id)

        // Send message from source1
        const sendTool = await SendAgentMessageTool.init()
        await sendTool.execute(
          { to: waiter.id, text: "Message from source1" },
          { ...ctxBase, messageID: "msg1", callID: "call1", sessionID: source1.id },
        )

        // Wait with wildcard
        const waitTool = await WaitAgentMessageTool.init()
        const seq = SessionMessage.lastSeq(waiter.id, source1.id)
        const waitResult = await waitTool.execute(
          {
            sources: ["*"],
            timeout: 5000,
            mode: "any",
            since: -1,
          },
          {
            ...ctxBase,
            messageID: "msg2",
            callID: "call2",
            sessionID: waiter.id,
            extra: {
              waitContext: {
                maxSeqBySource: {
                  [source1.id]: seq,
                },
              },
            },
          },
        )

        expect(waitResult.metadata.ok).toBe(true)
        expect(waitResult.metadata.status).toBe("resolved")
        expect(waitResult.metadata.respondedSources).toContain(source1.id)
        expect(waitResult.metadata.respondedSources).not.toContain(source2.id)

        const policy = WaitPolicy.get(waiter.id)
        expect(policy).toBeUndefined()
      },
    })
  })

  test("Test 5: Mode 'all' requires all sources", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const waiter = await Session.create({})
        const source1 = await Session.create({})
        const source2 = await Session.create({})
        created.push(waiter.id, source1.id, source2.id)

        // Send from source1 only
        const sendTool = await SendAgentMessageTool.init()
        await sendTool.execute(
          { to: waiter.id, text: "From source1" },
          { ...ctxBase, messageID: "msg1", callID: "call1", sessionID: source1.id },
        )

        // Wait for both with mode="all"
        const waitTool = await WaitAgentMessageTool.init()
        await waitTool.execute(
          {
            sources: [source1.id, source2.id],
            timeout: 5000,
            mode: "all",
            since: -1,
          },
          {
            ...ctxBase,
            messageID: "msg2",
            callID: "call2",
            sessionID: waiter.id,
          },
        )

        const policy = WaitPolicy.get(waiter.id)
        const responded = SessionMessage.responded({
          to: waiter.id,
          sources: [source1.id, source2.id],
          since: policy!.since,
        })

        // Should NOT be ready yet (source2 hasn't responded)
        const evaluated = WaitPolicy.evaluate({
          policy: policy!,
          respondedFromSources: responded,
        })

        expect(evaluated.ready).toBe(false)
        expect(evaluated.respondedSources).toEqual([source1.id])
        expect(evaluated.missingSources).toEqual([source2.id])

        // Now send from source2
        await sendTool.execute(
          { to: waiter.id, text: "From source2" },
          { ...ctxBase, messageID: "msg3", callID: "call3", sessionID: source2.id },
        )

        const responded2 = SessionMessage.responded({
          to: waiter.id,
          sources: [source1.id, source2.id],
          since: policy!.since,
        })

        const evaluated2 = WaitPolicy.evaluate({
          policy: policy!,
          respondedFromSources: responded2,
        })

        // Now should be ready
        expect(evaluated2.ready).toBe(true)
        expect(evaluated2.respondedSources).toEqual([source1.id, source2.id])
      },
    })
  })
})

describe("Agent Communication - Complex Tests", () => {
  const created: string[] = []

  afterEach(async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        for (const id of created) {
          WaitPolicy.clear(id)
          SessionMessage.clear(id)
          SessionStatus.set(id, { type: "idle" })
          await Session.remove(id).catch(() => {})
        }
        created.length = 0
      },
    })
  })

  test("Test 6: Fan-out pattern - Wait for multiple sources", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const coordinator = await Session.create({})
        const workers = await Promise.all([Session.create({}), Session.create({}), Session.create({})])
        created.push(coordinator.id, ...workers.map((w) => w.id))

        // All workers send messages
        const sendTool = await SendAgentMessageTool.init()
        await Promise.all(
          workers.map((worker, i) =>
            sendTool.execute(
              { to: coordinator.id, text: `Worker ${i} result` },
              { ...ctxBase, messageID: `msg${i}`, callID: `call${i}`, sessionID: worker.id },
            ),
          ),
        )

        // Wait for all workers
        const waitTool = await WaitAgentMessageTool.init()
        const maxSeqBySource = Object.fromEntries(
          workers.map((worker) => [worker.id, SessionMessage.lastSeq(coordinator.id, worker.id)]),
        )
        const waitResult = await waitTool.execute(
          {
            sources: workers.map((w) => w.id),
            timeout: 5000,
            mode: "all",
            since: -1,
          },
          {
            ...ctxBase,
            messageID: "msg_wait",
            callID: "call_wait",
            sessionID: coordinator.id,
            extra: {
              waitContext: {
                maxSeqBySource,
              },
            },
          },
        )

        expect(waitResult.metadata.ok).toBe(true)
        expect(waitResult.metadata.status).toBe("resolved")
        expect(waitResult.metadata.respondedSources).toHaveLength(3)

        const policy = WaitPolicy.get(coordinator.id)
        expect(policy).toBeUndefined()
      },
    })
  })

  test("Test 7: Multiple messages from same source, seq tracking", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sender = await Session.create({})
        const receiver = await Session.create({})
        created.push(sender.id, receiver.id)

        const sendTool = await SendAgentMessageTool.init()

        // Send multiple messages
        const results: number[] = []
        for (let i = 0; i < 5; i++) {
          const result = await sendTool.execute(
            { to: receiver.id, text: `Message ${i}` },
            { ...ctxBase, messageID: `msg${i}`, callID: `call${i}`, sessionID: sender.id },
          )
          results.push(result.metadata.seq!)
          expect((result.metadata as { deliverySeq?: number }).deliverySeq).toBeUndefined()
        }

        // Verify seq numbers are increasing
        for (let i = 1; i < results.length; i++) {
          expect(results[i]).toBeGreaterThan(results[i - 1])
        }

        // Receiver seq tracks the five delivered messages.
        const lastSeq = SessionMessage.lastSeq(receiver.id, sender.id)
        expect(lastSeq).toBe(5)
      },
    })
  })

  test("Test 8: Timeout behavior", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const waiter = await Session.create({})
        const slowSource = await Session.create({})
        created.push(waiter.id, slowSource.id)

        const shortTimeout = 100 // 100ms

        // Wait with short timeout
        const waitTool = await WaitAgentMessageTool.init()
        const waitResult = await waitTool.execute(
          {
            sources: [slowSource.id],
            timeout: shortTimeout,
            mode: "any",
            since: SessionMessage.checkpoint(waiter.id),
          },
          {
            ...ctxBase,
            messageID: "msg_wait",
            callID: "call_wait",
            sessionID: waiter.id,
          },
        )

        expect(waitResult.metadata.ok).toBe(true)
        expect(waitResult.metadata.deadline).toBeDefined()

        const policy = WaitPolicy.get(waiter.id)
        const deadline = policy!.time.deadline!

        // Wait for timeout + some buffer
        await Bun.sleep(shortTimeout + 50)

        // Now evaluate - should be timed out
        const now = Date.now()
        const responded = SessionMessage.responded({
          to: waiter.id,
          sources: [slowSource.id],
          since: policy!.since,
        })

        const evaluated = WaitPolicy.evaluate({
          policy: policy!,
          now,
          respondedFromSources: responded,
        })

        expect(evaluated.timedOut).toBe(true)
        expect(now).toBeGreaterThanOrEqual(deadline)
      },
    })
  })
})
