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

    const checkpoint = SessionMessage.checkpoint(ctx.sessionID)

    const sent = await Instance.provide({
      directory: session.directory,
      init: InstanceBootstrap,
      fn: () =>
        SessionMessage.deliver({
          from: ctx.sessionID,
          to: target,
          text: params.text,
          awaitWake: true,
        }),
    })
      .then((value) => ({ ok: true as const, value }))
      .catch((error) => ({ ok: false as const, error }))

    if (!sent.ok) {
      const reason = sent.error instanceof Error ? sent.error.message : String(sent.error)
      const meta: SendMessageMetadata = {
        ok: false,
        target,
        error: `Delivery failed: ${reason}`,
      }
      return {
        title: "send_agent_message blocked",
        output: JSON.stringify(meta, null, 2),
        metadata: meta,
      }
    }

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
          seq: checkpoint,
        },
      },
    }

    await Session.updatePart(part)

    const meta: SendMessageMetadata = {
      ok: true,
      target,
      seq: checkpoint,
    }

    return {
      title: `Sent to ${target}`,
      output:
        `Message delivered to ${target}.\n` +
        `checkpoint seq: ${checkpoint}\n` +
        `Checkpoint seq is your sender-side wait cursor. Incoming replies may not appear in the current model-context snapshot immediately.\n` +
        `Use since=${checkpoint} if you later wait for a reply to this message (use this exact seq, do not add 1).\n` +
        `Sending does not require immediate waiting.\n` +
        `If independent work remains, continue now.\n` +
        `Before ending your turn, if this reply is still required, call wait_agent_message with since=${checkpoint}.\n` +
        `If no follow-up reply is required, continue or end your turn without waiting.`,
      metadata: meta,
    }
  },
})
