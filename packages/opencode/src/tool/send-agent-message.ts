import z from "zod"
import { Identifier } from "@/id/id"
import { Session } from "@/session"
import { SessionMessage } from "@/session/message-routing"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import type { MessageV2 } from "@/session/message-v2"
import { Tool } from "./tool"

type SendMessageMetadata = {
  ok: boolean
  target: string
  seq?: number
  error?: string
}

export const SendAgentMessageTool = Tool.define("send_agent_message", {
  description: "Send a message to another agent session.",
  parameters: z.object({
    to: z.string().describe('Target session id (starts with "ses_")'),
    text: z.string().describe("Message content"),
  }),
  async execute(params, ctx) {
    const target = params.to.trim()

    // Validate session ID format
    if (!Identifier.schema("session").safeParse(target).success) {
      const meta: SendMessageMetadata = {
        ok: false,
        target,
        error: `Invalid session id: ${target}. Use a real session id that starts with "ses_".`,
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
        error: `Unknown session id: ${target}. This tool can only message sessions that exist in the current instance/project.`,
      }
      return {
        title: "send_agent_message blocked",
        output: JSON.stringify(meta, null, 2),
        metadata: meta,
      }
    }

    const delivered = await Instance.provide({
      directory: session.directory,
      init: InstanceBootstrap,
      fn: () =>
        SessionMessage.deliver({
          from: ctx.sessionID,
          to: target,
          text: params.text,
        }),
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
      metadata: {
        opencode: {
          seq: delivered.seq,
        },
      },
    }

    await Session.updatePart(part)

    const meta: SendMessageMetadata = {
      ok: true,
      target,
      seq: delivered.seq,
    }

    return {
      title: `Sent to ${target}`,
      output: `Message delivered to ${target}.\nReminder: wait_agent_message can set a timeout - if the expected reply doesn't arrive in time, you wake with timeout status.`,
      metadata: meta,
    }
  },
})
