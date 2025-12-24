import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { Session } from "./index"
import { Log } from "@/util/log"
import { MessageWait } from "./message-wait"

export namespace SessionMessage {
  const log = Log.create({ service: "session-message" })

  // Register the peekPending function with MessageWait to avoid circular dependency
  // This is called when this module loads
  MessageWait.setPeekPendingFn((sessionID) => peekPending(sessionID))

  // Callback to wake dormant sessions - set by prompt.ts to avoid circular dependency
  let wakeSessionFn: ((sessionID: string) => void) | undefined

  export function setWakeSessionFn(fn: (sessionID: string) => void) {
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

    if (message.to === "human") {
      Bus.publish(Event.Delivered, { message })
      return message
    }

    // Check if the target session is waiting for messages from this source
    // This integrates the message delivery with the wait system
    const handled = MessageWait.onMessage(message.to, message.from, message.text)
    if (handled) {
      log.info("message handled by wait system", { from: message.from, to: message.to })
    }

    // Always add to pending queue for normal processing
    const queue = pendingMessages.get(message.to) ?? []
    queue.push(message)
    pendingMessages.set(message.to, queue)

    // Wake up dormant session to process the message
    // This allows subagents to receive follow-up messages after completing their initial task
    if (wakeSessionFn) {
      wakeSessionFn(message.to)
    }

    Bus.publish(Event.Delivered, { message })
    return message
  }

  export function pending(sessionID: string): Message[] {
    const queue = pendingMessages.get(sessionID) ?? []
    pendingMessages.set(sessionID, [])
    return queue
  }

  export function hasPending(sessionID: string): boolean {
    const queue = pendingMessages.get(sessionID)
    return queue !== undefined && queue.length > 0
  }

  export function peekPending(sessionID: string): Message[] {
    return pendingMessages.get(sessionID) ?? []
  }

  export async function resolveTarget(to: string, fromSessionID: string): Promise<string> {
    if (to === "human") return "human"

    if (to === "caller") {
      const session = await Session.get(fromSessionID)
      if (session.callerID) return session.callerID
      return "human"
    }

    return to
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
