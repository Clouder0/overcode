import z from "zod"
import { Identifier } from "@/id/id"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
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
  warning?: string
  error?: string
}

type WaitContext = {
  maxSeqBySource: Record<string, number>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function contextMaxSeqBySource(input: unknown) {
  const obj = record(input)
  const raw = obj.maxSeqBySource
  const map = record(raw)
  const result: Record<string, number> = {}
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue
    if (!Number.isInteger(value) || value <= 0) continue
    result[key] = value
  }
  return result
}

export const WaitAgentMessageTool = Tool.define("wait_agent_message", {
  description:
    "Pause only when expected incoming agent messages matter to progress. Wakes when wait condition is met, or on timeout. Timeout message shows source status.",
  parameters: z.object({
    sources: z
      .array(z.string())
      .describe('Session ids to wait for (each starts with "ses_"). Prefer explicit ids; use ["*"] only when the expected sender is unknown.'),
    timeout: z.coerce.number().min(1).describe("Timeout in milliseconds"),
    mode: z.enum(["all", "any"]).describe('"all" waits for every source, "any" waits for first response'),
    since: z.coerce
      .number()
      .int()
      .refine((value) => value === -1 || value > 0, {
        message: "since must be -1 or a positive seq checkpoint",
      })
      .describe(
        "Message cursor (exclusive). Use an explicit seq checkpoint when available. Use -1 only for intentional backlog catch-up from session start. Wait condition matches messages with `seq > since`.",
      ),
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
        since: params.since === -1 ? 0 : params.since,
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

    if (params.since === 0) {
      return blocked("since=0 is no longer supported. Use since=-1 for session-start catch-up or a positive seq checkpoint.")
    }

    const outgoingPeers = await MessageV2.parts(ctx.messageID)
      .then((parts) =>
        Array.from(
          new Set(
            parts
              .filter((part) => part.type === "message")
              .filter((part) => part.direction === "outgoing" && part.peerType === "agent")
              .map((part) => part.peer),
          ),
        ),
      )
      .catch(() => [])

    if (isWildcard && params.since === -1 && outgoingPeers.length > 0) {
      return blocked(
        `sources=["*"] with since=-1 right after sending to explicit session(s) ${outgoingPeers.join(
          ", ",
        )} is too broad. If you expect a reply, wait on explicit source session id(s) using the checkpoint seq from send_agent_message. If no reply is required, continue or end your turn without waiting.`,
      )
    }

    const baselineRaw = (() => {
      if (params.since === -1) return 0
      return params.since
    })()

    const currentSeq = SessionMessage.nowSeq(ctx.sessionID)
    const baseline = baselineRaw > currentSeq ? currentSeq : baselineRaw
    const clampedSince = baselineRaw > currentSeq

    const mode = WaitPolicy.normalizeMode({ sources, mode: params.mode })

    const waitContext = record(ctx.extra).waitContext
    const maxSeqBySource = contextMaxSeqBySource(waitContext)

    const respondedInContext = (() => {
      const result = new Set<string>()

      if (isWildcard) {
        for (const [source, seq] of Object.entries(maxSeqBySource)) {
          if (seq > baseline) result.add(source)
        }
        return result
      }

      for (const source of sources) {
        const seq = maxSeqBySource[source] ?? 0
        if (seq > baseline) result.add(source)
      }
      return result
    })()

    const immediateInContext =
      mode === "any" ? respondedInContext.size > 0 : sources.every((source) => respondedInContext.has(source))

    const responded = SessionMessage.respondedRecoverable({
      to: ctx.sessionID,
      sources,
      since: baseline,
    })

    const immediateRecoverable = mode === "any" ? responded.size > 0 : sources.every((source) => responded.has(source))

    const immediate = immediateInContext
    const warning = [
      params.since === -1 && immediate
        ? "since=-1 matched prior messages; this wait may resolve immediately from history."
        : undefined,
      mode !== params.mode ? 'mode="any" with a single explicit source was normalized to mode="all".' : undefined,
      clampedSince
        ? `since=${baselineRaw} exceeded current seq=${currentSeq}; clamped to seq=${baseline}.`
        : undefined,
      immediateRecoverable && !immediate
        ? "Reply exists outside the current context snapshot; wait was registered so the host can refresh and continue."
        : undefined,
    ]
      .filter((line): line is string => typeof line === "string")
      .join(" ")

    if (immediate) {
      const respondedSources =
        mode === "any" ? Array.from(respondedInContext) : sources.filter((source) => respondedInContext.has(source))
      const allReceived = mode === "all" ? sources.every((source) => respondedInContext.has(source)) : respondedSources.length > 0

      const meta: WaitMessageMetadata = {
        ok: true,
        status: "resolved",
        sources,
        respondedSources,
        timedOutSources: [],
        timeout: params.timeout,
        mode,
        allReceived,
        since: baseline,
        warning: warning.length > 0 ? warning : undefined,
      }

      const output = [
        "Wait already satisfied by messages in current context. Continue your turn.",
        warning.length > 0 ? `Warning: ${warning}` : undefined,
      ].filter((line): line is string => typeof line === "string")

      return {
        title: "Wait resolved",
        output: output.join("\n"),
        metadata: meta,
      }
    }

    const policy = WaitPolicy.register({
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      sources,
      timeout: params.timeout,
      mode,
      since: baseline,
    })

    SessionStatus.set(ctx.sessionID, {
      type: "waiting",
      sources,
      timeout: params.timeout,
      mode: policy.mode,
      since: policy.since,
      time: policy.time,
    })

    const meta: WaitMessageMetadata = {
      ok: true,
      status: "waiting",
      sources,
      respondedSources: [],
      timedOutSources: [],
      timeout: params.timeout,
      mode: policy.mode,
      allReceived: false,
      since: policy.since,
      createdAt: policy.time.created,
      deadline: policy.time.deadline,
      warning: warning.length > 0 ? warning : undefined,
    }

    const output = [
      "Wait registered. Your session is now waiting - stop generating. You'll wake when messages arrive or timeout expires.",
      warning.length > 0 ? `Warning: ${warning}` : undefined,
    ].filter((line): line is string => typeof line === "string")

    return {
      title: "Wait registered",
      output: output.join("\n"),
      metadata: meta,
    }
  },
})
