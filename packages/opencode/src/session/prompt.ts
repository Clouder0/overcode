import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { batchEnd, coveredUsers, isAnswered } from "./queue-batch"
import { isAssistantAnswered, isRelevantInboundMessage, isTextRelevant, isUserRelevant } from "./relevance"
import { Log } from "../util/log"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions, type ModelMessage } from "ai"
import { SessionCompaction } from "./compaction"
import { SessionCPD } from "./cpd"
import { SessionRetry } from "./retry"
import { Instance } from "../project/instance"
import { InstanceBootstrap } from "../project/bootstrap"
import { Bus } from "../bus"
import { TuiEvent } from "../cli/cmd/tui/event"
import { ProviderTransform } from "../provider/transform"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import { Plugin } from "../plugin"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
import { clone } from "remeda"
import { ToolRegistry } from "../tool/registry"
import { Tool } from "../tool/tool"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { ListTool } from "../tool/ls"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../command"
import { $, fileURLToPath } from "bun"
import { ConfigMarkdown } from "../config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { PermissionNext } from "@/permission/next"
import { SessionStatus } from "./status"
import { SessionStatusResolver } from "./status-resolver"
import { Config } from "../config/config"
import { Shell } from "@/shell/shell"
import { LLM } from "./llm"
import { LLMConcurrencyMachine } from "./llm-concurrency-machine"
import { iife } from "@/util/iife"
import { SessionMessage } from "./message-routing"
import { WaitNotice } from "./wait-notice"
import { WaitPolicy } from "./wait-policy"
import { MessageParser } from "./message-parser"
import { Truncate } from "@/tool/truncation"
import { Token } from "@/util/token"
import { SkillProjection } from "@/util/skill-projection"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })
  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  async function inSessionDirectory<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
    const session = await Session.get(sessionID)
    if (session.directory === Instance.directory) return fn()

    return Instance.provide({
      directory: session.directory,
      init: InstanceBootstrap,
      fn,
    })
  }

  const warnState = Instance.state(() => {
    return {
      warnedAt: new Map<string, number>(),
    }
  })

  async function warnMachineConcurrency(input: {
    session: Session.Info
    model: { providerID: string; modelID: string }
  }) {
    if (input.session.sessionType === "subagent") return

    const limits = await Config.get().then((cfg) => LLMConcurrencyMachine.limits(cfg))
    if (!limits) return

    const now = Date.now()
    const last = warnState().warnedAt.get(input.session.id) ?? 0
    if (now - last < 10_000) return

    const model = await Provider.getModel(input.model.providerID, input.model.modelID).catch(() => undefined)
    const modelName = model?.api?.id ?? input.model.modelID

    const key = LLMConcurrencyMachine.bucketKey({ providerID: input.model.providerID, modelName })

    const current = await LLMConcurrencyMachine.snapshot(limits)
    const request = LLMConcurrencyMachine.request(limits, [key])

    const blocked = LLMConcurrencyMachine.blocked(limits, current, request)
    if (blocked.length === 0) return

    warnState().warnedAt.set(input.session.id, now)

    const message =
      "Machine-wide LLM concurrency limit is reached; continuing because this is a primary session. Subagent spawning may be blocked until other work finishes."

    Bus.publish(TuiEvent.ToastShow, {
      title: "LLM concurrency limit",
      message,
      variant: "warning",
      duration: 8000,
    }).catch(() => {})
  }

  const state = Instance.state(
    () => {
      const data: Record<
        string,
        {
          abort: AbortController
          callbacks: {
            resolve(input: MessageV2.WithParts): void
            reject(): void
          }[]
          done: Promise<void>
          doneResolve: () => void
          compaction?: {
            requestID: string
            startedAt: number
          }
        }
      > = {}
      return data
    },
    async (current) => {
      for (const item of Object.values(current)) {
        item.abort.abort()
        item.doneResolve()
        for (const callback of item.callbacks) {
          callback.reject()
        }
      }
    },
  )

  const wakeAfter = Instance.state(
    () => new Set<string>(),
    async (set) => {
      set.clear()
    },
  )

  const DEBOUNCE_MS = 75
  const DEBOUNCE_MAX_MS = 250
  const QUIET_MS = 50
  const SETTLE_MAX_MS = 250
  const debounce = Instance.state(
    () => new Map<string, { timer: ReturnType<typeof setTimeout>; first: number }>(),
    async (map) => {
      for (const entry of map.values()) {
        clearTimeout(entry.timer)
      }
      map.clear()
    },
  )

  const waking = Instance.state(
    () => new Set<string>(),
    async (set) => {
      set.clear()
    },
  )

  const wake = (sessionID: string) => {
    if (state()[sessionID]) {
      wakeAfter().add(sessionID)
      return
    }

    const queue = waking()
    if (queue.has(sessionID)) {
      wakeAfter().add(sessionID)
      return
    }

    queue.add(sessionID)
    log.info("waking session", { sessionID })
    SessionPrompt.loop(sessionID)
      .catch((error) => {
        log.error("failed to wake session", { sessionID, error: error?.message })
      })
      .finally(() => {
        queue.delete(sessionID)

        if (!wakeAfter().has(sessionID)) return
        wakeAfter().delete(sessionID)

        if (SessionMessage.hasPending(sessionID)) {
          scheduleWake(sessionID, { delay: DEBOUNCE_MS, max: DEBOUNCE_MAX_MS })
          return
        }

        const wait = WaitPolicy.get(sessionID)
        if (!wait) return

        const respondedFromSources = SessionMessage.respondedRecoverable({
          to: sessionID,
          sources: wait.sources,
          since: wait.since,
        })

        const result = WaitPolicy.evaluate({
          policy: wait,
          respondedFromSources,
        })

        if (!result.ready) return
        scheduleWake(sessionID, { delay: 0, max: 0 })
      })
  }

  function scheduleWake(sessionID: string, input: { delay: number; max: number }) {
    const now = Date.now()
    const scheduled = debounce()
    const current = scheduled.get(sessionID)
    const first = current ? current.first : now
    const delay = now - first >= input.max ? 0 : input.delay
    if (current) clearTimeout(current.timer)

    const timer = setTimeout(() => {
      scheduled.delete(sessionID)
      wake(sessionID)
    }, delay)

    scheduled.set(sessionID, { timer, first })
  }

  async function settleInbox(sessionID: string, abort: AbortSignal) {
    const startedAt = Date.now()
    while (true) {
      if (SessionMessage.hasPending(sessionID)) return false
      if (Date.now() - startedAt >= SETTLE_MAX_MS) return true
      await SessionRetry.sleep(QUIET_MS, abort).catch(() => {})
      if (!SessionMessage.hasPending(sessionID)) return true
    }
  }

  function waitContext(messages: MessageV2.WithParts[]) {
    const maxSeqBySource: Record<string, number> = {}

    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type !== "message") continue
        if (part.direction !== "incoming") continue
        if (part.peerType !== "agent") continue
        if (!Identifier.schema("session").safeParse(part.peer).success) continue

        const meta = part.metadata
        const oc = meta && typeof meta === "object" ? (meta as { opencode?: unknown }).opencode : undefined
        if (!oc || typeof oc !== "object") continue
        const seq = (oc as { seq?: unknown }).seq
        if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= 0) continue

        const prev = maxSeqBySource[part.peer] ?? 0
        if (seq > prev) maxSeqBySource[part.peer] = seq
      }
    }

    return { maxSeqBySource }
  }

  function compactionReminder(input: {
    sessionID: string
    messageID: string
    requestID: string
    startedAt: number
  }): MessageV2.TextPart {
    const pending = input.requestID === "pending"
    const requestLine = !pending ? `Compaction request: ${input.requestID}` : undefined
    const compaction = pending
      ? {
          pending: true,
          startedAt: input.startedAt,
        }
      : {
          requestID: input.requestID,
          startedAt: input.startedAt,
        }
    const lines = [
      "<system-reminder>",
      "This message arrived while the session was compacting.",
      requestLine,
      "It may not be reflected in the compaction summary.",
      "Please treat it as new input to address after compaction.",
      "</system-reminder>",
    ].filter((x): x is string => typeof x === "string" && x.length > 0)

    return {
      id: Identifier.ascending("part", `prt_000_${input.messageID}`),
      messageID: input.messageID,
      sessionID: input.sessionID,
      type: "text",
      synthetic: true,
      metadata: {
        opencode: {
          compaction,
        },
      },
      text: lines.join("\n"),
    }
  }

  // Register wake function with SessionMessage to handle dormant session wakeup
  // This avoids circular dependency (message-routing -> prompt)
  async function persistDeliveredMessage(message: SessionMessage.Message) {
    const sessionID = message.to

    const agentName = await lastAgent(sessionID)
    const agentInfo = await Agent.get(agentName)

    const uiMessage: MessageV2.User = {
      id: message.id,
      sessionID,
      time: { created: message.time },
      role: "user",
      agent: agentName,
      model: agentInfo?.model ?? (await lastModel(sessionID)),
    }

    await Session.updateMessage(uiMessage)

    const compacting = await (async () => {
      const active = state()[sessionID]?.compaction
      if (active) return active

      const manual = SessionCompaction.manual(sessionID)
      if (manual) {
        return {
          requestID: manual.requestID,
          startedAt: manual.startedAt,
        }
      }

      return await SessionCompaction.marker(sessionID).catch(() => undefined)
    })()
    if (compacting) {
      await Session.updatePart(
        compactionReminder({
          sessionID,
          messageID: uiMessage.id,
          requestID: compacting.requestID,
          startedAt: compacting.startedAt,
        }),
      )
    }

    const partID = uiMessage.id.replace(/^msg_/, "prt_")
    const peerType = (() => {
      if (message.from === "human") return "human" as const
      if (message.messageType === "wait_result") return "system" as const
      if (message.messageType === "notice") return "system" as const
      return "agent" as const
    })()
    const msgPart: MessageV2.MessagePart = {
      id: Identifier.ascending("part", partID),
      messageID: uiMessage.id,
      sessionID,
      type: "message",
      direction: "incoming",
      peer: message.from,
      peerType,
      text: message.text,
      timeoutOccurred: message.messageType === "timeout",
      time: { created: message.time },
      metadata: {
        opencode: {
          seq: message.seq,
          messageType: message.messageType,
        },
      },
    }

    await Session.updatePart(msgPart)
  }

  const DELIVERED_CACHE_MAX = 2048

  const delivered = Instance.state(
    () => {
      return {
        inflight: new Map<string, Promise<void>>(),
        done: new Map<string, true>(),
      }
    },
    async (entry) => {
      entry.inflight.clear()
      entry.done.clear()
    },
  )

  function persistInbound(message: SessionMessage.Message) {
    const cache = delivered()
    if (cache.done.has(message.id)) return Promise.resolve()

    const existing = cache.inflight.get(message.id)
    if (existing) return existing

    const next = persistDeliveredMessage(message)
      .then(() => {
        SessionMessage.markDurable(message)
        cache.done.set(message.id, true)
        while (cache.done.size > DELIVERED_CACHE_MAX) {
          const oldest = cache.done.keys().next().value
          if (!oldest) break
          cache.done.delete(oldest)
        }
      })
      .finally(() => {
        cache.inflight.delete(message.id)
      })

    cache.inflight.set(message.id, next)
    return next
  }

  function persistInboundInDirectory(message: SessionMessage.Message, directory: string) {
    return Instance.provide({
      directory,
      fn: () => persistInbound(message),
    })
  }

  async function updateWaitProgress(sessionID: string, policy: WaitPolicy.Policy) {
    const current = WaitPolicy.get(sessionID)
    if (!current || current.callID !== policy.callID) return

    const respondedFromSources = SessionMessage.respondedRecoverable({
      to: sessionID,
      sources: policy.sources,
      since: policy.since,
    })

    const result = WaitPolicy.evaluate({
      policy,
      respondedFromSources,
    })

    const respondedSeqs = Object.fromEntries(
      result.respondedSources.map((source) => [source, SessionMessage.lastSeq(sessionID, source)]),
    )

    const parts = await MessageV2.parts(policy.messageID)
    const tool = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === policy.callID)
    if (!tool) return

    const meta = {
      ok: true,
      status: result.timedOut ? "timedOut" : "waiting",
      sources: policy.sources,
      respondedSources: result.respondedSources,
      respondedSeqs,
      timedOutSources: result.timedOut ? result.missingSources : [],
      timeout: policy.timeout,
      mode: policy.mode,
      allReceived: false,
      since: policy.since,
      createdAt: policy.time.created,
      deadline: policy.time.deadline,
    }

    if (tool.state.status === "pending") return

    const still = WaitPolicy.get(sessionID)
    if (!still || still.callID !== policy.callID) return

    const before = JSON.stringify((tool.state as { metadata?: unknown }).metadata ?? null)
    const after = JSON.stringify(meta)
    if (before === after) return

    await Session.updatePart({
      ...tool,
      state: {
        ...tool.state,
        metadata: meta,
      },
    })
  }

  function waitSourceText(input: { sources: string[]; seqs: Record<string, number>; key: "seq" | "last" }) {
    if (input.sources.length === 0) return "none"

    return input.sources
      .map((source) => {
        const seq = input.seqs[source]
        if (typeof seq !== "number") return source
        if (!Number.isInteger(seq) || seq <= 0) return source
        return `${source}(${input.key}=${seq})`
      })
      .join(", ")
  }

  function waitOutputText(input: {
    status: "resolved" | "timedOut" | "interrupted"
    mode: "all" | "any"
    since: number
    respondedSources: string[]
    respondedSeqs: Record<string, number>
    timedOutSources: string[]
    timedOutSeqs: Record<string, number>
    interruptedBy?: "prompt" | "abort"
  }) {
    const title =
      input.status === "resolved"
        ? "Wait resolved"
        : input.status === "timedOut"
          ? "Wait timed out"
          : `Wait interrupted (${input.interruptedBy ?? "unknown"})`

    const lines = [
      title,
      `mode: ${input.mode}`,
      `since: ${input.since}`,
      `responded: ${waitSourceText({
        sources: input.respondedSources,
        seqs: input.respondedSeqs,
        key: "seq",
      })}`,
    ]

    if (input.status !== "timedOut" && input.timedOutSources.length === 0) {
      return lines.join("\n")
    }

    return [
      ...lines,
      `timed_out: ${waitSourceText({
        sources: input.timedOutSources,
        seqs: input.timedOutSeqs,
        key: "last",
      })}`,
    ].join("\n")
  }

  type WaitResume = {
    since: number
    sources: Set<string>
  }

  function partSeq(part: MessageV2.MessagePart) {
    const metadata = part.metadata
    if (!metadata || typeof metadata !== "object") return
    const opencode = (metadata as { opencode?: unknown }).opencode
    if (!opencode || typeof opencode !== "object") return
    const seq = (opencode as { seq?: unknown }).seq
    if (typeof seq !== "number") return
    if (!Number.isInteger(seq) || seq <= 0) return
    return seq
  }

  function waitReply(input: { msg: MessageV2.WithParts; resume: WaitResume }) {
    if (input.msg.info.role !== "user") return false

    return input.msg.parts.some((part) => {
      if (part.type !== "message") return false
      if (!isRelevantInboundMessage(part)) return false
      if (part.direction !== "incoming") return false
      if (part.peerType !== "agent") return false
      if (!input.resume.sources.has(part.peer)) return false
      const seq = partSeq(part)
      if (seq === undefined) return false
      return seq > input.resume.since
    })
  }

  function normalizeContextMessages(input: { messages: MessageV2.WithParts[]; reference: MessageV2.WithParts[] }) {
    const rank = new Map(input.reference.map((msg, index) => [msg.info.id, index]))
    const seen = new Set<string>()
    const known = [] as MessageV2.WithParts[]
    const unknown = [] as MessageV2.WithParts[]

    for (const msg of input.messages) {
      if (seen.has(msg.info.id)) continue
      seen.add(msg.info.id)

      const value: MessageV2.WithParts = {
        info: msg.info,
        parts: [...msg.parts].sort((a, b) => (a.id > b.id ? 1 : -1)),
      }

      if (rank.has(msg.info.id)) {
        known.push(value)
        continue
      }

      unknown.push(value)
    }

    known.sort(
      (a, b) => (rank.get(a.info.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.info.id) ?? Number.MAX_SAFE_INTEGER),
    )
    unknown.sort((a, b) => (a.info.id > b.info.id ? 1 : -1))
    return [...known, ...unknown]
  }

  function inboxMessage(msg: MessageV2.WithParts) {
    if (msg.info.role !== "user") return false
    return msg.parts.some((part) => part.type === "message" && isRelevantInboundMessage(part))
  }

  function inboxBatchEnd(input: {
    users: MessageV2.WithParts[]
    start: number
    isUnanswered: (msg: MessageV2.WithParts) => boolean
  }) {
    let end = input.start
    while (end < input.users.length) {
      const current = input.users[end]
      if (!current) break
      if (current.info.role !== "user") break
      if (!input.isUnanswered(current)) break
      if (!inboxMessage(current)) break
      end += 1
    }
    return end - 1 < input.start ? input.start : end - 1
  }

  function taskBatchEnd(input: {
    users: MessageV2.WithParts[]
    start: number
    isUnanswered: (msg: MessageV2.WithParts) => boolean
  }) {
    const end = batchEnd(input)

    for (let i = input.start + 1; i <= end; i++) {
      const current = input.users[i]
      if (!current) break
      if (!inboxMessage(current)) continue
      return i - 1
    }

    return end
  }

  function waitMatchesSource(input: { message: SessionMessage.Message; sources: string[] }) {
    if (input.message.messageType === "notice") return false
    if (input.message.messageType === "wait_result") return false
    const agent = Identifier.schema("session").safeParse(input.message.from).success
    if (!agent) return false
    const wildcard = input.sources.length === 1 && input.sources[0] === "*"
    if (wildcard) return true
    return input.sources.includes(input.message.from)
  }

  async function consumeInboxMessages(input: { messages: MessageV2.WithParts[]; assistantID: string }) {
    const now = Date.now()

    for (const msg of input.messages) {
      if (msg.info.role !== "user") continue

      for (const part of msg.parts) {
        if (part.type !== "message") continue
        if (!isRelevantInboundMessage(part)) continue

        const metadata = part.metadata
        const base = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {}
        const opencode =
          base.opencode && typeof base.opencode === "object" ? (base.opencode as Record<string, unknown>) : {}

        await Session.updatePart({
          ...part,
          metadata: {
            ...base,
            opencode: {
              ...opencode,
              consumed: true,
              consumedAt: now,
              consumedBy: input.assistantID,
            },
          },
        })
      }
    }
  }

  async function interruptWait(sessionID: string, policy: WaitPolicy.Policy, by: "prompt" | "abort") {
    const parts = await MessageV2.parts(policy.messageID)
    const tool = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === policy.callID)
    if (!tool) return
    if (tool.state.status !== "completed") return

    const interruptedAt = Date.now()

    const prev = tool.state.metadata as any
    const respondedSources: string[] = (Array.isArray(prev?.respondedSources) ? prev.respondedSources : []).filter(
      (x: unknown): x is string => typeof x === "string",
    )

    // Best-effort observability: which seq we last saw per responded source.
    const respondedSeqs = Object.fromEntries(
      respondedSources.map((source) => [source, SessionMessage.lastSeq(sessionID, source)]),
    )

    const output = waitOutputText({
      status: "interrupted",
      mode: policy.mode,
      since: policy.since,
      respondedSources,
      respondedSeqs,
      timedOutSources: [],
      timedOutSeqs: {},
      interruptedBy: by,
    })

    const meta = {
      ok: true,
      status: "interrupted",
      sources: policy.sources,
      respondedSources,
      respondedSeqs,
      timedOutSources: [],
      timeout: policy.timeout,
      mode: policy.mode,
      allReceived: false,
      since: policy.since,
      createdAt: policy.time.created,
      deadline: policy.time.deadline,
      interruptedAt,
      interruptedBy: by,
    }

    await Session.updatePart({
      ...tool,
      state: {
        ...tool.state,
        title: "Wait interrupted",
        output,
        metadata: meta,
      },
    })

    // Unblock FIFO: waits typically leave finish="tool-calls" (non-terminal), which keeps the
    // parent user message "unanswered". Mark the assistant message as aborted so newer prompts
    // are not stuck behind an interrupted wait.
    const msg = await MessageV2.get({
      sessionID,
      messageID: policy.messageID,
    }).catch(() => undefined)
    if (!msg) return
    if (msg.info.role !== "assistant") return
    const assistant = msg.info as MessageV2.Assistant
    if (assistant.error) return

    const reason = by === "prompt" ? "Wait interrupted by new prompt" : "Wait interrupted by abort"
    await Session.updateMessage({
      ...assistant,
      time: {
        ...assistant.time,
        completed: assistant.time.completed ?? interruptedAt,
      },
      error: new MessageV2.AbortedError({
        message: reason,
      }).toObject(),
    })
  }

  function interruptWaitInDirectory(
    sessionID: string,
    policy: WaitPolicy.Policy,
    directory: string,
    by: "prompt" | "abort",
  ) {
    return Instance.provide({
      directory,
      fn: () => interruptWait(sessionID, policy, by),
    })
  }

  SessionMessage.setWakeSessionFn(async (message) => {
    const sessionID = message.to
    const directory = Instance.directory

    // Start persistence immediately. We still await it before returning so
    // send_agent_message can treat delivery as durable.
    const saved = persistInboundInDirectory(message, directory)

    // If the session loop is currently running, let it observe pending messages directly.
    if (state()[sessionID]) {
      wakeAfter().add(sessionID)
      await saved
      return
    }

    const status = SessionStatus.get(sessionID)
    if (status.type === "idle") {
      // Manual compaction is authoritative even if status was cleared unexpectedly.
      if (SessionCompaction.manual(sessionID)) {
        await saved
        return
      }
      scheduleWake(sessionID, { delay: DEBOUNCE_MS, max: DEBOUNCE_MAX_MS })
      await saved
      return
    }

    if (status.type === "waiting") {
      const policy = WaitPolicy.get(sessionID)
      if (!policy) {
        // Avoid getting stuck in an unwakeable "waiting" state.
        SessionStatus.set(sessionID, { type: "idle" })
        scheduleWake(sessionID, { delay: 0, max: 0 })
        await saved
        return
      }

      updateWaitProgress(sessionID, policy).catch((error) => {
        log.error("failed to update wait progress", { sessionID, error: error?.message })
      })

      const pending = SessionMessage.peekPending(sessionID)
      const nonSource = pending.filter((m) => !waitMatchesSource({ message: m, sources: policy.sources }))
      if (nonSource.length > 0) {
        const human = nonSource.some((m) => m.from === "human")
        Promise.allSettled(nonSource.map((m) => persistInboundInDirectory(m, directory)))
          .then((settled) => {
            const ok = new Set<string>()
            for (const [i, msg] of nonSource.entries()) {
              if (settled[i]?.status === "fulfilled") ok.add(msg.id)
            }
            if (ok.size === 0) return

            SessionMessage.takePending(
              sessionID,
              (msg) => ok.has(msg.id) && !waitMatchesSource({ message: msg, sources: policy.sources }),
            )
          })
          .catch((error) => {
            log.error("failed to persist non-source wait messages", { sessionID, error: error?.message })
          })

        if (human) {
          interruptWaitInDirectory(sessionID, policy, directory, "prompt").catch((error) => {
            log.error("failed to interrupt wait on incoming human message", { sessionID, error: error?.message })
          })
          WaitPolicy.clear(sessionID)
          SessionStatus.set(sessionID, { type: "idle" })
          scheduleWake(sessionID, { delay: 0, max: 0 })
          await saved
          return
        }
      }

      const respondedFromSources = SessionMessage.respondedRecoverable({
        to: sessionID,
        sources: policy.sources,
        since: policy.since,
      })

      const result = WaitPolicy.evaluate({
        policy,
        respondedFromSources,
      })

      if (!result.ready) {
        await saved
        return
      }

      scheduleWake(sessionID, { delay: 0, max: 0 })
      await saved
      return
    }

    if (status.type === "retry") {
      // Status can become stale if a loop exits unexpectedly.
      SessionStatus.set(sessionID, { type: "idle" })
      scheduleWake(sessionID, { delay: 0, max: 0 })
      await saved
      return
    }

    if (status.type === "busy") {
      // Manual compaction runs outside the prompt loop state. Treat it as authoritative
      // and do not start a concurrent loop while it's in-flight.
      if (SessionCompaction.manual(sessionID)) {
        await saved
        return
      }

      // Status can become stale if a loop exits unexpectedly.
      SessionStatus.set(sessionID, { type: "idle" })
      scheduleWake(sessionID, { delay: 0, max: 0 })
      await saved
    }
  })

  WaitNotice.init()

  const OVERFLOW_WARN_COOLDOWN_MS = 5000
  const overflowNotice = Instance.state(
    () => {
      const seen = new Map<string, number>()
      const unsub = Bus.subscribe(SessionMessage.Event.Overflow, (event) => {
        const now = Date.now()
        const to = event.properties.to
        const last = seen.get(to) ?? 0
        if (now - last < OVERFLOW_WARN_COOLDOWN_MS) return
        seen.set(to, now)

        Bus.publish(TuiEvent.ToastShow, {
          variant: "warning",
          title: "Message queue overflow",
          message: `Dropped ${event.properties.droppedCount} queued message(s) for ${to}. Ask agents to send fewer incremental updates.`,
          duration: 5000,
        }).catch(() => {})
      })

      return { seen, unsub }
    },
    async (entry) => {
      entry.unsub()
      entry.seen.clear()
    },
  )

  // Allow WaitPolicy timers (timeout/debounce) to wake sessions.
  WaitPolicy.setWakeFn((sessionID) => {
    const status = SessionStatus.get(sessionID)

    // Retry state uses its own scheduler.
    if (status.type === "retry") return

    // If a loop is active, schedule a wake once it unwinds.
    // This avoids a one-shot timeout wake being dropped.
    if (state()[sessionID]) {
      wakeAfter().add(sessionID)
      return
    }

    scheduleWake(sessionID, { delay: 0, max: 0 })
  })

  // Session-scoped extra tools (e.g., bridge tools for worker sessions)
  const extraToolsState = Instance.state(
    () => new Map<string, Tool.Info[]>(),
    async (map) => map.clear(),
  )

  /**
   * Set extra tools for a session. These will be merged with registry tools during prompts.
   * Used by job system to inject bridge tools (job_emit, job_notify, etc.) into worker sessions.
   */
  export function setExtraTools(sessionID: string, tools: Tool.Info[]) {
    extraToolsState().set(sessionID, tools)
  }

  /**
   * Clear extra tools for a session.
   */
  export function clearExtraTools(sessionID: string) {
    extraToolsState().delete(sessionID)
  }

  /**
   * Get extra tools for a session.
   */
  export function getExtraTools(sessionID: string): Tool.Info[] {
    return extraToolsState().get(sessionID) ?? []
  }

  const ENVIRONMENT_IDLE_CACHE_MAX = 16

  type EnvironmentCache = {
    key: string
    value: Promise<string[]>
  }

  function evictEnvironmentIdle(idle: Map<string, EnvironmentCache>) {
    while (idle.size > ENVIRONMENT_IDLE_CACHE_MAX) {
      const oldest = idle.keys().next().value
      if (!oldest) break
      idle.delete(oldest)
    }
  }

  const environmentState = Instance.state(
    () => {
      const pinned = new Map<string, EnvironmentCache>()
      const idle = new Map<string, EnvironmentCache>()

      const unsubs = [
        Bus.subscribe(Session.Event.Deleted, (event) => {
          const sessionID = event.properties.info.id
          pinned.delete(sessionID)
          idle.delete(sessionID)
        }),
        Bus.subscribe(SessionStatus.Event.Status, (event) => {
          const sessionID = event.properties.sessionID
          const status = event.properties.status

          if (status.type === "idle") {
            const existing = pinned.get(sessionID)
            if (existing) {
              pinned.delete(sessionID)
              idle.delete(sessionID)
              idle.set(sessionID, existing)
              evictEnvironmentIdle(idle)
            }
            return
          }

          if (pinned.has(sessionID)) return
          const existing = idle.get(sessionID)
          if (!existing) return
          idle.delete(sessionID)
          pinned.set(sessionID, existing)
        }),
      ]

      return { pinned, idle, unsubs }
    },
    async (entry) => {
      for (const unsub of entry.unsubs) {
        unsub()
      }
      entry.pinned.clear()
      entry.idle.clear()
    },
  )

  function environmentPinned(sessionID: string) {
    if (state()[sessionID]) return true
    if (WaitPolicy.isWaiting(sessionID)) return true
    const status = SessionStatus.get(sessionID)
    return status.type !== "idle"
  }

  function pinEnvironment(sessionID: string) {
    const cache = environmentState()
    const existing = cache.idle.get(sessionID)
    if (!existing) return
    cache.idle.delete(sessionID)
    cache.pinned.set(sessionID, existing)
  }

  export function getCachedEnvironment(sessionID: string, load: () => Promise<string[]>): Promise<string[]>
  export function getCachedEnvironment(
    sessionID: string,
    input: { key: string; load: () => Promise<string[]> },
  ): Promise<string[]>
  export function getCachedEnvironment(
    sessionID: string,
    input: { key: string; load: () => Promise<string[]> } | (() => Promise<string[]>),
  ) {
    const resolved = typeof input === "function" ? { key: "default", load: input } : input
    const cache = environmentState()
    const pinned = cache.pinned
    const idle = cache.idle

    const pinnedEntry = pinned.get(sessionID)
    if (pinnedEntry?.key === resolved.key) return pinnedEntry.value
    if (pinnedEntry) pinned.delete(sessionID)

    const idleEntry = idle.get(sessionID)
    if (idleEntry?.key === resolved.key) {
      idle.delete(sessionID)
      if (environmentPinned(sessionID)) {
        pinned.set(sessionID, idleEntry)
        return idleEntry.value
      }
      idle.set(sessionID, idleEntry)
      return idleEntry.value
    }
    if (idleEntry) idle.delete(sessionID)

    const value = resolved.load()
    const entry: EnvironmentCache = {
      key: resolved.key,
      value,
    }
    const active = environmentPinned(sessionID)
    if (active) {
      pinned.set(sessionID, entry)
    }
    if (!active) {
      idle.set(sessionID, entry)
      evictEnvironmentIdle(idle)
    }

    value.catch(() => {
      if (pinned.get(sessionID)?.value === value) pinned.delete(sessionID)
      if (idle.get(sessionID)?.value === value) idle.delete(sessionID)
    })

    return value
  }

  export function clearCachedEnvironment(sessionID: string) {
    const cache = environmentState()
    cache.pinned.delete(sessionID)
    cache.idle.delete(sessionID)
  }

  export function assertNotBusy(sessionID: string) {
    const match = state()[sessionID]
    if (match) throw new Session.BusyError({ sessionID })

    // Manual compaction runs outside the prompt loop state.
    if (SessionCompaction.manual(sessionID)) throw new Session.BusyError({ sessionID })

    const status = SessionStatus.get(sessionID)
    if (status.type === "waiting") throw new Session.BusyError({ sessionID })
  }

  export const PromptInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message").optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const prompt = fn(PromptInput, async (input) => {
    return inSessionDirectory(input.sessionID, async () => {
      const session = await Session.get(input.sessionID)
      await SessionRevert.cleanup(session)

      // Manual summarize runs outside the prompt loop state. Reject new prompts
      // instead of persisting messages that cannot be processed.
      if (SessionCompaction.manual(input.sessionID)) {
        throw new Session.BusyError({ sessionID: input.sessionID })
      }

      // Human input cancels waiting.
      if (WaitPolicy.isWaiting(input.sessionID)) {
        const wait = WaitPolicy.get(input.sessionID)
        if (wait) {
          await interruptWaitInDirectory(input.sessionID, wait, Instance.directory, "prompt").catch((error) => {
            log.error("failed to mark wait interrupted", { sessionID: input.sessionID, error: error?.message })
          })
        }
        WaitPolicy.clear(input.sessionID)
        SessionStatus.set(input.sessionID, { type: "idle" })
      }

      const message = await createUserMessage(input)
      await Session.touch(input.sessionID)

      // this is backwards compatibility for allowing `tools` to be specified when
      // prompting
      const permissions: PermissionNext.Ruleset = []
      for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({
          permission: tool,
          action: enabled ? "allow" : "deny",
          pattern: "*",
        })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        await Session.update(session.id, (draft) => {
          draft.permission = permissions
        })
      }

      if (input.noReply === true) {
        return message
      }

      if (message.info.role === "user" && message.info.model) {
        await warnMachineConcurrency({
          session,
          model: message.info.model,
        })
      }

      const targetUserID = message.info.role === "user" && isUserRelevant(message) ? message.info.id : undefined
      if (!targetUserID) return runLoop(input.sessionID)

      return waitForTargetAssistant({
        sessionID: input.sessionID,
        targetUserID,
      })
    })
  })

  function assistantTargetsUser(input: { assistant: MessageV2.WithParts; targetUserID: string }) {
    if (input.assistant.info.role !== "assistant") return false
    const info = input.assistant.info as MessageV2.Assistant
    if (info.parentID === input.targetUserID) return true
    return coveredUsers(input.assistant).includes(input.targetUserID)
  }

  async function findTargetAssistant(input: { sessionID: string; targetUserID: string }) {
    const msgs = await Session.messages({ sessionID: input.sessionID })
    return msgs.findLast((msg) => assistantTargetsUser({ assistant: msg, targetUserID: input.targetUserID }))
  }

  async function waitForTargetAssistant(input: {
    sessionID: string
    targetUserID: string
  }): Promise<MessageV2.WithParts> {
    const seen = new Set<string>()

    for (let attempts = 0; attempts < 32; attempts++) {
      const result = await runLoop(input.sessionID)
      if (assistantTargetsUser({ assistant: result, targetUserID: input.targetUserID })) return result

      const match = await findTargetAssistant({
        sessionID: input.sessionID,
        targetUserID: input.targetUserID,
      })
      if (match) return match

      const key = result.info.id
      if (seen.has(key)) {
        throw new Error(`Could not resolve target assistant for user ${input.targetUserID}`)
      }
      seen.add(key)
    }

    throw new Error(`Target assistant resolution exceeded retry budget for user ${input.targetUserID}`)
  }

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    const cfg = await Config.get()
    const allowOutsideWorktree = cfg.experimental?.allowFileRefsOutsideWorktree === true
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    await Promise.all(
      files.map(async (match) => {
        const name = match[1]
        if (seen.has(name)) return
        seen.add(name)

        // Security: block ~/ and absolute paths unless explicitly allowed
        const isOutsideWorktree = name.startsWith("~/") || path.isAbsolute(name)
        if (isOutsideWorktree && !allowOutsideWorktree) {
          log.warn("blocked file reference outside worktree", { name })
          return
        }

        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(Instance.worktree, name)

        const stats = await fs.stat(filepath).catch(() => undefined)
        if (!stats) {
          const agent = await Agent.get(name)
          if (agent) {
            parts.push({
              type: "agent",
              name: agent.name,
            })
          }
          return
        }

        if (stats.isDirectory()) {
          parts.push({
            type: "file",
            url: `file://${filepath}`,
            filename: name,
            mime: "application/x-directory",
          })
          return
        }

        parts.push({
          type: "file",
          url: `file://${filepath}`,
          filename: name,
          mime: "text/plain",
        })
      }),
    )
    return parts
  }

  function start(sessionID: string) {
    const s = state()
    if (s[sessionID]) return
    const controller = new AbortController()
    let doneResolve: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      doneResolve = resolve
    })

    s[sessionID] = {
      abort: controller,
      callbacks: [],
      done,
      doneResolve,
    }
    pinEnvironment(sessionID)
    return controller.signal
  }

  function cancelLocal(sessionID: string, input?: { force?: boolean }) {
    log.info("cancel", { sessionID })
    const s = state()
    const match = s[sessionID]

    const force = input?.force !== false

    // Waiting sessions exit the loop, so there may be no active abort controller.
    // Still allow a forced cancel to clear wait state.
    if (!match) {
      if (force) {
        const wait = WaitPolicy.get(sessionID)
        if (wait) {
          interruptWaitInDirectory(sessionID, wait, Instance.directory, "abort").catch((error) => {
            log.error("failed to mark wait interrupted", { sessionID, error: error?.message })
          })
        }

        const wasWaiting = wait !== undefined
        WaitPolicy.clear(sessionID)
        SessionStatus.set(sessionID, { type: "idle" })
        wakeAfter().delete(sessionID)

        if (wasWaiting && SessionMessage.hasPending(sessionID)) {
          wake(sessionID)
        }
      }
      return
    }

    match.abort.abort()
    for (const item of match.callbacks) {
      item.reject()
    }
    match.callbacks = []

    // Forced cancel aborts the active loop but keeps its lock in place.
    // This avoids starting a concurrent loop while the aborted one is still unwinding.
    if (force) {
      const wait = WaitPolicy.get(sessionID)
      if (wait) {
        interruptWaitInDirectory(sessionID, wait, Instance.directory, "abort").catch((error) => {
          log.error("failed to mark wait interrupted", { sessionID, error: error?.message })
        })
      }

      if (SessionMessage.hasPending(sessionID)) {
        wakeAfter().add(sessionID)
      }
      WaitPolicy.clear(sessionID)
      SessionStatus.set(sessionID, { type: "idle" })
      return
    }

    match.doneResolve()
    delete s[sessionID]

    const status = SessionStatus.get(sessionID)
    if (status.type !== "waiting") {
      SessionStatus.set(sessionID, { type: "idle" })
    }

    if (!wakeAfter().has(sessionID)) return
    wakeAfter().delete(sessionID)

    const hasPending = SessionMessage.hasPending(sessionID)
    const hasWait = WaitPolicy.isWaiting(sessionID)
    if (!hasPending && !hasWait) return

    if (status.type === "waiting") {
      const policy = WaitPolicy.get(sessionID)
      if (!policy) {
        SessionStatus.set(sessionID, { type: "idle" })
        wake(sessionID)
        return
      }

      const respondedFromSources = SessionMessage.respondedRecoverable({
        to: sessionID,
        sources: policy.sources,
        since: policy.since,
      })

      const result = WaitPolicy.evaluate({ policy, respondedFromSources })

      if (!result.ready) return

      wake(sessionID)
      return
    }

    wake(sessionID)
  }

  export function cancel(sessionID: string, input?: { force?: boolean }) {
    // Best-effort: cancel immediately if the session is running in this instance.
    cancelLocal(sessionID, input)

    // Also cancel in the session's owning directory, to avoid cross-instance stuck loops.
    void Session.get(sessionID)
      .then((session) => {
        if (session.directory === Instance.directory) return
        return Instance.provide({
          directory: session.directory,
          init: InstanceBootstrap,
          fn: () => cancelLocal(sessionID, input),
        })
      })
      .catch((error) => {
        log.error("failed to cancel in session directory", { sessionID, error: error?.message })
      })
  }

  // Abort route helper: guarantee the wait tool gets marked interrupted before returning.
  // This avoids races where /abort returns, a new prompt arrives, and FIFO still sees the
  // wait-issuing assistant message as non-terminal.
  export async function cancelWait(sessionID: string) {
    return inSessionDirectory(sessionID, async () => {
      const wait = WaitPolicy.get(sessionID)
      if (!wait) return false

      await interruptWait(sessionID, wait, "abort").catch((error) => {
        log.error("failed to mark wait interrupted", { sessionID, error: error?.message })
      })
      WaitPolicy.clear(sessionID)
      SessionStatus.set(sessionID, { type: "idle" })
      wakeAfter().delete(sessionID)
      return true
    })
  }

  export async function omitOrphanThinking(input: {
    sessionID: string
    assistant: MessageV2.WithParts
    continuedAtMessageID: string
  }) {
    if (input.assistant.info.role !== "assistant") return { omitted: false, persisted: true }
    const assistant = input.assistant.info as MessageV2.Assistant
    if (assistant.finish) return { omitted: false, persisted: true }

    const parts = input.assistant.parts
    const hasNonThinking = parts.some(
      (part) => part.type !== "reasoning" && part.type !== "step-start" && part.type !== "step-finish",
    )
    if (hasNonThinking) return { omitted: false, persisted: true }

    const reasoning = parts.filter(
      (part): part is MessageV2.ReasoningPart => part.type === "reasoning" && !part.ignored,
    )
    if (reasoning.length === 0) return { omitted: false, persisted: true }

    const now = Date.now()

    const messageUpdate = (() => {
      if (assistant.time.completed) return undefined
      assistant.time.completed = now
      return Session.updateMessage(assistant)
    })()

    const updates = reasoning.map((part) => {
      const base =
        part.metadata && typeof part.metadata === "object"
          ? (part.metadata as Record<string, unknown>)
          : ({} as Record<string, unknown>)
      const existing =
        base.opencode && typeof base.opencode === "object"
          ? (base.opencode as Record<string, unknown>)
          : ({} as Record<string, unknown>)

      part.ignored = true
      part.metadata = {
        ...base,
        opencode: {
          ...existing,
          status: "omitted",
          reason: "interrupted",
          continuedAtMessageID: input.continuedAtMessageID,
          continuedAt: now,
        },
      }
      return Session.updatePart(part)
    })

    const settled = await Promise.allSettled([...updates, ...(messageUpdate ? [messageUpdate] : [])])
    const persisted = settled.every((s) => s.status === "fulfilled")

    if (!persisted) {
      log.error("failed to persist orphan reasoning omission metadata", {
        sessionID: input.sessionID,
        assistantMessageID: input.assistant.info.id,
        userMessageID: input.continuedAtMessageID,
      })
    }

    return { omitted: true, persisted }
  }

  async function omitIncompleteThinking(input: { sessionID: string; messages: MessageV2.WithParts[] }) {
    const now = Date.now()
    const updates: Promise<unknown>[] = []

    for (const msg of input.messages) {
      if (msg.info.role !== "assistant") continue

      const assistant = msg.info as MessageV2.Assistant
      if (!assistant.time.completed) continue
      if (assistant.finish) continue
      if (assistant.error) continue

      const parts = msg.parts
      const hasNonThinking = parts.some(
        (part) => part.type !== "reasoning" && part.type !== "step-start" && part.type !== "step-finish",
      )
      if (hasNonThinking) continue

      const reasoning = parts.filter(
        (part): part is MessageV2.ReasoningPart => part.type === "reasoning" && part.ignored !== true,
      )
      if (reasoning.length === 0) continue

      for (const part of reasoning) {
        const base =
          part.metadata && typeof part.metadata === "object"
            ? (part.metadata as Record<string, unknown>)
            : ({} as Record<string, unknown>)
        const existing =
          base.opencode && typeof base.opencode === "object"
            ? (base.opencode as Record<string, unknown>)
            : ({} as Record<string, unknown>)

        part.ignored = true
        part.metadata = {
          ...base,
          opencode: {
            ...existing,
            status: "omitted",
            reason: "incomplete",
            continuedAt: now,
          },
        }
        updates.push(Session.updatePart(part))
      }
    }

    if (updates.length === 0) return { omitted: false, persisted: true }

    const settled = await Promise.allSettled(updates)
    const persisted = settled.every((s) => s.status === "fulfilled")

    if (!persisted) {
      log.error("failed to persist incomplete reasoning omission metadata", {
        sessionID: input.sessionID,
      })
    }

    return { omitted: true, persisted }
  }

  type AutoCompactionCause = "overflow" | "context_length"

  function pipelineEnabled(cfg: Awaited<ReturnType<typeof Config.get>>) {
    return cfg.experimental?.context_pipeline !== false
  }

  async function allowMaintenance(input: { sessionID: string; cause: AutoCompactionCause }) {
    const cfg = await Config.get()
    const policy = SessionCompaction.autoPolicy(cfg.compaction?.auto)

    if (policy === "deny") return false
    if (policy === "allow") return true

    const patterns = ["auto"]
    return PermissionNext.ask({
      permission: "compaction",
      patterns,
      always: patterns,
      sessionID: input.sessionID,
      metadata: {
        cause: input.cause,
      },
      ruleset: [],
    })
      .then(() => true)
      .catch(() => false)
  }

  function cpdBlock(text: string) {
    return ["<compacted-prefix-digest>", text.trim(), "</compacted-prefix-digest>"].join("\n")
  }

  function integrity(session: Session.Info) {
    const flags = session.context
    const lines = [
      "<context-integrity>",
      "Tool outputs may be trimmed to fit context.",
      "Use the Compacted Prefix Digest (CPD) + visible messages.",
      "If you need trimmed details, re-run tools or re-read files.",
      flags?.think ? "Older reasoning steps were omitted due to context limits." : "",
      flags?.rctx ? "Provider rejected prior reasoning context; older native thinking may be unavailable." : "",
      "</context-integrity>",
    ].filter((x) => x)
    return lines.join("\n")
  }

  function estimateModel(messages: ModelMessage[]) {
    const content = messages.map((m) => {
      if (typeof m.content === "string") return m.content
      try {
        return JSON.stringify(m.content)
      } catch {
        return ""
      }
    })
    return content.reduce((sum, str) => sum + Token.estimate(str), 0)
  }

  function estimateSystem(system: string[]) {
    return system.reduce((sum, str) => sum + Token.estimate(str), 0)
  }

  const CONTEXT_LENGTH_PROVIDER_MESSAGE_MAX = 600

  function capContextLengthMessage(value: string) {
    if (value.length <= CONTEXT_LENGTH_PROVIDER_MESSAGE_MAX) return value
    return value.slice(0, CONTEXT_LENGTH_PROVIDER_MESSAGE_MAX) + "..."
  }

  function contextLengthErrorText(error: MessageV2.Assistant["error"] | undefined) {
    const base = error && typeof error === "object" ? (error as any) : undefined
    const data = base && typeof base.data === "object" ? (base.data as any) : undefined

    const message = (() => {
      if (data && typeof data.message === "string") return String(data.message)
      if (base && typeof base.message === "string") return String(base.message)
      return ""
    })()

    const responseBody = (() => {
      if (data && typeof data.responseBody === "string") return String(data.responseBody)
      if (base && typeof base.responseBody === "string") return String(base.responseBody)
      return ""
    })()

    return { message, responseBody }
  }

  function contextLengthOverage(error: MessageV2.Assistant["error"] | undefined) {
    const source = contextLengthErrorText(error)
    const message = source.message
    const responseBody = source.responseBody
    const combined = [message, responseBody].filter((x) => x).join("\n")
    if (!combined) return

    const patterns = [
      /maximum context length is\s*(\d+)[\s\S]*?requested\s*(\d+)/i,
      /maximum context length is\s*(\d+)[\s\S]*?resulted in\s*(\d+)/i,
      /max(?:imum)?\s*(\d+)[\s\S]*?requested\s*(\d+)/i,
      /max(?:imum)?\s*(\d+)[\s\S]*?resulted in\s*(\d+)/i,
    ]

    for (const pattern of patterns) {
      const match = combined.match(pattern)
      if (!match) continue
      const max = Number.parseInt(match[1] ?? "", 10)
      const requested = Number.parseInt(match[2] ?? "", 10)
      if (!Number.isFinite(max) || !Number.isFinite(requested)) continue
      const overage = requested - max
      if (overage > 0) return overage
    }

    return
  }

  function contextLengthMinDrop(input: {
    error: MessageV2.Assistant["error"] | undefined
    attempt: number
    target: number
  }) {
    const overage = contextLengthOverage(input.error)
    if (typeof overage === "number") {
      const bump = input.attempt >= 2 ? 1000 : 500
      return overage + bump
    }

    const floor = Math.max(2000, Math.floor(input.target * 0.05))
    const scaled = input.attempt >= 2 ? floor * 2 : floor
    // Cap fallback drops to avoid blowing away large-context sessions on parsing failures.
    return Math.min(scaled, 20_000)
  }

  function contextLengthProviderMessage(error: MessageV2.Assistant["error"] | undefined) {
    const message = contextLengthErrorText(error).message
    const trimmed = message.trim()
    if (!trimmed) return
    return capContextLengthMessage(trimmed)
  }

  async function runLoop(sessionID: string): Promise<MessageV2.WithParts> {
    // Manual compaction (server summarize) runs outside the prompt-loop state.
    // Do not start a concurrent loop while it is in-flight.
    if (!state()[sessionID] && SessionCompaction.manual(sessionID)) {
      throw new Session.BusyError({ sessionID })
    }

    const abort = start(sessionID)
    if (!abort) {
      const active = state()[sessionID]
      if (!active) {
        return runLoop(sessionID)
      }

      if (active.abort.signal.aborted) {
        await active.done
        return runLoop(sessionID)
      }

      return new Promise<MessageV2.WithParts>((resolve, reject) => {
        const cb = { resolve, reject }
        active.callbacks.push(cb)

        const current = state()[sessionID]
        if (current === active) return

        const idx = active.callbacks.indexOf(cb)
        if (idx !== -1) {
          active.callbacks.splice(idx, 1)
        }

        resolve(runLoop(sessionID))
      })
    }

    using _ = defer(() => cancelLocal(sessionID, { force: false }))
    overflowNotice()

    let step = 0
    let pendingPersistFailures = 0
    const overflow = { min: undefined as number | undefined }
    let resume: WaitResume | undefined
    while (true) {
      log.info("loop", { step, sessionID })
      if (abort.aborted) break

      const wait = WaitPolicy.get(sessionID)
      if (wait) {
        const pendingMessages = SessionMessage.peekPending(sessionID)
        const nonSource = pendingMessages.filter((msg) => !waitMatchesSource({ message: msg, sources: wait.sources }))
        if (nonSource.length > 0) {
          const settled = await Promise.allSettled(nonSource.map((msg) => persistInbound(msg)))
          const ok = new Set<string>()
          const human = nonSource.some((msg) => msg.from === "human")

          for (const [i, msg] of nonSource.entries()) {
            if (settled[i]?.status === "fulfilled") ok.add(msg.id)
          }

          if (ok.size > 0) {
            SessionMessage.takePending(
              sessionID,
              (msg) => ok.has(msg.id) && !waitMatchesSource({ message: msg, sources: wait.sources }),
            )
          }

          if (human) {
            await interruptWait(sessionID, wait, "prompt").catch((error) => {
              log.error("failed to interrupt wait in run loop", { sessionID, error: error?.message })
            })

            WaitPolicy.clear(sessionID)
            SessionStatus.set(sessionID, { type: "busy" })
            continue
          }
        }

        const respondedFromSources = SessionMessage.respondedRecoverable({
          to: sessionID,
          sources: wait.sources,
          since: wait.since,
        })

        const result = WaitPolicy.evaluate({
          policy: wait,
          respondedFromSources,
        })

        if (!result.ready) {
          SessionStatus.set(sessionID, {
            type: "waiting",
            sources: wait.sources,
            timeout: wait.timeout,
            mode: wait.mode,
            since: wait.since,
            time: wait.time,
          })
          break
        }

        WaitPolicy.clear(sessionID)
        SessionStatus.set(sessionID, { type: "busy" })

        const pending = SessionMessage.peekPending(sessionID)

        const settled = await Promise.allSettled(pending.map((m) => persistInbound(m)))
        const ok = new Set<string>()
        for (const [i, msg] of pending.entries()) {
          if (settled[i]?.status === "fulfilled") ok.add(msg.id)
        }
        if (ok.size > 0) {
          SessionMessage.takePending(sessionID, (msg) => ok.has(msg.id))
        }

        const respondedSources = result.respondedSources
        const timedOutSources = result.timedOut ? result.missingSources : []

        resume =
          respondedSources.length > 0
            ? {
                since: wait.since,
                sources: new Set(respondedSources),
              }
            : undefined

        // Generate ONE comprehensive wait result message (system message)
        if (result.timedOut) {
          const wildcard = wait.sources.length === 1 && wait.sources[0] === "*"

          const ids = wildcard ? respondedSources : Array.from(new Set([...respondedSources, ...timedOutSources]))
          const sessions = await Promise.all(ids.map((id) => Session.get(id).catch(() => undefined)))

          const agents: Record<string, string> = {}
          ids.forEach((id, i) => {
            const name = sessions[i]?.agentName
            if (typeof name !== "string" || name.length === 0) return
            agents[id] = name
          })

          const statusMap = wildcard
            ? ({} as Record<string, SessionStatus.Info | undefined>)
            : await SessionStatusResolver.many(timedOutSources)

          const snapshots = wildcard
            ? ([] as MessageParser.TimeoutSnapshot[])
            : timedOutSources.map((source): MessageParser.TimeoutSnapshot => {
                const st = statusMap[source]
                const agent = agents[source]
                if (!st) return { source, agent, run: "unknown" }
                if (st.type === "idle") {
                  return { source, agent, run: "idle" }
                }
                if (st.type === "busy") {
                  return { source, agent, run: "working" }
                }
                if (st.type === "retry") {
                  return {
                    source,
                    agent,
                    run: "retry",
                    retry: {
                      attempt: st.attempt,
                      message: st.message,
                      next: st.next,
                    },
                  }
                }
                if (st.type === "waiting") {
                  return {
                    source,
                    agent,
                    run: "waiting",
                    waiting: {
                      sources: st.sources,
                      mode: st.mode,
                      deadline: st.time.deadline,
                    },
                  }
                }
                return { source, agent, run: "unknown" }
              })

          const waitResultMessage: SessionMessage.Message = {
            id: Identifier.ascending("message"),
            seq: 0,
            from: "Wait result",
            to: sessionID,
            text: MessageParser.formatWaitResult({
              timeoutMs: wait.timeout,
              mode: wait.mode,
              responded: respondedSources,
              timedOut: snapshots,
              agents,
              wildcard,
            }),
            time: Date.now(),
            messageType: "wait_result",
          }

          await persistInbound(waitResultMessage)
        }

        const parts = await MessageV2.parts(wait.messageID)
        const tool = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === wait.callID)

        if (tool && tool.state.status === "completed") {
          const status = result.timedOut ? "timedOut" : "resolved"
          const allReceived = wait.mode === "all" && !result.timedOut

          const resolvedAt = Date.now()
          const respondedSeqs = Object.fromEntries(
            respondedSources.map((source) => [source, SessionMessage.lastSeq(sessionID, source)]),
          )
          const timedOutSeqs = Object.fromEntries(
            timedOutSources.map((source) => [source, SessionMessage.lastSeq(sessionID, source)]),
          )

          const meta = {
            ok: true,
            status,
            sources: wait.sources,
            respondedSources,
            respondedSeqs,
            timedOutSources,
            timedOutSeqs,
            timeout: wait.timeout,
            mode: wait.mode,
            allReceived,
            since: wait.since,
            createdAt: wait.time.created,
            deadline: wait.time.deadline,
            resolvedAt,
          }

          const output = waitOutputText({
            status,
            mode: wait.mode,
            since: wait.since,
            respondedSources,
            respondedSeqs,
            timedOutSources,
            timedOutSeqs,
          })

          await Session.updatePart({
            ...tool,
            state: {
              ...tool.state,
              title: status === "resolved" ? "Wait resolved" : "Wait timed out",
              output,
              metadata: meta,
            },
          })
        }

        SessionStatus.set(sessionID, { type: "busy" })
        continue
      }

      SessionStatus.set(sessionID, { type: "busy" })

      // For subagents with a prompt, create an initial user message if none exists
      const sessionInfo = await Session.get(sessionID)
      if (sessionInfo.sessionType === "subagent" && sessionInfo.subagentPrompt) {
        const existingMsgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
        if (existingMsgs.length === 0) {
          const agentName = sessionInfo.agentName ?? (await lastAgent(sessionID))
          const agentInfo = await Agent.get(agentName)
          const initialMessage: MessageV2.User = {
            id: Identifier.ascending("message"),
            sessionID,
            time: { created: Date.now() },
            role: "user",
            agent: agentName,
            model: agentInfo?.model ?? (await lastModel(sessionID)),
          }
          await Session.updateMessage(initialMessage)

          const initialPart: MessageV2.TextPart = {
            id: Identifier.ascending("part"),
            messageID: initialMessage.id,
            sessionID,
            type: "text",
            text: "Begin your task as specified in the system prompt.",
            synthetic: true,
            metadata: {
              opencode: {
                bootstrap: true,
              },
            },
          }
          await Session.updatePart(initialPart)
          // Continue loop to process the initial message
          continue
        }
      }

      // Check for incoming messages from other sessions
      if (SessionMessage.hasPending(sessionID)) {
        const pending = SessionMessage.peekPending(sessionID)
        if (pending.length > 0) {
          const settled = await Promise.allSettled(pending.map((m) => persistInbound(m)))
          const ok = new Set<string>()
          for (const [i, msg] of pending.entries()) {
            if (settled[i]?.status === "fulfilled") ok.add(msg.id)
          }

          if (ok.size === 0) {
            pendingPersistFailures++
            const delay = Math.min(100 * Math.pow(2, pendingPersistFailures - 1), 2000)
            await SessionRetry.sleep(delay, abort).catch(() => {})
          }

          if (ok.size > 0) {
            pendingPersistFailures = 0
            SessionMessage.takePending(sessionID, (msg) => ok.has(msg.id))
          }
        }
        if (pending.length === 0) {
          pendingPersistFailures = 0
        }
        // Continue loop to process the incoming messages
        continue
      }

      const session = await Session.get(sessionID)
      const cfg = await Config.get()
      const msgs = await Session.messages({ sessionID })

      let lastFinished: MessageV2.Assistant | undefined
      const tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastFinished && msg.info.role === "assistant" && (msg.info as MessageV2.Assistant).finish) {
          lastFinished = msg.info as MessageV2.Assistant
        }
        if (!lastFinished) {
          const task = msg.parts.filter(
            (part): part is MessageV2.CompactionPart | MessageV2.SubtaskPart =>
              part.type === "compaction" || part.type === "subtask",
          )
          if (task.length > 0) {
            tasks.push(...task)
          }
        }
        if (lastFinished) break
      }

      const byParent = new Map<string, MessageV2.WithParts[]>()
      for (const msg of msgs) {
        if (msg.info.role !== "assistant") continue
        const assistant = msg.info as MessageV2.Assistant
        if (!assistant.parentID) continue
        const existing = byParent.get(assistant.parentID) ?? []
        existing.push(msg)
        byParent.set(assistant.parentID, existing)
      }

      const users = msgs.filter(isUserRelevant)
      const covered = new Set(msgs.flatMap(coveredUsers))
      const newestUser = msgs.findLast((m) => m.info.role === "user")?.info as MessageV2.User | undefined
      const newestAssistant = msgs.findLast((m) => m.info.role === "assistant")?.info as MessageV2.Assistant | undefined

      // If the previous run was interrupted mid-thinking, we can end up with an assistant message that contains only
      // reasoning parts and no final output/tool call. Some providers (eg, Claude) reject such empty messages after
      // unsupported parts are dropped. Keep the thinking in history, but omit it from the model context and mark it.
      if (newestAssistant && newestUser && newestUser.id > newestAssistant.id && !newestAssistant.finish) {
        const orphan = msgs.find((m) => m.info.role === "assistant" && m.info.id === newestAssistant.id)
        if (orphan) {
          await omitOrphanThinking({
            sessionID,
            assistant: orphan,
            continuedAtMessageID: newestUser.id,
          })
        }
      }

      // Context-length retries and other failures can leave behind assistant messages with only reasoning.
      // Those messages are visible to the user, but must not be included in provider context on the next attempt.
      await omitIncompleteThinking({ sessionID, messages: msgs })

      const unanswered = (msg: MessageV2.WithParts) => {
        const user = msg.info as MessageV2.User
        const replies = byParent.get(user.id) ?? []
        return !isAnswered({
          userID: user.id,
          replies,
          covered,
        })
      }

      const pending = users.find(unanswered)

      if (!pending) {
        log.info("exiting loop", { sessionID })
        break
      }

      const pendingIndex = users.findIndex((msg) => msg.info.id === pending.info.id)
      if (pendingIndex === -1) {
        throw new Error("Pending user message not found in history. This should never happen.")
      }
      const inbox = inboxMessage(pending)
      const endIndex = inbox
        ? inboxBatchEnd({
            users,
            start: pendingIndex,
            isUnanswered: unanswered,
          })
        : taskBatchEnd({
            users,
            start: pendingIndex,
            isUnanswered: unanswered,
          })
      const queued = users.slice(pendingIndex, endIndex + 1)

      const last = msgs.find((m) => m.info.role === "user")
      if (step === 0 && last) {
        ensureTitle({
          session,
          modelID: (pending.info as MessageV2.User).model.modelID,
          providerID: (pending.info as MessageV2.User).model.providerID,
          message: last,
          history: msgs,
        }).catch((error) => {
          log.error("failed to ensure title", { sessionID, error: error?.message })
        })
      }

      step++

      const lastUser = pending.info as MessageV2.User
      const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID)

      if (inbox || resume !== undefined) {
        const settled = await settleInbox(sessionID, abort)
        if (!settled) continue
      }
      const task = tasks.pop()

      // pending subtask - spawn a subagent session (async)
      if (task?.type === "subtask") {
        const agent = await Agent.get(task.agent)
        if (!agent) throw new Error(`Unknown agent: ${task.agent}`)
        if (agent.mode === "primary") throw new Error(`Cannot spawn primary agent as subagent: ${task.agent}`)

        const startedAt = Date.now()
        const seq = SessionMessage.checkpoint(sessionID)

        const ref = task.model ?? agent.model ?? (await lastModel(sessionID))

        const args = { agents: [{ agent: task.agent, prompt: task.prompt }] }

        const msg = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: lastUser.agent,
          agent: lastUser.agent,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant

        const part = (await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: msg.id,
          sessionID,
          type: "tool",
          callID: ulid(),
          tool: "subagent_spawn",
          state: {
            status: "running",
            input: args,
            time: {
              start: startedAt,
            },
          },
        })) as MessageV2.ToolPart

        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: "subagent_spawn",
            sessionID,
            callID: part.callID,
          },
          { args },
        )

        const limits = await Config.get().then((cfg) => LLMConcurrencyMachine.limits(cfg))
        if (limits) {
          const modelRef = await Provider.getModel(ref.providerID, ref.modelID).catch(() => undefined)
          const modelName = modelRef?.api.id ?? ref.modelID
          const key = LLMConcurrencyMachine.bucketKey({ providerID: ref.providerID, modelName })
          const request = LLMConcurrencyMachine.request(limits, [key])
          const current = await LLMConcurrencyMachine.snapshot(limits)
          const blocked = LLMConcurrencyMachine.blocked(limits, current, request)

          if (blocked.length > 0) {
            const map = LLMConcurrencyMachine.limitMap(limits)
            const lines = [
              "subagent_spawn blocked: global LLM concurrency limit reached",
              "",
              "Blocked patterns:",
              ...blocked.map((pattern) => {
                const lim = map[pattern]
                const cur = current.counts[pattern] ?? (pattern === "*" ? current.total : 0)
                const add = request.counts[pattern] ?? (pattern === "*" ? request.total : 0)
                return `- ${pattern}: ${cur}/${lim} (requested +${add})`
              }),
              "",
              "Continue without spawning subagents or retry later.",
            ]

            const result = {
              title: "subagent_spawn blocked: global concurrency limit reached",
              metadata: {
                ok: false,
                status: "blocked",
                reason: "global_llm_concurrency_limit",
                blocked,
                limits: map,
                staleMs: limits.staleMs,
                current,
                requested: request,
                spawned: [] as Array<{ session_id: string; agent: string }>,
                errors: ["Blocked by global LLM concurrency limit"],
                seq,
              },
              output: lines.join("\n"),
            }

            await Plugin.trigger(
              "tool.execute.after",
              {
                tool: "subagent_spawn",
                sessionID,
                callID: part.callID,
              },
              result,
            )

            await Session.updatePart({
              ...part,
              state: {
                status: "completed",
                input: args,
                title: result.title,
                metadata: result.metadata,
                output: result.output,
                time: {
                  start: startedAt,
                  end: Date.now(),
                },
              },
            } satisfies MessageV2.ToolPart)

            msg.finish = "tool-calls"
            msg.time.completed = Date.now()
            await Session.updateMessage(msg)

            break
          }
        }

        const child = await Session.createNext({
          directory: Instance.directory,
          sessionType: "subagent",
          agentName: task.agent,
          parentID: sessionID,
          subagentPrompt: task.prompt,
          title: `Subagent - ${task.agent}`,
        })

        await Session.addChild({
          parentID: sessionID,
          childID: child.id,
        })

        const seed: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: child.id,
          role: "user",
          time: {
            created: Date.now(),
          },
          agent: task.agent,
          model: ref,
        }

        await Session.updateMessage(seed)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: seed.id,
          sessionID: child.id,
          type: "text",
          text: "Begin your task as specified in the system prompt.",
          synthetic: true,
          metadata: {
            opencode: {
              bootstrap: true,
            },
          },
        } satisfies MessageV2.TextPart)

        const parentID = sessionID
        SessionPrompt.loop(child.id).catch(async (error) => {
          log.error("subagent crashed", {
            sessionID: child.id,
            agent: task.agent,
            error: error?.message || String(error),
          })

          await inSessionDirectory(parentID, () =>
            SessionMessage.deliver({
              from: child.id,
              to: parentID,
              text: `Subagent error: ${error?.message || "Unknown error"}`,
              messageType: "error",
            }),
          )

          SessionStatus.set(child.id, { type: "idle" })
        })

        const output = [`Spawned 1 agent(s):`, `checkpoint_seq: ${seq}`, `- ${child.id} (${task.agent})`].join("\n")
        const result = {
          title: "Spawned 1 agent(s)",
          metadata: {
            ok: true,
            status: "spawned",
            spawned: [{ session_id: child.id, agent: task.agent }],
            errors: [] as string[],
            seq,
          },
          output,
        }

        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "subagent_spawn",
            sessionID,
            callID: part.callID,
          },
          result,
        )

        await Session.updatePart({
          ...part,
          state: {
            status: "completed",
            input: args,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            time: {
              start: startedAt,
              end: Date.now(),
            },
          },
        } satisfies MessageV2.ToolPart)

        msg.finish = "tool-calls"
        msg.time.completed = Date.now()
        await Session.updateMessage(msg)

        break
      }

      // pending compaction
      if (task?.type === "compaction") {
        const idx = msgs.findIndex((m) => m.info.id === task.messageID)
        const scoped = idx >= 0 ? msgs.slice(0, idx + 1) : msgs

        const startedAt =
          idx >= 0 && msgs[idx].info.role === "user" ? (msgs[idx].info as MessageV2.User).time.created : Date.now()

        await SessionCompaction.mark({
          sessionID,
          requestID: task.messageID,
          startedAt,
        })

        const active = state()[sessionID]
        if (active) {
          active.compaction = {
            requestID: task.messageID,
            startedAt,
          }
        }

        using _ = defer(() => {
          const current = state()[sessionID]
          if (!current?.compaction) return
          if (current.compaction.requestID !== task.messageID) return
          delete current.compaction
        })

        const result = await SessionCompaction.process({
          messages: scoped,
          parentID: task.messageID,
          abort,
          sessionID,
          auto: task.auto,
        })
        if (result === "stop") break
        continue
      }

      // normal processing
      const agent = await Agent.get(lastUser.agent)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps

      let cpd = pipelineEnabled(cfg) ? await SessionCPD.get(sessionID) : undefined

      const baseIndex = (() => {
        const upto = cpd?.upto
        if (!upto) return 0
        const next = users.findIndex((m) => m.info.id > upto)
        if (next === -1) return users.length
        return next
      })()
      const startIndex = baseIndex > pendingIndex ? pendingIndex : baseIndex

      const slice = users.slice(startIndex, endIndex + 1)
      const resumed = resume
      const forwardTail =
        resumed === undefined ? [] : users.slice(pendingIndex + 1).filter((msg) => waitReply({ msg, resume: resumed }))
      const fallbackTail = resumed === undefined ? [] : users.filter((msg) => waitReply({ msg, resume: resumed }))
      const resumeTail = resumed === undefined ? [] : forwardTail.length > 0 ? forwardTail : fallbackTail
      const queuedIDs = new Set(queued.map((msg) => msg.info.id))
      const tail = resumed === undefined ? [] : resumeTail.filter((msg) => !queuedIDs.has(msg.info.id))
      resume = undefined

      const scope = tail.length > 0 ? [...slice, ...tail] : slice
      const thread = scope.flatMap((m) => [m, ...(byParent.get(m.info.id) ?? [])])
      const scoped = await insertReminders({ messages: thread, agent, session })

      let sessionMessages = clone(scoped)
      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })
      sessionMessages = normalizeContextMessages({ messages: sessionMessages, reference: scoped })

      const outputReserve = Math.min(model.limit.output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
      const usable = model.limit.input || model.limit.context - outputReserve
      const budget = Math.max(0, Math.floor(usable * 0.9))
      const stricterBudget = Math.max(0, Math.floor(budget * 0.85))

      const buildSystem = async () => {
        const current = await Session.get(sessionID)
        const modelID = model.api?.id ?? model.id
        const envKey = `${model.providerID}/${modelID}`
        return {
          session: current,
          system: [
            ...(await getCachedEnvironment(sessionID, {
              key: envKey,
              load: () => SystemPrompt.environment(model),
            })),
            ...SystemPrompt.messageProtocol(current.sessionType, sessionID, current.parentID, current.subagentPrompt),
            ...(cpd ? [cpdBlock(cpd.text)] : []),
            integrity(current),
            ...(await InstructionPrompt.system()),
          ],
        }
      }

      const estimateCurrent = async () => {
        const built = await buildSystem()
        const mm = MessageV2.toModelMessages(sessionMessages, model)
        return {
          system: built.system,
          session: built.session,
          estimate: estimateSystem(built.system) + estimateModel(mm),
        }
      }

      type MaintenanceMarker = {
        kind: "trim" | "think" | "rctx"
        at: number
        count?: number
        tokens?: number
      }

      const appendMarkers = async (input: { messageID: string; markers: MaintenanceMarker[] }) => {
        if (input.markers.length === 0) return

        for (const marker of input.markers) {
          const text = iife(() => {
            if (marker.kind === "trim") {
              const count = marker.count ?? 0
              const tokens = marker.tokens ?? 0
              return `Tool outputs trimmed (${count}; ~${tokens.toLocaleString()} tokens)`
            }

            if (marker.kind === "rctx") {
              return "Provider rejected prior reasoning context (rctx)"
            }

            const steps = marker.count ?? 0
            const tokens = marker.tokens ?? 0
            return `Older reasoning omitted (${steps} step${steps === 1 ? "" : "s"}; ~${tokens.toLocaleString()} tokens)`
          })

          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: input.messageID,
            sessionID,
            type: "text",
            synthetic: true,
            ignored: true,
            text,
            time: {
              start: marker.at,
              end: marker.at,
            },
            metadata: {
              opencode: {
                marker,
              },
            },
          })
        }
      }

      const applyMaintenance = async (input: {
        cause: AutoCompactionCause
        forced?: boolean
        allowed?: boolean
        aggressive?: boolean
        min?: number
      }): Promise<
        { ok: true; markers: MaintenanceMarker[] } | { ok: false; message: string; markers: MaintenanceMarker[] }
      > => {
        const markers: MaintenanceMarker[] = []
        const enabled = pipelineEnabled(cfg) && usable > 0
        if (!enabled) return { ok: true, markers }

        const target = input.forced ? stricterBudget : budget
        const snapshot = await estimateCurrent()
        const signal = typeof input.min === "number" && input.min > 0 ? input.min : 0
        const needs = input.forced === true || snapshot.estimate > target || signal > 0
        if (!needs) return { ok: true, markers }

        const allowed = input.allowed ?? (await allowMaintenance({ sessionID, cause: input.cause }))
        if (!allowed) {
          return {
            ok: false,
            message:
              "Context limit reached and auto context maintenance is disabled. Run /compact or allow auto compaction.",
            markers,
          }
        }

        const started = Date.now()

        // Used to tag inbound/human messages that arrive mid-maintenance.
        const active = state()[sessionID]
        if (active) {
          active.compaction = {
            requestID: lastUser.id,
            startedAt: started,
          }
        }

        await Session.update(sessionID, (draft) => {
          draft.time.compacting = started
        })

        await using _ = defer(() =>
          iife(() => {
            const live = state()[sessionID]
            if (live?.compaction?.startedAt === started && live.compaction.requestID === lastUser.id) {
              live.compaction = undefined
            }

            return Session.update(sessionID, (draft) => {
              if (draft.time.compacting === started) draft.time.compacting = undefined
            })
              .then(() => {})
              .catch(() => {})
          }),
        )

        const basis = await estimateCurrent()
        const rawExcess = basis.estimate - target
        // Keep a minimum reduction target when the caller provides one.
        const base = rawExcess > 0 ? rawExcess : 0
        const forcedMin = input.forced ? Math.max(500, Math.floor(target * 0.05)) : 0
        const baseline = input.forced ? Math.max(base, forcedMin) : base
        const excess = Math.max(baseline, signal)

        // 1) Trim tool outputs first
        const toolsToTrim = sessionMessages
          .flatMap((m) => m.parts)
          .filter((p): p is MessageV2.ToolPart => p.type === "tool")
          .filter((p) => p.tool !== "skill")

        let freed = 0
        let trimmedCount = 0
        for (const part of toolsToTrim) {
          if (freed >= excess) break
          if (part.state.status !== "completed") continue
          if (part.state.time.compacted) continue
          freed += Token.estimate(part.state.output)
          trimmedCount += 1
          part.state.time.compacted = started
          await Session.updatePart(part)
        }

        if (freed > 0) {
          await SessionCPD.flag(sessionID, { trim: true })
          markers.push({
            kind: "trim",
            at: started,
            count: trimmedCount,
            tokens: freed,
          })
        }

        const trimmed = freed > 0

        // 2) Compact only the prefix before the anchor user into CPD
        const afterTrim = await estimateCurrent()
        const prefixUsers = users.slice(startIndex, pendingIndex)
        const uptoUser = prefixUsers.at(-1)?.info.id
        const canAdvanceCPD = (() => {
          if (!uptoUser) return false

          const current = cpd?.upto
          if (!current) return true
          if (current === uptoUser) return false

          const currentIndex = users.findIndex((m) => m.info.id === current)
          const nextIndex = users.findIndex((m) => m.info.id === uptoUser)
          if (currentIndex === -1 || nextIndex === -1) return true
          return nextIndex > currentIndex
        })()

        const shouldUpdateCPD = afterTrim.estimate > target || (input.forced === true && canAdvanceCPD)

        const cpdAdvanced = await iife(async () => {
          if (!shouldUpdateCPD) return false
          if (!uptoUser) return false
          if (!canAdvanceCPD) return false

          // CPD delta must follow turn-order, not message-id order.
          const pivot = sessionMessages.findIndex((m) => m.info.role === "user" && m.info.id === lastUser.id)
          if (pivot === -1) {
            log.error("target user not found in scoped messages", {
              sessionID,
              messageID: lastUser.id,
            })
            return false
          }

          const prefixMsgs = pivot <= 0 ? [] : sessionMessages.slice(0, pivot)
          const visiblePrefixMsgs = prefixMsgs.filter((message) => MessageV2.modelVisible(message))
          const projection = SkillProjection.project(
            visiblePrefixMsgs.map((msg) => ({
              id: msg.info.id,
              role: msg.info.role,
              parts: msg.parts,
            })),
          )

          const delta = visiblePrefixMsgs
            .map((m) => {
              const role = m.info.role === "user" ? "User" : "Assistant"
              const texts = m.parts
                .filter((p): p is MessageV2.TextPart => p.type === "text")
                .filter((p) => {
                  if (m.info.role !== "user") return !p.ignored && p.synthetic !== true
                  return isTextRelevant(p)
                })
                .map((p) => p.text.trim())
                .filter((t) => t)
              const files = m.parts
                .filter((p): p is MessageV2.FilePart => p.type === "file")
                .map((f) => `File: ${MessageV2.fileLabel(f)} (${f.mime})`)
              const msgs = m.parts
                .filter((p): p is MessageV2.MessagePart => p.type === "message" && p.direction === "incoming")
                .map((p) => `Message from ${p.peer}:\n${p.text}`)
              const tools = m.parts
                .filter((p): p is MessageV2.ToolPart => p.type === "tool")
                .flatMap((p) => {
                  if (m.info.role !== "assistant") return []
                  if (p.state.status !== "completed") return []
                  if (p.tool === "skill" && projection.supersededPartIDs.has(p.id)) return []
                  if (p.tool === "skill") {
                    const meta = p.state.metadata
                    if (meta && typeof meta === "object" && (meta as { applied?: unknown }).applied === false) {
                      return []
                    }
                  }

                  const raw = p.state.output
                  const excerpt = MessageV2.excerpt(raw, 4000)
                  const truncated = excerpt !== raw
                  const note = truncated ? `[Output truncated for CPD delta (${raw.length} chars total)]` : ""
                  const trimmed = p.state.time.compacted ? "[Tool output trimmed in continuation prompt]" : ""
                  const body = [excerpt, note, trimmed].filter((x) => x).join("\n")

                  return [[`Tool ${p.tool}:`, `Input: ${JSON.stringify(p.state.input)}`, `Output:\n${body}`].join("\n")]
                })
              const markers = iife(() => {
                const names = projection.supersededNamesByMessageID.get(m.info.id)
                if (!names || names.length === 0) return ""
                return `Context note: superseded skill loads omitted: ${names.join(", ")}. Newer successful loads are authoritative.`
              })
              const blocks = [
                texts.join("\n"),
                files.join("\n"),
                msgs.join("\n\n"),
                tools.join("\n\n"),
                markers,
              ].filter((x) => x)
              if (blocks.length === 0) return ""
              return [`[${role}]`, ...blocks].join("\n")
            })
            .filter((x) => x)
            .join("\n\n")

          const request = queued
            .map((msg) => {
              return msg.parts
                .filter((p): p is MessageV2.TextPart => p.type === "text")
                .filter(isTextRelevant)
                .map((p) => p.text.trim())
                .filter((t) => t)
                .join("\n")
            })
            .filter((text) => text.length > 0)
            .join("\n\n")
            .trim()

          const reasoning = (() => {
            const assistant = sessionMessages.findLast(
              (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "reasoning" && !p.ignored),
            )
            if (!assistant) return

            const parts = assistant.parts
            const start = (() => {
              for (let i = parts.length - 1; i >= 0; i--) {
                if (parts[i]?.type === "step-start") return i
              }
              return 0
            })()
            const segment = parts.slice(start)
            const reasoningParts = segment.filter(
              (p): p is MessageV2.ReasoningPart => p.type === "reasoning" && !p.ignored,
            )
            if (reasoningParts.length === 0) return
            return {
              role: "assistant" as const,
              content: reasoningParts.map((p) => ({
                type: "reasoning" as const,
                text: p.text,
                providerOptions: p.metadata,
              })),
            } satisfies ModelMessage
          })()

          const current = await Session.get(sessionID)
          const hadRctx = current.context?.rctx === true
          const updated = await SessionCPD.update({
            sessionID,
            model: lastUser.model,
            user: {
              sessionID,
              id: lastUser.id,
              model: lastUser.model,
              agent: lastUser.agent,
            },
            tail: {
              request,
              flags: {
                trim: current.context?.trim === true,
                think: current.context?.think === true,
                rctx: current.context?.rctx === true,
              },
            },
            reasoning,
            existing: cpd?.text,
            delta,
            abort,
          })

          await SessionCPD.set(sessionID, {
            text: updated.text,
            upto: uptoUser,
            updated: Date.now(),
          })
          if (updated.rctx) {
            await SessionCPD.flag(sessionID, { rctx: true })

            if (!hadRctx) {
              markers.push({
                kind: "rctx",
                at: started,
              })
            }
          }
          cpd = await SessionCPD.get(sessionID)

          const rebased = cpd?.upto
          const nextBase = (() => {
            if (!rebased) return 0
            const next = users.findIndex((m) => m.info.id > rebased)
            if (next === -1) return users.length
            return next
          })()
          const nextStart = nextBase > pendingIndex ? pendingIndex : nextBase
          const nextSlice = users.slice(nextStart, endIndex + 1)
          const nextThread = nextSlice.flatMap((m) => [m, ...(byParent.get(m.info.id) ?? [])])
          const nextScoped = await insertReminders({ messages: nextThread, agent, session })
          sessionMessages = clone(nextScoped)
          await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })
          sessionMessages = normalizeContextMessages({ messages: sessionMessages, reference: nextScoped })
          return true
        })

        // 3) If still over, truncate older reasoning steps
        const afterCPD = await estimateCurrent()
        const forcedFallback = input.forced === true && !trimmed && !cpdAdvanced
        const needed = (() => {
          const raw = afterCPD.estimate - target
          const overflow = raw > 0 ? raw : 0
          if (input.aggressive === true) return Math.max(overflow, excess)
          if (forcedFallback) return Math.max(overflow, excess)
          return overflow
        })()

        const dropped = await iife(async () => {
          if (needed <= 0) return 0

          const steps = [] as MessageV2.ReasoningPart[][]
          for (const msg of sessionMessages) {
            if (msg.info.role !== "assistant") continue
            const parts = msg.parts
            let bucket: MessageV2.ReasoningPart[] = []
            for (const part of parts) {
              if (part.type === "step-start") {
                if (bucket.length > 0) steps.push(bucket)
                bucket = []
              }
              if (part.type === "reasoning" && !part.ignored) {
                bucket.push(part)
              }
              if (part.type === "step-finish") {
                if (bucket.length > 0) steps.push(bucket)
                bucket = []
              }
            }
            if (bucket.length > 0) steps.push(bucket)
          }

          let dropped = 0
          let droppedSteps = 0
          for (const group of steps) {
            if (dropped >= needed) break
            let groupDropped = false
            for (const part of group) {
              if (part.ignored) continue
              dropped += Token.estimate(part.text)
              groupDropped = true
              part.ignored = true
              const base =
                part.metadata && typeof part.metadata === "object" ? (part.metadata as Record<string, unknown>) : {}
              const existing =
                base.opencode && typeof base.opencode === "object" ? (base.opencode as Record<string, unknown>) : {}
              part.metadata = {
                ...base,
                opencode: {
                  ...existing,
                  status: "omitted",
                  reason: "context_limit",
                  at: Date.now(),
                },
              }
              await Session.updatePart(part)
            }
            if (groupDropped) droppedSteps += 1
          }

          if (dropped > 0) {
            await SessionCPD.flag(sessionID, { think: true })
            markers.push({
              kind: "think",
              at: started,
              count: droppedSteps,
              tokens: dropped,
            })
          }

          return dropped
        })

        const progressed = trimmed || cpdAdvanced || dropped > 0
        if (input.forced === true && !progressed) {
          return {
            ok: false,
            message:
              "Context length errors persist but no further context maintenance is possible (no tool outputs to trim, no prefix turns to compact, no reasoning to truncate). Try splitting your prompt or selecting a larger-context model.",
            markers,
          }
        }

        const final = await estimateCurrent()
        if (final.estimate > target) {
          return {
            ok: false,
            message:
              "Cannot fit context even after trimming tool outputs, updating CPD, and truncating older reasoning. Try splitting your prompt or selecting a larger-context model.",
            markers,
          }
        }

        return { ok: true, markers }
      }

      const pendingMarkers: MaintenanceMarker[] = []

      const preflight = await applyMaintenance({
        cause: "overflow",
        min: overflow.min,
        aggressive: overflow.min !== undefined,
      })
      overflow.min = undefined
      pendingMarkers.push(...preflight.markers)
      if (!preflight.ok) {
        const error = new NamedError.Unknown({ message: preflight.message }).toObject()
        const msg = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
            completed: Date.now(),
          },
          finish: "error",
          error,
          sessionID,
        })) as MessageV2.Assistant

        await appendMarkers({ messageID: msg.id, markers: pendingMarkers }).catch(() => {})
        Bus.publish(Session.Event.Error, {
          sessionID: msg.sessionID,
          error,
        })
        break
      }

      if (step === 1) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        }).catch((error) => {
          log.error("failed to summarize session", { sessionID, error: error?.message })
        })
      }

      let processed: MessageV2.Assistant | undefined
      const outcome = await iife(async () => {
        let attempts = 0
        while (true) {
          const processor = SessionProcessor.create({
            assistantMessage: (await Session.updateMessage({
              id: Identifier.ascending("message"),
              parentID: lastUser.id,
              role: "assistant",
              mode: agent.name,
              agent: agent.name,
              path: {
                cwd: Instance.directory,
                root: Instance.worktree,
              },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              modelID: model.id,
              providerID: model.providerID,
              time: {
                created: Date.now(),
              },
              sessionID,
            })) as MessageV2.Assistant,
            sessionID: sessionID,
            model,
            abort,
          })

          if (pendingMarkers.length > 0) {
            await appendMarkers({ messageID: processor.message.id, markers: pendingMarkers }).catch(() => {})
            pendingMarkers.length = 0
          }
          const live = await Session.get(sessionID)
          const wc = waitContext(sessionMessages)
          const visibleSkillMessages = sessionMessages.filter((message) => MessageV2.modelVisible(message))
          const skillContext = {
            messageIDs: Array.from(new Set(visibleSkillMessages.map((message) => message.info.id))),
            messages: visibleSkillMessages,
          }
          const tools = await resolveTools({
            agent,
            session: live,
            model,
            tools: lastUser.tools,
            processor,
            messages: msgs,
            skillContext,
            waitContext: wc,
          })

          const built = await buildSystem()
          const result = await processor.process({
            user: lastUser,
            agent,
            abort,
            sessionID,
            system: built.system,
            messages: [
              ...MessageV2.toModelMessages(sessionMessages, model),
              ...(isLastStep
                ? [
                    {
                      role: "assistant" as const,
                      content: MAX_STEPS,
                    },
                  ]
                : []),
            ],
            tools,
            model,
          })

          if (result !== "compact") {
            processed = processor.message
            return result
          }

          const request = processor.compactionRequest
          if (request?.reason !== "context_length") {
            const tokens = processor.message.tokens
            const used = tokens.input + tokens.cache.read + tokens.output
            const over = used - usable
            const bump = over > 0 ? over : 0
            const min = Math.min(20_000, Math.max(500, bump + 500))
            overflow.min = min

            // Overflow is handled by the next preflight; don't retry a completed call.
            processed = processor.message
            return "continue" as const
          }

          const allowed = await allowMaintenance({ sessionID, cause: "context_length" })
          if (!allowed) {
            const fallback = request.fallbackError
            processor.message.error = fallback
            processor.message.finish = "error"
            processor.message.time.completed = processor.message.time.completed ?? Date.now()
            await Session.updateMessage(processor.message)
            Bus.publish(Session.Event.Error, {
              sessionID: processor.message.sessionID,
              error: fallback,
            })
            processed = processor.message
            return "stop" as const
          }

          attempts++
          if (attempts >= 3) {
            const provider = contextLengthProviderMessage(request.fallbackError)
            const message =
              "Context length errors persist after automatic context maintenance. Try splitting your prompt or selecting a larger-context model." +
              (provider ? `\n\nProvider error:\n${provider}` : "")
            const error = new NamedError.Unknown({
              message,
            }).toObject()
            processor.message.error = error
            processor.message.finish = "error"
            processor.message.time.completed = Date.now()
            await Session.updateMessage(processor.message)
            Bus.publish(Session.Event.Error, {
              sessionID: processor.message.sessionID,
              error,
            })
            processed = processor.message
            return "stop" as const
          }

          const min = contextLengthMinDrop({
            error: request.fallbackError,
            attempt: attempts,
            target: stricterBudget,
          })

          const maintenance = await applyMaintenance({
            cause: "context_length",
            forced: true,
            allowed: true,
            aggressive: attempts >= 2,
            min,
          })
          pendingMarkers.push(...maintenance.markers)
          if (!maintenance.ok) {
            const error = new NamedError.Unknown({ message: maintenance.message }).toObject()
            processor.message.error = error
            processor.message.finish = "error"
            processor.message.time.completed = Date.now()
            await Session.updateMessage(processor.message)
            await appendMarkers({ messageID: processor.message.id, markers: pendingMarkers }).catch(() => {})
            pendingMarkers.length = 0
            Bus.publish(Session.Event.Error, {
              sessionID: processor.message.sessionID,
              error,
            })
            processed = processor.message
            return "stop" as const
          }

          // Context-length retries can create empty attempt messages. If we were able to
          // run maintenance and plan to retry, drop the attempt message when it has no parts.
          const attemptParts = await MessageV2.parts(processor.message.id)
          if (attemptParts.length === 0) {
            await Session.removeMessage({ sessionID, messageID: processor.message.id }).catch(() => {})
          }
        }
      })

      if (
        processed &&
        isAssistantAnswered(processed) &&
        processed.finish !== "error" &&
        !processed.error &&
        queued.length > 1
      ) {
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: processed.id,
          sessionID,
          type: "text",
          synthetic: true,
          ignored: true,
          text: "",
          metadata: {
            opencode: {
              batch: {
                users: queued.map((msg) => msg.info.id),
                anchor: pending.info.id,
              },
            },
          },
        })
      }

      if (processed && !processed.error) {
        const target = [...(inboxMessage(pending) ? queued : []), ...resumeTail]
        const consumed = Array.from(new Map(target.map((msg) => [msg.info.id, msg])).values())
        if (consumed.length > 0) {
          await consumeInboxMessages({
            messages: consumed,
            assistantID: processed.id,
          })
        }
      }

      // Agent↔agent messaging and waiting are handled via tools (send_agent_message / wait_agent_message).
      // Note: send_agent_message is just a side-effect; it should not implicitly end the loop.

      if (outcome === "stop") break
      continue
    }

    // Subagent messages to parent are sent via send_agent_message tool calls.

    SessionCompaction.prune({ sessionID }).catch((error) => {
      log.error("failed to prune session", { sessionID, error: error?.message })
    })
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      const active = state()[sessionID]
      const queued = active?.callbacks ?? []
      if (active) {
        active.callbacks = []
      }

      if (abort.aborted) {
        for (const q of queued) {
          q.reject()
        }
        return item
      }

      for (const q of queued) {
        q.resolve(item)
      }
      return item
    }
    throw new Error("Impossible")
  }

  export const loop = fn(Identifier.schema("session"), async (sessionID) => {
    return inSessionDirectory(sessionID, () => runLoop(sessionID))
  })

  async function lastModel(sessionID: string) {
    const visited = new Set<string>()
    let current = sessionID

    while (!visited.has(current)) {
      visited.add(current)

      for await (const item of MessageV2.stream(current)) {
        if (item.info.role === "user" && item.info.model) return item.info.model
      }

      const session = await Session.get(current).catch(() => undefined)
      if (!session?.parentID) break
      current = session.parentID
    }

    return Provider.defaultModel()
  }

  async function lastAgent(sessionID: string): Promise<string> {
    // For subagent sessions, use the stored agent name
    const session = await Session.get(sessionID).catch(() => undefined)
    if (session?.agentName) {
      return session.agentName
    }

    // Fall back to finding agent from message history
    const visited = new Set<string>()
    let current = sessionID

    while (!visited.has(current)) {
      visited.add(current)

      for await (const item of MessageV2.stream(current)) {
        if (item.info.role === "user" && item.info.agent) return item.info.agent
      }

      const sess = await Session.get(current).catch(() => undefined)
      if (!sess?.parentID) break
      current = sess.parentID
    }

    return Agent.defaultAgent()
  }

  async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    messages: MessageV2.WithParts[]
    skillContext?: {
      messageIDs: string[]
      messages: MessageV2.WithParts[]
    }
    waitContext?: {
      maxSeqBySource: Record<string, number>
    }
  }) {
    const cfg = await Config.get()
    const tools: Record<string, AITool> = {}
    // Tools restricted to primary sessions only (not available to subagents)
    const primaryOnlyTools = new Set(cfg.experimental?.primary_tools ?? [])
    const isPrimarySession = input.session.sessionType !== "subagent"

    const record = (value: unknown): Record<string, unknown> =>
      value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

    const context = (args: unknown, options: ToolCallOptions): Tool.Context => {
      const inputArgs = record(args)
      return {
        sessionID: input.session.id,
        abort: options.abortSignal!,
        messageID: input.processor.message.id,
        callID: options.toolCallId,
        extra: {
          model: input.model,
          session: input.session,
          skillContext: input.skillContext,
          waitContext: input.waitContext,
        },
        agent: input.agent.name,
        messages: input.messages,
        metadata: async (val: { title?: string; metadata?: any }) => {
          const match = input.processor.partFromToolCall(options.toolCallId)
          if (match && match.state.status === "running") {
            await Session.updatePart({
              ...match,
              state: {
                title: val.title,
                metadata: val.metadata,
                status: "running",
                input: inputArgs,
                time: {
                  start: Date.now(),
                },
              },
            })
          }
        },
        async ask(req) {
          await PermissionNext.ask({
            ...req,
            sessionID: input.session.id,
            tool: { messageID: input.processor.message.id, callID: options.toolCallId },
            ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
          })
        },
      }
    }

    for (const item of await ToolRegistry.tools(
      { modelID: input.model.api?.id ?? input.model.id, providerID: input.model.providerID },
      input.agent,
    )) {
      if (primaryOnlyTools.has(item.id) && !isPrimarySession) continue

      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
      tools[item.id] = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          const ctx = context(args, options)
          await Plugin.trigger(
            "tool.execute.before",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            },
            {
              args,
            },
          )
          const result = await item.execute(args, ctx)
          await Plugin.trigger(
            "tool.execute.after",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            },
            result,
          )
          return result
        },
      })
    }

    // Add session-scoped extra tools (e.g., bridge tools for worker sessions)
    for (const extraTool of getExtraTools(input.session.id)) {
      const initialized = await extraTool.init()
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(initialized.parameters))
      tools[extraTool.id] = tool({
        id: extraTool.id as any,
        description: initialized.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          const ctx = context(args, options)
          const result = await initialized.execute(args, ctx)
          return result
        },
        toModelOutput(result) {
          return {
            type: "text",
            value: result.output,
          }
        },
      })
    }

    for (const [key, item] of Object.entries(await MCP.tools())) {
      if (primaryOnlyTools.has(key) && !isPrimarySession) continue
      const execute = item.execute
      if (!execute) continue

      // Wrap execute to add plugin hooks and format output
      item.execute = async (args, opts) => {
        const ctx = context(args, opts)

        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          },
          {
            args,
          },
        )

        await ctx.ask({
          permission: key,
          metadata: {},
          patterns: ["*"],
          always: ["*"],
        })

        const result = await execute(args, opts)

        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          },
          result,
        )

        const textParts: string[] = []
        const attachments: MessageV2.FilePart[] = []

        for (const contentItem of result.content) {
          if (contentItem.type === "text") {
            textParts.push(contentItem.text)
          } else if (contentItem.type === "image") {
            attachments.push({
              id: Identifier.ascending("part"),
              sessionID: input.session.id,
              messageID: input.processor.message.id,
              type: "file",
              mime: contentItem.mimeType,
              url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
            })
          } else if (contentItem.type === "resource") {
            const { resource } = contentItem
            if (resource.text) {
              textParts.push(resource.text)
            }
            if (resource.blob) {
              attachments.push({
                id: Identifier.ascending("part"),
                sessionID: input.session.id,
                messageID: input.processor.message.id,
                type: "file",
                mime: resource.mimeType ?? "application/octet-stream",
                url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                filename: resource.uri,
              })
            }
          }
        }

        const truncated = await Truncate.output(textParts.join("\n\n"), {}, input.agent)
        const metadata = {
          ...(result.metadata ?? {}),
          truncated: truncated.truncated,
          ...(truncated.truncated && { outputPath: truncated.outputPath }),
        }

        return {
          title: "",
          metadata,
          output: truncated.content,
          attachments,
          content: result.content, // directly return content to preserve ordering when outputting to model
        }
      }
      tools[key] = item
    }
    return tools
  }

  async function createUserMessage(input: PromptInput) {
    // For subagent sessions, always use the session's stored agent type
    // This ensures human messages to subagents use the correct agent (e.g., "explore")
    const session = await Session.get(input.sessionID).catch(() => undefined)
    const agentName = session?.agentName ?? input.agent ?? (await Agent.defaultAgent())
    const agent = await Agent.get(agentName)

    // For subagent sessions, prioritize the agent's configured model over input.model
    // This ensures subagents always use their designated model regardless of what the TUI sends
    const isSubagentSession = session?.sessionType === "subagent"
    const model = isSubagentSession
      ? (agent.model ?? input.model ?? (await lastModel(input.sessionID)))
      : (input.model ?? agent.model ?? (await lastModel(input.sessionID)))

    const info: MessageV2.Info = {
      id: input.messageID ?? Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      tools: input.tools,
      agent: agent.name,
      model,
      system: input.system,
      variant: input.variant,
    }
    using _ = defer(() => InstructionPrompt.clear(info.id))

    const parts = await Promise.all(
      input.parts.map(async (part): Promise<MessageV2.Part[]> => {
        if (part.type === "file") {
          // before checking the protocol we check if this is an mcp resource because it needs special handling
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })

            const pieces: MessageV2.Part[] = [
              {
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]

            try {
              const resourceContent = await MCP.readResource(clientName, uri)
              if (!resourceContent) {
                throw new Error(`Resource not found: ${clientName}/${uri}`)
              }

              // Handle different content types
              const contents = Array.isArray(resourceContent.contents)
                ? resourceContent.contents
                : [resourceContent.contents]

              for (const content of contents) {
                if ("text" in content && content.text) {
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: content.text as string,
                  })
                } else if ("blob" in content && content.blob) {
                  // Handle binary content if needed
                  const mimeType = "mimeType" in content ? content.mimeType : part.mime
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mimeType}]`,
                  })
                }
              }

              pieces.push({
                ...part,
                id: part.id ?? Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
              })
            } catch (error: unknown) {
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }

            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: (() => {
                      const comma = part.url.indexOf(",")
                      if (comma === -1) return ""

                      const header = part.url.slice(0, comma)
                      const payload = part.url.slice(comma + 1)
                      if (!header.includes(";base64")) return payload

                      return Buffer.from(payload, "base64").toString()
                    })(),
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              break
            case "file:": {
              log.info("file", { mime: part.mime })
              // have to normalize, symbol search returns absolute paths
              // Decode the pathname since URL constructor doesn't automatically decode it
              const filepath = fileURLToPath(part.url)
              const stat = await Bun.file(filepath).stat()

              if (stat.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  // some LSP servers (eg, gopls) don't give full range in
                  // workspace/symbol searches, so we'll try to find the
                  // symbol in the document to get the full range
                  if (start === end) {
                    const symbols = await LSP.documentSymbol(filePathURI)
                    for (const symbol of symbols) {
                      let range: LSP.Range | undefined
                      if ("range" in symbol) {
                        range = symbol.range
                      } else if ("location" in symbol) {
                        range = symbol.location.range
                      }
                      if (range?.start?.line && range?.start?.line === start) {
                        start = range.start.line
                        end = range?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start - 1, 0)
                  if (end) {
                    limit = end - offset
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: MessageV2.Part[] = [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                await ReadTool.init()
                  .then(async (t) => {
                    const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                    const readCtx: Tool.Context = {
                      sessionID: input.sessionID,
                      abort: new AbortController().signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, model },
                      messages: [],
                      metadata: async () => {},
                      ask: async (req) => {
                        await PermissionNext.ask({
                          ...req,
                          sessionID: input.sessionID,
                          ruleset: PermissionNext.merge(agent.permission, session?.permission ?? []),
                        })
                      },
                    }
                    const result = await t.execute(args, readCtx)
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((attachment) => ({
                          ...attachment,
                          synthetic: true,
                          filename: attachment.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({
                        ...part,
                        id: part.id ?? Identifier.ascending("part"),
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })
                    }
                  })
                  .catch((error) => {
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : error.toString()
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({
                        message,
                      }).toObject(),
                    })
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  })

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { path: filepath }
                const listCtx: Tool.Context = {
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  extra: { bypassCwdCheck: true },
                  messages: [],
                  metadata: async () => {},
                  ask: async (req) => {
                    await PermissionNext.ask({
                      ...req,
                      sessionID: input.sessionID,
                      ruleset: PermissionNext.merge(agent.permission, session?.permission ?? []),
                    })
                  },
                }
                const result = await ListTool.init().then((t) => t.execute(args, listCtx))
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the list tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              const file = Bun.file(filepath)
              const stats = await file.stat()
              const bytes = await file.bytes()
              FileTime.read(input.sessionID, filepath, FileTime.stamp(stats.mtime, bytes))
              return [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {\"filePath\":\"${filepath}\"}`,
                  synthetic: true,
                },
                {
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + Buffer.from(bytes).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          return [
            {
              id: Identifier.ascending("part"),
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              id: Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                "Use the above message and context to generate a prompt and call the subagent_spawn tool with subagent: " +
                part.name,
            },
          ]
        }

        return [
          {
            id: Identifier.ascending("part"),
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    ).then((x) => x.flat())

    const compacting =
      state()[input.sessionID]?.compaction ?? (await SessionCompaction.marker(input.sessionID).catch(() => undefined))
    if (compacting) {
      parts.unshift(
        compactionReminder({
          sessionID: input.sessionID,
          messageID: info.id,
          requestID: compacting.requestID,
          startedAt: compacting.startedAt,
        }),
      )
    }

    await Plugin.trigger(
      "chat.message",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
        variant: input.variant,
      },
      {
        message: info,
        parts,
      },
    )

    // Guard again right before persisting to minimize race windows where manual
    // summarize begins after the prompt handler started.
    if (SessionCompaction.manual(input.sessionID)) {
      throw new Session.BusyError({ sessionID: input.sessionID })
    }

    await Session.updateMessage(info)
    for (const part of parts) {
      await Session.updatePart(part)
    }

    if (parts.some((p) => p.type === "compaction")) {
      await SessionCompaction.mark({
        sessionID: input.sessionID,
        requestID: info.id,
        startedAt: info.time.created,
      })
    }

    return {
      info,
      parts,
    }
  }

  async function insertReminders(input: { messages: MessageV2.WithParts[]; agent: Agent.Info; session: Session.Info }) {
    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return input.messages

    // Original logic when experimental plan mode is disabled
    if (!Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE) {
      if (input.agent.name === "plan") {
        userMessage.parts.push({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: PROMPT_PLAN,
          synthetic: true,
        })
      }
      const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
      if (wasPlan && input.agent.name === "build") {
        userMessage.parts.push({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: BUILD_SWITCH,
          synthetic: true,
        })
      }
      return input.messages
    }

    // New plan mode logic when flag is enabled
    const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")

    // Switching from plan mode to build mode
    if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
      const plan = Session.plan(input.session)
      const exists = await Bun.file(plan).exists()
      if (exists) {
        const part = await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text:
            BUILD_SWITCH + "\n\n" + `A plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
        })
        userMessage.parts.push(part)
      }
      return input.messages
    }

    // Entering plan mode
    if (input.agent.name === "plan" && assistantMessage?.info.agent !== "plan") {
      const plan = Session.plan(input.session)
      const exists = await Bun.file(plan).exists()
      if (!exists) await fs.mkdir(path.dirname(plan), { recursive: true })
      const part = await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    }
    return input.messages
  }

  export const ShellInput = z.object({
    sessionID: Identifier.schema("session"),
    agent: z.string(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  async function shellLocal(input: ShellInput) {
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError({ sessionID: input.sessionID })
    }
    using _ = defer(() => cancel(input.sessionID, { force: false }))

    const session = await Session.get(input.sessionID)
    if (session.revert) {
      await SessionRevert.cleanup(session)
    }

    // For subagent sessions, use the session's agent and prioritize its model
    const agentName = session.agentName ?? input.agent
    const agent = await Agent.get(agentName)
    const isSubagentSession = session.sessionType === "subagent"
    const model = isSubagentSession
      ? (agent.model ?? input.model ?? (await lastModel(input.sessionID)))
      : (input.model ?? agent.model ?? (await lastModel(input.sessionID)))

    const userMsg: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      role: "user",
      agent: agentName,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }
    await Session.updateMessage(userMsg)
    const userPart: MessageV2.Part = {
      type: "text",
      id: Identifier.ascending("part"),
      messageID: userMsg.id,
      sessionID: input.sessionID,
      text: "The following tool was executed by the user",
      synthetic: true,
    }
    await Session.updatePart(userPart)

    const msg: MessageV2.Assistant = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      parentID: userMsg.id,
      mode: input.agent,
      agent: input.agent,
      cost: 0,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      time: {
        created: Date.now(),
      },
      role: "assistant",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.modelID,
      providerID: model.providerID,
    }
    await Session.updateMessage(msg)
    const part: MessageV2.Part = {
      type: "tool",
      id: Identifier.ascending("part"),
      messageID: msg.id,
      sessionID: input.sessionID,
      tool: "bash",
      callID: ulid(),
      state: {
        status: "running",
        time: {
          start: Date.now(),
        },
        input: {
          command: input.command,
        },
      },
    }
    await Session.updatePart(part)
    const shell = Shell.preferred()
    const shellName = (
      process.platform === "win32" ? path.win32.basename(shell, ".exe") : path.basename(shell)
    ).toLowerCase()

    const invocations: Record<string, { args: string[] }> = {
      nu: {
        args: ["-c", input.command],
      },
      fish: {
        args: ["-c", input.command],
      },
      zsh: {
        args: [
          "-c",
          "-l",
          `
            [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
            [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      bash: {
        args: [
          "-c",
          "-l",
          `
            shopt -s expand_aliases
            [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      // Windows cmd
      cmd: {
        args: ["/c", input.command],
      },
      // Windows PowerShell
      powershell: {
        args: ["-NoProfile", "-Command", input.command],
      },
      pwsh: {
        args: ["-NoProfile", "-Command", input.command],
      },
      // Fallback: any shell that doesn't match those above
      //  - No -l, for max compatibility
      "": {
        args: ["-c", `${input.command}`],
      },
    }

    const matchingInvocation = invocations[shellName] ?? invocations[""]
    const args = matchingInvocation?.args

    const proc = spawn(shell, args, {
      cwd: Instance.directory,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TERM: "dumb",
      },
    })

    let output = ""

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    let aborted = false
    let exited = false

    const kill = () => Shell.killTree(proc, { exited: () => exited })

    if (abort.aborted) {
      aborted = true
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      void kill()
    }

    abort.addEventListener("abort", abortHandler, { once: true })

    await new Promise<void>((resolve) => {
      proc.on("close", () => {
        exited = true
        abort.removeEventListener("abort", abortHandler)
        resolve()
      })
    })

    if (aborted) {
      output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
    }
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    if (part.state.status === "running") {
      part.state = {
        status: "completed",
        time: {
          ...part.state.time,
          end: Date.now(),
        },
        input: part.state.input,
        title: "",
        metadata: {
          output,
          description: "",
        },
        output,
      }
      await Session.updatePart(part)
    }
    return { info: msg, parts: [part] }
  }

  export async function shell(input: ShellInput) {
    return inSessionDirectory(input.sessionID, async () => {
      // Manual summarize runs outside the prompt loop state. Treat it as exclusive.
      if (SessionCompaction.manual(input.sessionID)) {
        throw new Session.BusyError({ sessionID: input.sessionID })
      }

      // Human input cancels waiting.
      if (WaitPolicy.isWaiting(input.sessionID)) {
        const wait = WaitPolicy.get(input.sessionID)
        if (wait) {
          await interruptWaitInDirectory(input.sessionID, wait, Instance.directory, "prompt").catch((error) => {
            log.error("failed to mark wait interrupted", { sessionID: input.sessionID, error: error?.message })
          })
        }
        WaitPolicy.clear(input.sessionID)
        SessionStatus.set(input.sessionID, { type: "idle" })
      }

      return shellLocal(input)
    })
  }

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  const argsRegex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  async function commandLocal(input: CommandInput) {
    log.info("command", input)
    const command = await Command.get(input.command)
    const agentName = command.agent ?? input.agent ?? (await Agent.defaultAgent())

    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

    const templateCommand = await command.template

    const placeholders = templateCommand.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }

    // Let the final placeholder swallow any extra arguments so prompts read naturally
    const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
    let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

    // If command doesn't explicitly handle arguments (no $N or $ARGUMENTS placeholders)
    // but user provided arguments, append them to the template
    if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
      template = template + "\n\n" + input.arguments
    }

    const shell = ConfigMarkdown.shell(template)
    if (shell.length > 0) {
      const results = await Promise.all(
        shell.map(async ([, cmd]) => {
          try {
            return await $`${{ raw: cmd }}`.quiet().nothrow().text()
          } catch (error) {
            return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    const taskModel = await (async () => {
      if (command.model) {
        return Provider.parseModel(command.model)
      }
      if (command.agent) {
        const cmdAgent = await Agent.get(command.agent)
        if (cmdAgent?.model) {
          return cmdAgent.model
        }
      }
      if (input.model) return Provider.parseModel(input.model)
      return await lastModel(input.sessionID)
    })()

    try {
      await Provider.getModel(taskModel.providerID, taskModel.modelID)
    } catch (e) {
      if (Provider.ModelNotFoundError.isInstance(e)) {
        const { providerID, modelID, suggestions } = e.data
        const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
        Bus.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
        })
      }
      throw e
    }
    const agent = await Agent.get(agentName)
    if (!agent) {
      const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }

    const templateParts = await resolvePromptParts(template)
    const isSubtask = (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
    const parts = isSubtask
      ? [
          {
            type: "subtask" as const,
            agent: agent.name,
            description: command.description ?? "",
            command: input.command,
            model: {
              providerID: taskModel.providerID,
              modelID: taskModel.modelID,
            },
            prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
          },
        ]
      : [...templateParts, ...(input.parts ?? [])]

    const userAgent = isSubtask ? (input.agent ?? (await Agent.defaultAgent())) : agentName
    const userModel = isSubtask
      ? input.model
        ? Provider.parseModel(input.model)
        : await lastModel(input.sessionID)
      : taskModel

    await Plugin.trigger(
      "command.execute.before",
      {
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
      },
      { parts },
    )

    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model: userModel,
      agent: userAgent,
      parts,
      variant: input.variant,
    })) as MessageV2.WithParts

    Bus.publish(Command.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: result.info.id,
    })

    return result
  }

  export async function command(input: CommandInput) {
    return inSessionDirectory(input.sessionID, () => commandLocal(input))
  }

  async function ensureTitle(input: {
    session: Session.Info
    message: MessageV2.WithParts
    history: MessageV2.WithParts[]
    providerID: string
    modelID: string
  }) {
    if (input.session.parentID) return
    if (!Session.isDefaultTitle(input.session.title)) return
    const isFirst =
      input.history.filter((m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic))
        .length === 1
    if (!isFirst) return
    const agent = await Agent.get("title")
    if (!agent) return
    const model = await iife(async () => {
      if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
      return (
        (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
      )
    })

    const contextMessages = input.history
    const subtaskParts = input.message.parts.filter((p): p is MessageV2.SubtaskPart => p.type === "subtask")
    const hasOnlySubtaskParts =
      subtaskParts.length > 0 &&
      input.message.parts.every((p) => p.type === "subtask" || ("synthetic" in p && p.synthetic))

    const result = await LLM.stream({
      agent,
      user: input.message.info as MessageV2.User,
      system: [],
      small: true,
      tools: {},
      model,
      abort: new AbortController().signal,
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content: "Generate a title for this conversation:\n",
        },
        ...(hasOnlySubtaskParts
          ? [{ role: "user" as const, content: subtaskParts.map((p) => p.prompt).join("\n") }]
          : MessageV2.toModelMessages(contextMessages, model)),
      ],
    })
    const text = await result.text.catch((err) => log.error("failed to generate title", { error: err }))
    if (text)
      return Session.update(
        input.session.id,
        (draft) => {
          const cleaned = text
            .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0)
          if (!cleaned) return

          const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
          draft.title = title
        },
        { touch: false },
      )
  }
}
