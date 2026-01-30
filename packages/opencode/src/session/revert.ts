import z from "zod"
import { Identifier } from "../id/id"
import { Snapshot } from "../snapshot"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Log } from "../util/log"
import { splitWhen } from "remeda"
import { Storage } from "../storage/storage"
import { Bus } from "../bus"
import { SessionPrompt } from "./prompt"
import { SessionMessage } from "./message-routing"
import { SessionCPD } from "./cpd"

export namespace SessionRevert {
  const log = Log.create({ service: "session.revert" })

  export const RevertInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message"),
    partID: Identifier.schema("part").optional(),
  })
  export type RevertInput = z.infer<typeof RevertInput>

  export async function revert(input: RevertInput) {
    SessionPrompt.assertNotBusy(input.sessionID)
    SessionMessage.clear(input.sessionID)
    const all = await Session.messages({ sessionID: input.sessionID })
    let lastUser: MessageV2.User | undefined
    const session = await Session.get(input.sessionID)

    let revert: Session.Info["revert"]
    const patches: Snapshot.Patch[] = []
    for (const msg of all) {
      if (
        msg.info.role === "user" &&
        msg.parts.some((part) => {
          if (part.type === "text") return part.synthetic !== true && part.ignored !== true
          if (part.type === "file") return true
          if (part.type === "agent") return true
          return false
        })
      ) {
        lastUser = msg.info
      }
      const remaining = []
      for (const part of msg.parts) {
        if (revert) {
          if (part.type === "patch") {
            patches.push(part)
          }
          continue
        }

        if (!revert) {
          if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
            // if no useful parts left in message, same as reverting whole message
            const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
            revert = {
              messageID: !partID && lastUser ? lastUser.id : msg.info.id,
              partID,
            }
          }
          remaining.push(part)
        }
      }
    }

    if (revert) {
      const session = await Session.get(input.sessionID)
      revert.snapshot = session.revert?.snapshot ?? (await Snapshot.track())
      await Snapshot.revert(patches)
      if (revert.snapshot) revert.diff = await Snapshot.diff(revert.snapshot)
      return Session.update(input.sessionID, (draft) => {
        draft.revert = revert
      })
    }
    return session
  }

  export async function unrevert(input: { sessionID: string }) {
    log.info("unreverting", input)
    SessionPrompt.assertNotBusy(input.sessionID)
    const session = await Session.get(input.sessionID)
    if (!session.revert) return session
    if (session.revert.snapshot) await Snapshot.restore(session.revert.snapshot)
    const next = await Session.update(input.sessionID, (draft) => {
      draft.revert = undefined
    })
    return next
  }

  export async function cleanup(session: Session.Info) {
    if (!session.revert) return
    const sessionID = session.id

    const cpd = await SessionCPD.get(sessionID)

    SessionMessage.clear(sessionID)
    let msgs = await Session.messages({ sessionID })
    const messageID = session.revert.messageID

    const split = (() => {
      const idx = msgs.findIndex((x) => x.info.id === messageID)
      if (idx === -1) {
        return {
          preserve: msgs,
          remove: [] as MessageV2.WithParts[],
        }
      }

      const boundary = session.revert.partID ? idx + 1 : idx
      return {
        preserve: msgs.slice(0, boundary),
        remove: msgs.slice(boundary),
      }
    })()

    const preserve = split.preserve
    const remove = split.remove
    msgs = preserve
    for (const msg of remove) {
      const parts = await Storage.list(["part", msg.info.id]).catch(() => [])
      await Promise.all(parts.map((key) => Storage.remove(key).catch(() => {})))

      await Storage.remove(["message", sessionID, msg.info.id])
      await Bus.publish(MessageV2.Event.Removed, { sessionID: sessionID, messageID: msg.info.id })
    }
    const last = preserve.at(-1)
    if (session.revert.partID && last) {
      const partID = session.revert.partID
      const [preserveParts, removeParts] = splitWhen(last.parts, (x) => x.id === partID)
      last.parts = preserveParts
      for (const part of removeParts) {
        await Storage.remove(["part", last.info.id, part.id])
        await Bus.publish(MessageV2.Event.PartRemoved, {
          sessionID: sessionID,
          messageID: last.info.id,
          partID: part.id,
        })
      }
    }

    const opencode = (meta: unknown) => {
      if (!meta || typeof meta !== "object") return
      const base = meta as Record<string, unknown>
      const value = base.opencode
      if (!value || typeof value !== "object") return
      return value as Record<string, unknown>
    }

    const kind = (part: { metadata?: unknown }) => {
      const meta = opencode(part.metadata)
      const marker = meta?.marker
      if (!marker || typeof marker !== "object") return
      const record = marker as Record<string, unknown>
      const value = record.kind
      if (typeof value !== "string") return
      return value
    }

    const omitted = (part: MessageV2.Part) => {
      if (part.type !== "reasoning") return
      if (part.ignored !== true) return
      const meta = opencode(part.metadata)
      const value = meta?.reason
      if (typeof value !== "string") return
      return value
    }

    const think = msgs.some((msg) => msg.parts.some((part) => kind(part) === "think" || omitted(part) === "context_limit"))
    const rctx = msgs.some((msg) =>
      msg.parts.some((part) => kind(part) === "rctx" || omitted(part) === "provider_rejected_reasoning_context"),
    )

    const flags = {
      trim: msgs.some((msg) =>
        msg.parts.some((part) => {
          if (part.type !== "tool") return false
          if (part.state.status !== "completed") return false
          return !!part.state.time.compacted
        }),
      ),
      think,
      rctx,
    }

    await SessionCPD.flag(sessionID, flags)

    const invalid = cpd && cpd.upto >= messageID
    if (invalid) {
      await SessionCPD.clear(sessionID)
    }

    await Session.update(sessionID, (draft) => {
      draft.revert = undefined
    })
  }
}
