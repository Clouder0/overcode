import z from "zod"
import { Identifier } from "@/id/id"
import { Session } from "@/session"
import { SessionMessage } from "@/session/message-routing"
import type { MessageV2 } from "@/session/message-v2"
import { Tool } from "./tool"

type SendMessageMetadata = {
  ok: boolean
  target: string
  error?: string
}

export const SendAgentMessageTool = Tool.define("send_agent_message", {
  description:
    "Send a message to another agent session. Use this to reply to the sender or communicate with other agents.",
  parameters: z.object({
    to: z.string().describe("Target session id (ses_...)"),
    text: z.string().describe("Message content"),
  }),
  async execute(params, ctx) {
    const target = params.to.trim()

    // Validate session ID format
    if (!Identifier.schema("session").safeParse(target).success) {
      const meta: SendMessageMetadata = {
        ok: false,
        target,
        error: `Invalid session id: ${target}`,
      }
      return {
        title: "send_agent_message blocked",
        output: JSON.stringify(meta, null, 2),
        metadata: meta,
      }
    }

    // Verify session exists
    const session = await Session.get(target).catch(() => undefined)
    if (!session) {
      const meta: SendMessageMetadata = {
        ok: false,
        target,
        error: `Unknown session id: ${target}`,
      }
      return {
        title: "send_agent_message blocked",
        output: JSON.stringify(meta, null, 2),
        metadata: meta,
      }
    }

    await SessionMessage.deliver({
      from: ctx.sessionID,
      to: target,
      text: params.text,
    })

    const part: MessageV2.MessagePart = {
      id: Identifier.ascending("part"),
      messageID: ctx.messageID,
      sessionID: ctx.sessionID,
      type: "message",
      direction: "outgoing",
      peer: target,
      peerType: "agent",
      text: params.text,
      time: {
        created: Date.now(),
      },
    }

    await Session.updatePart(part)

    const meta: SendMessageMetadata = {
      ok: true,
      target,
    }

    return {
      title: `Sent to ${target}`,
      output: JSON.stringify(meta, null, 2),
      metadata: meta,
    }
  },
})
