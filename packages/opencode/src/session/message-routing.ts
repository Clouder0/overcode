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
  let wakeSessionFn: ((message: Message) => void) | undefined

  export function setWakeSessionFn(fn: (message: Message) => void) {
    wakeSessionFn = fn
  }

  export const Message = z.object({
    id: z.string(),
    from: z.string(),
    to: z.string(),
    text: z.string(),
    time: z.number(),
    messageType: z.enum(["normal", "timeout", "error"]).default("normal"),
  })
  export type Message = z.infer<typeof Message>

  export const Event = {
    Delivered: BusEvent.define(
      "session.message.delivered",
      z.object({
        message: Message,
      }),
    ),
  }

  const MAX_PENDING_PER_SESSION = 200

  const pendingState = Instance.state(
    () => new Map<string, Message[]>(),
    async (map) => map.clear(),
  )

  export async function deliver(input: {
    from: string
    to: string
    text: string
    messageType?: "normal" | "timeout" | "error"
  }): Promise<Message> {
    const message: Message = {
      id: Identifier.ascending("message"),
      from: input.from,
      to: input.to,
      text: input.text,
      time: Date.now(),
      messageType: input.messageType ?? "normal",
    }

    log.info("delivering message", { from: message.from, to: message.to })

    // Add to pending queue
    const pending = pendingState()
    const queue = pending.get(message.to) ?? []
    queue.push(message)

    if (queue.length > MAX_PENDING_PER_SESSION) {
      queue.splice(0, queue.length - MAX_PENDING_PER_SESSION)
    }

    pending.set(message.to, queue)

    // Wake up dormant session to process the message
    if (wakeSessionFn) {
      wakeSessionFn(message)
    }

    Bus.publish(Event.Delivered, { message })
    return message
  }

  export function pending(sessionID: string): Message[] {
    const pending = pendingState()
    const queue = pending.get(sessionID) ?? []
    pending.set(sessionID, [])
    return queue
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
  }
}
