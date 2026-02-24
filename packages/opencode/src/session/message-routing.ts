import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"

export namespace SessionMessage {
  const log = Log.create({ service: "session-message" })

  // Callback invoked when a message is delivered.
  // Set by prompt.ts to avoid circular dependency.
  let wakeSessionFn: ((message: Message) => void | Promise<void>) | undefined

  export function setWakeSessionFn(fn: ((message: Message) => void | Promise<void>) | undefined) {
    const prev = wakeSessionFn
    wakeSessionFn = fn
    return prev
  }

  export const Message = z.object({
    id: z.string(),
    seq: z.number().int().nonnegative(),
    from: z.string(),
    to: z.string(),
    text: z.string(),
    time: z.number(),
    messageType: z.enum(["normal", "timeout", "error", "wait_result", "notice"]).default("normal"),
  })
  export type Message = z.infer<typeof Message>

  export const Event = {
    Delivered: BusEvent.define(
      "session.message.delivered",
      z.object({
        message: Message,
      }),
    ),
    Overflow: BusEvent.define(
      "session.message.overflow",
      z.object({
        to: z.string(),
        droppedCount: z.number().int().positive(),
        droppedIDs: z.array(z.string()),
        maxPending: z.number().int().positive(),
      }),
    ),
  }

  const MAX_PENDING_PER_SESSION = 200

  const pendingState = Instance.state(
    () => new Map<string, Message[]>(),
    async (map) => map.clear(),
  )

  const seqState = Instance.state(
    () => new Map<string, number>(),
    async (map) => map.clear(),
  )

  const inboxState = Instance.state(
    () => new Map<string, Map<string, number>>(),
    async (map) => map.clear(),
  )

  const durableState = Instance.state(
    () => new Map<string, Map<string, number>>(),
    async (map) => map.clear(),
  )

  function sessionID(value: string) {
    return Identifier.schema("session").safeParse(value).success
  }

  export function nowSeq(sessionID: string) {
    return seqState().get(sessionID) ?? 0
  }

  export function nextSeq(sessionID: string) {
    const next = nowSeq(sessionID) + 1
    seqState().set(sessionID, next)
    return next
  }

  // Reserve a non-zero checkpoint in the caller session's seq space.
  export function checkpoint(sessionID: string) {
    return nextSeq(sessionID)
  }

  export function lastSeq(to: string, from: string) {
    return inboxState().get(to)?.get(from) ?? 0
  }

  export function anyAfter(to: string, since: number) {
    const froms = inboxState().get(to)
    if (!froms) return false
    for (const seq of froms.values()) {
      if (seq > since) return true
    }
    return false
  }

  export function responded(input: { to: string; sources: string[]; since: number }) {
    const wildcard = input.sources.length === 1 && input.sources[0] === "*"

    if (wildcard) {
      const froms = inboxState().get(input.to)
      if (!froms) return new Set<string>()

      const result = new Set<string>()
      for (const [from, seq] of froms.entries()) {
        if (!sessionID(from)) continue
        if (seq > input.since) {
          result.add(from)
        }
      }
      return result
    }

    const result = new Set<string>()
    for (const from of input.sources) {
      if (lastSeq(input.to, from) > input.since) {
        result.add(from)
      }
    }
    return result
  }

  function durableSeq(to: string, from: string) {
    return durableState().get(to)?.get(from) ?? 0
  }

  function pendingAfter(to: string, from: string, since: number) {
    const queue = pendingState().get(to)
    if (!queue) return false
    for (const msg of queue) {
      if (msg.from !== from) continue
      if (msg.messageType === "notice") continue
      if (msg.seq > since) return true
    }
    return false
  }

  export function respondedRecoverable(input: { to: string; sources: string[]; since: number }) {
    const wildcard = input.sources.length === 1 && input.sources[0] === "*"

    if (wildcard) {
      const result = new Set<string>()

      const durable = durableState().get(input.to)
      if (durable) {
        for (const [from, seq] of durable.entries()) {
          if (!sessionID(from)) continue
          if (seq > input.since) result.add(from)
        }
      }

      const queue = pendingState().get(input.to)
      if (!queue) return result

      for (const msg of queue) {
        if (!sessionID(msg.from)) continue
        if (msg.messageType === "notice") continue
        if (msg.seq <= input.since) continue
        result.add(msg.from)
      }

      return result
    }

    const result = new Set<string>()
    for (const from of input.sources) {
      if (durableSeq(input.to, from) > input.since || pendingAfter(input.to, from, input.since)) {
        result.add(from)
      }
    }
    return result
  }

