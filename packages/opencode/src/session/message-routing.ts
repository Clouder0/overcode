import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"

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

  const pendingMessages = new Map<string, Message[]>()

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
    const queue = pendingMessages.get(message.to) ?? []
    queue.push(message)
    pendingMessages.set(message.to, queue)

    // Wake up dormant session to process the message
    if (wakeSessionFn) {
      wakeSessionFn(message)
    }

    Bus.publish(Event.Delivered, { message })
    return message
  }

  export function pending(sessionID: string): Message[] {
    const queue = pendingMessages.get(sessionID) ?? []
    pendingMessages.set(sessionID, [])
    return queue
  }

  export function takePending(sessionID: string, predicate: (message: Message) => boolean): Message[] {
    const queue = pendingMessages.get(sessionID) ?? []
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

    pendingMessages.set(sessionID, remaining)
    return taken
  }

  export function hasPending(sessionID: string): boolean {
    const queue = pendingMessages.get(sessionID)
    return queue !== undefined && queue.length > 0
  }

  export function peekPending(sessionID: string): Message[] {
    return pendingMessages.get(sessionID) ?? []
  }

  export function subscribe(sessionID: string, callback: (message: Message) => void): () => void {
    return Bus.subscribe(Event.Delivered, (event) => {
      if (event.properties.message.to === sessionID) {
        callback(event.properties.message)
      }
    })
  }

  export function clear(sessionID: string): void {
    pendingMessages.delete(sessionID)
  }
}
