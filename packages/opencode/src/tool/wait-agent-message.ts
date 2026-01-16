import z from "zod"
import { Identifier } from "@/id/id"
import { Session } from "@/session"
import { SessionMessage } from "@/session/message-routing"
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
  since: number
  createdAt?: number
  deadline?: number
  interruptedAt?: number
  interruptedBy?: "prompt" | "abort"
  error?: string
}

export const WaitAgentMessageTool = Tool.define("wait_agent_message", {
  description:
    "Wait for messages from specified agent sessions with a timeout. Wakes when wait condition is met, or on timeout. Timeout message shows the source's current status.",
  parameters: z.object({
    sources: z.array(z.string()).describe('Session ids to wait for (each starts with "ses_") or ["*"] for any source'),
    timeout: z.coerce.number().min(1).describe("Timeout in milliseconds"),
    mode: z.enum(["all", "any"]).describe('"all" waits for every source, "any" waits for first response'),
    since: z.coerce
      .number()
      .int()
      .min(-1)
      .describe("Message cursor. Use -1 for session start, 0 for now, or a seq checkpoint. Wait condition considers all agent messages after this, non-inclusive. All `seq > since`."),
  }),
  async execute(params, ctx) {
    const rawSources = params.sources.map((s) => s.trim()).filter(Boolean)

    const isWildcard = rawSources.length === 1 && rawSources[0] === "*"

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
        since: params.since === -1 ? 0 : SessionMessage.resolveSince(params.since),
        error,
      }

      return {
        title: "wait_agent_message blocked",
        output: JSON.stringify(meta, null, 2),
        metadata: meta,
      }
    }

    if (rawSources.length === 0) {
      return blocked('sources must be a non-empty array of session ids (each starts with "ses_") or ["*"]')
    }

    if (isWildcard && params.mode !== "any") {
      return blocked('sources=["*"] requires mode="any"')
    }

    if (rawSources.includes("*") && !isWildcard) {
      return blocked('sources must not mix "*" with session ids')
    }

    const MAX_TIMEOUT_MS = 2_147_483_647
    if (params.timeout > MAX_TIMEOUT_MS) {
      return blocked(`timeout must be <= ${MAX_TIMEOUT_MS}`)
    }

    const sources = Array.from(new Set(rawSources))
    if (sources.length !== rawSources.length) {
      return blocked("sources must not contain duplicates", sources)
    }

    if (!isWildcard) {
      // Validate all sources are valid session IDs
      const invalid = sources.filter((s) => !Identifier.schema("session").safeParse(s).success)
      if (invalid.length > 0) {
        return blocked(
          `Invalid session id(s): ${Array.from(new Set(invalid)).join(", ")}. Session ids must start with "ses_".`,
        )
      }

      const sessions = await Promise.all(sources.map((id) => Session.get(id).catch(() => undefined)))
      const missing = sources.filter((_, i) => !sessions[i])
      if (missing.length > 0) {
        return blocked(
          `Unknown session id(s): ${missing.join(", ")}. These must exist in the current instance/project.`,
          sources,
        )
      }
    }

    if (!ctx.callID) {
      return blocked("Internal error: missing tool call id")
    }

    const baseline =
      params.since === -1
        ? 0
        : SessionMessage.resolveSince(
            params.since !== 0
              ? params.since
              : (() => {
                  const raw = ctx.extra?.waitSince
                  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw

                  // Fallback: tool args may not have streamed (or were replayed); treat 0 as "now".
                  return 0
                })(),
          )

    const policy = WaitPolicy.register({
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      sources,
      timeout: params.timeout,
      mode: params.mode,
      since: baseline,
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
      since: policy.since,
      createdAt: policy.time.created,
      deadline: policy.time.deadline,
    }

    return {
      title: "Wait registered",
      output:
        "Wait registered. Your session is now waiting - stop generating. You'll wake when messages arrive or timeout expires.",
      metadata: meta,
    }
  },
})
