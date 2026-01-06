import z from "zod"
import { Identifier } from "@/id/id"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { WaitPolicy } from "@/session/wait-policy"
import { Tool } from "./tool"

type WaitMessageStatus = "blocked" | "waiting" | "resolved" | "timedOut" | "interrupted"

type WaitMessageMetadata = {
  ok: boolean
  status: WaitMessageStatus
  sources: string[]
  respondedSources: string[]
  timedOutSources: string[]
  timeout: number
  mode: "all" | "any"
  allReceived: boolean
  createdAt?: number
  deadline?: number
  interruptedAt?: number
  interruptedBy?: "prompt" | "abort"
  error?: string
}

export const WaitAgentMessageTool = Tool.define("wait_agent_message", {
  description: "Wait for messages from specified agent sessions. After calling, end your turn immediately.",
  parameters: z.object({
    sources: z.array(z.string()).describe("Session ids to wait for (ses_...)"),
    timeout: z.coerce.number().min(1).describe("Timeout in milliseconds"),
    mode: z.enum(["all", "any"]).describe('"all" waits for every source, "any" waits for first response'),
  }),
  async execute(params, ctx) {
    const rawSources = params.sources.map((s) => s.trim()).filter(Boolean)

    const blocked = (error: string, sources: string[] = rawSources) => {
      const meta: WaitMessageMetadata = {
        ok: false,
        status: "blocked",
        sources,
        respondedSources: [],
        timedOutSources: [],
        timeout: params.timeout,
        mode: params.mode,
        allReceived: false,
        error,
      }

      return {
        title: "wait_agent_message blocked",
        output: JSON.stringify(meta, null, 2),
        metadata: meta,
      }
    }

    if (rawSources.length === 0) {
      return blocked("sources must be a non-empty array of session ids (ses_...)")
    }

    const MAX_TIMEOUT_MS = 2_147_483_647
    if (params.timeout > MAX_TIMEOUT_MS) {
      return blocked(`timeout must be <= ${MAX_TIMEOUT_MS}`)
    }

    // Validate all sources are valid session IDs
    const invalid = rawSources.filter((s) => !Identifier.schema("session").safeParse(s).success)
    if (invalid.length > 0) {
      return blocked(`Invalid session id(s): ${Array.from(new Set(invalid)).join(", ")}`)
    }

    const sources = Array.from(new Set(rawSources))
    if (sources.length !== rawSources.length) {
      return blocked("sources must not contain duplicates", sources)
    }

    const sessions = await Promise.all(sources.map((id) => Session.get(id).catch(() => undefined)))
    const missing = sources.filter((_, i) => !sessions[i])
    if (missing.length > 0) {
      return blocked(`Unknown session id(s): ${missing.join(", ")}`, sources)
    }

    if (!ctx.callID) {
      return blocked("Internal error: missing tool call id")
    }

    const policy = WaitPolicy.register({
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      sources,
      timeout: params.timeout,
      mode: params.mode,
    })

    SessionStatus.set(ctx.sessionID, {
      type: "waiting",
      sources,
      timeout: params.timeout,
      mode: params.mode,
      time: policy.time,
    })

    const meta: WaitMessageMetadata = {
      ok: true,
      status: "waiting",
      sources,
      respondedSources: [],
      timedOutSources: [],
      timeout: params.timeout,
      mode: params.mode,
      allReceived: false,
      createdAt: policy.time.created,
      deadline: policy.time.deadline,
    }

    return {
      title: "Wait registered",
      output: "Wait registered. End your turn now.",
      metadata: meta,
    }
  },
})
