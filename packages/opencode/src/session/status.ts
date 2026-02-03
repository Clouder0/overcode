import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import z from "zod"

export namespace SessionStatus {
  export const Info = z
    .union([
      z.object({
        type: z.literal("idle"),
      }),
      z.object({
        type: z.literal("retry"),
        attempt: z.number(),
        message: z.string(),
        next: z.number(),
      }),
      z.object({
        type: z.literal("busy"),
      }),
      z.object({
        type: z.literal("waiting"),
        sources: z.array(z.string()),
        timeout: z.number(),
        mode: z.enum(["all", "any"]),
        // Baseline cursor used for this wait (numeric seq).
        since: z.number().optional(),
        time: z.object({
          created: z.number(),
          deadline: z.number().optional(),
        }),
      }),
    ])
    .meta({
      ref: "SessionStatus",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Status: BusEvent.define(
      "session.status",
      z.object({
        sessionID: z.string(),
        status: Info,
      }),
    ),
    // deprecated
    Idle: BusEvent.define(
      "session.idle",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  type Subscriber = (event: { sessionID: string; status: Info }) => void
  const subscribers: Subscriber[] = []

  export function subscribe(fn: Subscriber) {
    subscribers.push(fn)
    return () => {
      const idx = subscribers.indexOf(fn)
      if (idx === -1) return
      subscribers.splice(idx, 1)
    }
  }

  const state = Instance.state(() => {
    const data: Record<string, Info> = {}
    return data
  })

  export function get(sessionID: string) {
    return (
      state()[sessionID] ?? {
        type: "idle",
      }
    )
  }

  export function list() {
    return state()
  }

  export function set(sessionID: string, status: Info) {
    for (const sub of subscribers) {
      sub({ sessionID, status })
    }

    Bus.publish(Event.Status, {
      sessionID,
      status,
    })

    if (status.type === "idle") {
      // deprecated
      Bus.publish(Event.Idle, {
        sessionID,
      })
      delete state()[sessionID]
      return
    }
    state()[sessionID] = status
  }
}