  export function markDurable(message: Message) {
    if (message.messageType === "notice") return
    const durable = durableState()
    const byFrom = durable.get(message.to) ?? new Map<string, number>()
    const prev = byFrom.get(message.from) ?? 0
    if (message.seq > prev) {
      byFrom.set(message.from, message.seq)
    }
    durable.set(message.to, byFrom)
  }

  export async function deliver(input: {
    from: string
    to: string
    text: string
    messageType?: "normal" | "timeout" | "error" | "wait_result" | "notice"
    awaitWake?: boolean
  }): Promise<Message> {
    const message: Message = {
      id: Identifier.ascending("message"),
      seq: nextSeq(input.to),
      from: input.from,
      to: input.to,
      text: input.text,
      time: Date.now(),
      messageType: input.messageType ?? "normal",
    }

    if (message.messageType !== "notice") {
      const inbox = inboxState()
      const byFrom = inbox.get(message.to) ?? new Map<string, number>()
      const prev = byFrom.get(message.from) ?? 0
      if (message.seq > prev) {
        byFrom.set(message.from, message.seq)
      }
      inbox.set(message.to, byFrom)
    }

    log.info("delivering message", { from: message.from, to: message.to })

    // Add to pending queue
    const pending = pendingState()
    const queue = pending.get(message.to) ?? []
    queue.push(message)

    if (queue.length > MAX_PENDING_PER_SESSION) {
      const dropped = queue.splice(0, queue.length - MAX_PENDING_PER_SESSION)
      log.warn("pending queue overflow", {
        to: message.to,
        droppedCount: dropped.length,
        maxPending: MAX_PENDING_PER_SESSION,
      })
      Bus.publish(Event.Overflow, {
        to: message.to,
        droppedCount: dropped.length,
        droppedIDs: dropped.map((item) => item.id),
        maxPending: MAX_PENDING_PER_SESSION,
      })
    }

    pending.set(message.to, queue)

    // Wake up dormant session to process the message
    if (wakeSessionFn) {
      const wake = wakeSessionFn(message)
      if (input.awaitWake === true) {
        await wake
      } else {
        Promise.resolve(wake).catch((error) => {
          log.error("failed to run wake callback", {
            to: message.to,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
    }

    Bus.publish(Event.Delivered, { message })
    return message
  }

  export function takePending(sessionID: string, predicate: (message: Message) => boolean): Message[] {
    const pending = pendingState()
    const queue = pending.get(sessionID) ?? []
    if (queue.length === 0) return []

    const taken: Message[] = []
    const remaining: Message[] = []

    for (const msg of queue) {
      if (predicate(msg)) {
        taken.push(msg)
        continue
      }
      remaining.push(msg)
    }

    pending.set(sessionID, remaining)
    return taken
  }

  export function hasPending(sessionID: string): boolean {
    const queue = pendingState().get(sessionID)
    return queue !== undefined && queue.length > 0
  }

  export function peekPending(sessionID: string): Message[] {
    return pendingState().get(sessionID) ?? []
  }

  export function subscribe(sessionID: string, callback: (message: Message) => void): () => void {
    return Bus.subscribe(Event.Delivered, (event) => {
      if (event.properties.message.to === sessionID) {
        callback(event.properties.message)
      }
    })
  }

  export function clear(sessionID: string): void {
    pendingState().delete(sessionID)

    const inbox = inboxState()
    inbox.delete(sessionID)

    for (const byFrom of inbox.values()) {
      byFrom.delete(sessionID)
    }

    const durable = durableState()
    durable.delete(sessionID)

    seqState().delete(sessionID)

    for (const byFrom of durable.values()) {
      byFrom.delete(sessionID)
    }
  }
}
