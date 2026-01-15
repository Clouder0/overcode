import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions } from "ai"
import { SessionCompaction } from "./compaction"
import { SessionRetry } from "./retry"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { TuiEvent } from "../cli/cmd/tui/event"
import { ProviderTransform } from "../provider/transform"
import { SystemPrompt } from "./system"
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
import { Config } from "../config/config"
import { Shell } from "@/shell/shell"
import { LLM } from "./llm"
import { LLMConcurrencyMachine } from "./llm-concurrency-machine"
import { iife } from "@/util/iife"
import { SessionMessage } from "./message-routing"
import { WaitPolicy } from "./wait-policy"
import { MessageParser } from "./message-parser"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })
  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

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
    const modelName = model?.api.id ?? input.model.modelID

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

  const wake = (sessionID: string) => {
    log.info("waking session", { sessionID })
    SessionPrompt.loop(sessionID).catch((error) => {
      log.error("failed to wake session", { sessionID, error: error?.message })
    })
  }

  function compactionReminder(input: {
    sessionID: string
    messageID: string
    requestID: string
    startedAt: number
  }): MessageV2.TextPart {
    return {
      id: Identifier.ascending("part", `prt_000_${input.messageID}`),
      messageID: input.messageID,
      sessionID: input.sessionID,
      type: "text",
      synthetic: true,
      metadata: {
        opencode: {
          compaction: {
            requestID: input.requestID,
            startedAt: input.startedAt,
          },
        },
      },
      text: [
        "<system-reminder>",
        "This message arrived while the session was compacting.",
        `Compaction request: ${input.requestID}`,
        "It may not be reflected in the compaction summary.",
        "Please treat it as new input to address after compaction.",
        "</system-reminder>",
      ].join("\n"),
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

    const compacting =
      state()[sessionID]?.compaction ?? (await SessionCompaction.marker(sessionID).catch(() => undefined))
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

    const pending = SessionMessage.peekPending(sessionID)
    const pendingFromSources = new Set(pending.filter((m) => policy.sources.includes(m.from)).map((m) => m.from))

    const result = WaitPolicy.evaluate({
      policy,
      pendingFromSources,
    })

    const parts = await MessageV2.parts(policy.messageID)
    const tool = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === policy.callID)
    if (!tool) return

    const meta = {
      ok: true,
      status: result.timedOut ? "timedOut" : "waiting",
      sources: policy.sources,
      respondedSources: result.respondedSources,
      timedOutSources: result.timedOut ? result.missingSources : [],
      timeout: policy.timeout,
      mode: policy.mode,
      allReceived: false,
      createdAt: policy.time.created,
      deadline: policy.time.deadline,
    }

    if (tool.state.status === "pending") return

    const still = WaitPolicy.get(sessionID)
    if (!still || still.callID !== policy.callID) return

    await Session.updatePart({
      ...tool,
      state: {
        ...tool.state,
        metadata: meta,
      },
    })
  }

  async function interruptWait(sessionID: string, policy: WaitPolicy.Policy, by: "prompt" | "abort") {
    const parts = await MessageV2.parts(policy.messageID)
    const tool = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === policy.callID)
    if (!tool) return
    if (tool.state.status !== "completed") return

    const interruptedAt = Date.now()

    const prev = tool.state.metadata as any
    const respondedSources = Array.isArray(prev?.respondedSources) ? prev.respondedSources : []

    const meta = {
      ok: true,
      status: "interrupted",
      sources: policy.sources,
      respondedSources,
      timedOutSources: [],
      timeout: policy.timeout,
      mode: policy.mode,
      allReceived: false,
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
        output: "",
        metadata: meta,
      },
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

  SessionMessage.setWakeSessionFn((message) => {
    const sessionID = message.to
    const directory = Instance.directory

    // Persist immediately so the TUI can show queued agent messages while busy.
    persistInboundInDirectory(message, directory).catch((error) => {
      log.error("failed to persist delivered message", { sessionID, error: error?.message })
    })

    // If the session loop is currently running, let it observe pending messages directly.
    if (state()[sessionID]) {
      wakeAfter().add(sessionID)
      return
    }

    const status = SessionStatus.get(sessionID)
    if (status.type === "idle") {
      wake(sessionID)
      return
    }

    if (status.type === "waiting") {
      const policy = WaitPolicy.get(sessionID)
      if (!policy) {
        // Avoid getting stuck in an unwakeable "waiting" state.
        SessionStatus.set(sessionID, { type: "idle" })
        wake(sessionID)
        return
      }

      updateWaitProgress(sessionID, policy).catch((error) => {
        log.error("failed to update wait progress", { sessionID, error: error?.message })
      })

      const pending = SessionMessage.peekPending(sessionID)
      const sources = new Set(policy.sources)

      const nonSource = pending.filter((m) => !sources.has(m.from))
      if (nonSource.length > 0) {
        Promise.allSettled(nonSource.map((m) => persistInboundInDirectory(m, directory)))
          .then((settled) => {
            const ok = new Set<string>()
            for (const [i, msg] of nonSource.entries()) {
              if (settled[i]?.status === "fulfilled") ok.add(msg.id)
            }
            if (ok.size === 0) return

            SessionMessage.takePending(sessionID, (msg) => ok.has(msg.id) && !sources.has(msg.from))
          })
          .catch((error) => {
            log.error("failed to persist non-source wait messages", { sessionID, error: error?.message })
          })
      }

      const pendingFromSources = new Set(pending.filter((m) => sources.has(m.from)).map((m) => m.from))

      const result = WaitPolicy.evaluate({
        policy,
        pendingFromSources,
      })

      if (!result.ready) return

      wake(sessionID)
      return
    }

    if (status.type === "busy" || status.type === "retry") {
      // Status can become stale if a loop exits unexpectedly.
      SessionStatus.set(sessionID, { type: "idle" })
      wake(sessionID)
    }
  })

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

    wake(sessionID)
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

  function evictEnvironmentIdle(idle: Map<string, Promise<string[]>>) {
    while (idle.size > ENVIRONMENT_IDLE_CACHE_MAX) {
      const oldest = idle.keys().next().value
      if (!oldest) break
      idle.delete(oldest)
    }
  }

  const environmentState = Instance.state(
    () => {
      const pinned = new Map<string, Promise<string[]>>()
      const idle = new Map<string, Promise<string[]>>()

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

  export function getCachedEnvironment(sessionID: string, load?: () => Promise<string[]>) {
    const cache = environmentState()
    const pinned = cache.pinned
    const idle = cache.idle

    const existingPinned = pinned.get(sessionID)
    if (existingPinned) return existingPinned

    const existingIdle = idle.get(sessionID)
    if (existingIdle) {
      idle.delete(sessionID)
      if (environmentPinned(sessionID)) {
        pinned.set(sessionID, existingIdle)
        return existingIdle
      }
      idle.set(sessionID, existingIdle)
      return existingIdle
    }

    const next = (load ?? SystemPrompt.environment)()
    const active = environmentPinned(sessionID)
    if (active) {
      pinned.set(sessionID, next)
    }
    if (!active) {
      idle.set(sessionID, next)
      evictEnvironmentIdle(idle)
    }

    next.catch(() => {
      if (pinned.get(sessionID) === next) pinned.delete(sessionID)
      if (idle.get(sessionID) === next) idle.delete(sessionID)
    })

    return next
  }

  export function clearCachedEnvironment(sessionID: string) {
    const cache = environmentState()
    cache.pinned.delete(sessionID)
    cache.idle.delete(sessionID)
  }

  export function assertNotBusy(sessionID: string) {
    const match = state()[sessionID]
    if (match) throw new Session.BusyError({ sessionID })

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
    const session = await Session.get(input.sessionID)
    await SessionRevert.cleanup(session)

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

    return loop(input.sessionID)
  })

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

  export function cancel(sessionID: string, input?: { force?: boolean }) {
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

      const pending = SessionMessage.peekPending(sessionID)
      const pendingFromSources = new Set(pending.filter((m) => policy.sources.includes(m.from)).map((m) => m.from))

      const result = WaitPolicy.evaluate({
        policy,
        pendingFromSources,
      })

      if (!result.ready) return

      wake(sessionID)
      return
    }

    wake(sessionID)
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
    const hasNonThinking = parts.some((part) => part.type !== "reasoning" && part.type !== "step-start")
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

  type AutoCompactionCause = "overflow" | "context_length"

  async function requestAutoCompaction(input: {
    sessionID: string
    agent: string
    model: MessageV2.User["model"]
    cause: AutoCompactionCause
  }) {
    const cfg = await Config.get()
    const policy = SessionCompaction.autoPolicy(cfg.compaction?.auto)

    if (policy === "deny") return false

    if (policy === "ask") {
      const patterns = ["auto"]
      const allowed = await PermissionNext.ask({
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

      if (!allowed) return false
    }

    await SessionCompaction.create({
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      auto: true,
    })
    return true
  }

  async function runLoop(sessionID: string): Promise<MessageV2.WithParts> {
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

    using _ = defer(() => cancel(sessionID, { force: false }))

    let step = 0
    let pendingPersistFailures = 0
    const session = await Session.get(sessionID)
    while (true) {
      log.info("loop", { step, sessionID })
      if (abort.aborted) break

      const wait = WaitPolicy.get(sessionID)
      if (wait) {
        const pending = SessionMessage.peekPending(sessionID)
        const pendingFromSources = new Set(pending.filter((m) => wait.sources.includes(m.from)).map((m) => m.from))

        const result = WaitPolicy.evaluate({
          policy: wait,
          pendingFromSources,
        })

        if (!result.ready) {
          SessionStatus.set(sessionID, {
            type: "waiting",
            sources: wait.sources,
            timeout: wait.timeout,
            mode: wait.mode,
            time: wait.time,
          })
          break
        }

        WaitPolicy.clear(sessionID)
        SessionStatus.set(sessionID, { type: "busy" })

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

        // Generate ONE comprehensive wait result message (system message)
        if (timedOutSources.length > 0) {
          const ids = Array.from(new Set([...respondedSources, ...timedOutSources]))
          const sessions = await Promise.all(ids.map((id) => Session.get(id).catch(() => undefined)))

          const agents: Record<string, string> = {}
          ids.forEach((id, i) => {
            const name = sessions[i]?.agentName
            if (typeof name !== "string" || name.length === 0) return
            agents[id] = name
          })

          const snapshots = timedOutSources.map((source): MessageParser.TimeoutSnapshot => {
            const st = SessionStatus.get(source)
            const agent = agents[source]
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
            from: "Wait result",
            to: sessionID,
            text: MessageParser.formatWaitResult({
              timeoutMs: wait.timeout,
              mode: wait.mode,
              responded: respondedSources,
              timedOut: snapshots,
              agents,
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

          const meta = {
            ok: true,
            status,
            sources: wait.sources,
            respondedSources,
            timedOutSources,
            timeout: wait.timeout,
            mode: wait.mode,
            allReceived,
            createdAt: wait.time.created,
            deadline: wait.time.deadline,
          }

          await Session.updatePart({
            ...tool,
            state: {
              ...tool.state,
              title: status === "resolved" ? "Wait resolved" : "Wait timed out",
              output: "",
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

      let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

      let lastUser: MessageV2.User | undefined
      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (
          !lastUser &&
          msg.info.role === "user" &&
          msg.parts.some((part) => {
            if (part.type === "text") return !part.ignored
            if (part.type === "file") return true
            if (part.type === "compaction") return true
            if (part.type === "subtask") return true
            if (part.type === "agent") return true
            if (part.type === "message") return true
            return false
          })
        ) {
          lastUser = msg.info as MessageV2.User
        }
        if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastUser && lastFinished) break
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
        if (task && !lastFinished) {
          tasks.push(...task)
        }
      }

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

      // If the previous run was interrupted mid-thinking, we can end up with an assistant message that contains only
      // reasoning parts and no final output/tool call. Some providers (eg, Claude) reject such empty messages after
      // unsupported parts are dropped. Keep the thinking in history, but omit it from the model context and mark it.
      if (lastAssistant && lastUser.id > lastAssistant.id && !lastAssistant.finish) {
        const orphan = msgs.find((m) => m.info.role === "assistant" && m.info.id === lastAssistant.id)
        if (orphan) {
          await omitOrphanThinking({
            sessionID,
            assistant: orphan,
            continuedAtMessageID: lastUser.id,
          })
        }
      }

      if (
        lastAssistant?.finish &&
        lastUser.id < lastAssistant.id &&
        (lastAssistant.summary || !["tool-calls", "unknown"].includes(lastAssistant.finish))
      ) {
        log.info("exiting loop", { sessionID })
        break
      }

      step++
      if (step === 1) {
        ensureTitle({
          session,
          modelID: lastUser.model.modelID,
          providerID: lastUser.model.providerID,
          message: msgs.find((m) => m.info.role === "user")!,
          history: msgs,
        }).catch((error) => {
          log.error("failed to ensure title", { sessionID, error: error?.message })
        })
      }

      const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID)
      const task = tasks.pop()

      // pending subtask - handled by job-based subagent system
      // The new job system handles subagent tasks through SubagentJob definitions
      // and generic job tools (job_list, job_get, job_cancel, job_wait)
      if (task?.type === "subtask") {
        // Skip subtask processing - handled by job system

        continue
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

      // context overflow, needs compaction
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model }))
      ) {
        const compacted = await requestAutoCompaction({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          cause: "overflow",
        })
        if (compacted) continue
      }

      // normal processing
      const agent = await Agent.get(lastUser.agent)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps
      msgs = await insertReminders({
        messages: msgs,
        agent,
        session,
      })

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
      const tools = await resolveTools({
        agent,
        session,
        model,
        tools: lastUser.tools,
        processor,
      })

      if (step === 1) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        }).catch((error) => {
          log.error("failed to summarize session", { sessionID, error: error?.message })
        })
      }

      const sessionMessages = clone(msgs)

      // Ephemerally wrap queued user messages with a reminder to stay on track
      if (step > 1 && lastFinished) {
        for (const msg of sessionMessages) {
          if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
          for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) continue
            if (!part.text.trim()) continue
            part.text = [
              "<system-reminder>",
              "The user sent the following message:",
              part.text,
              "",
              "Please address this message and continue with your tasks.",
              "</system-reminder>",
            ].join("\n")
          }
        }
      }

      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })

      const currentSession = await Session.get(sessionID)
      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        system: [
          ...(await getCachedEnvironment(sessionID)),
          ...(await SystemPrompt.custom()),
          ...SystemPrompt.messageProtocol(
            currentSession.sessionType,
            sessionID,
            currentSession.parentID,
            currentSession.subagentPrompt,
          ),
        ],
        messages: [
          ...MessageV2.toModelMessage(sessionMessages),
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

      // Agent↔agent messaging and waiting are handled via tools (send_agent_message / wait_agent_message).

      if (currentSession.sessionType === "subagent") {
        const parts = await MessageV2.parts(processor.message.id)
        const sends = parts.filter(
          (p): p is MessageV2.ToolPart =>
            p.type === "tool" && p.tool === "send_agent_message" && p.state.status === "completed",
        )
        const okSends = sends.filter((p) => {
          if (p.state.status !== "completed") return false
          return (p.state.metadata as { ok?: boolean } | undefined)?.ok === true
        })

        const waits = parts.filter((p): p is MessageV2.ToolPart => p.type === "tool" && p.tool === "wait_agent_message")
        const hasWait = waits.some((p) => {
          if (p.state.status !== "completed") return false
          return (p.state.metadata as { ok?: boolean } | undefined)?.ok === true
        })

        const hasPending = SessionMessage.hasPending(sessionID)
        if (okSends.length > 0 && !hasWait && !hasPending) {
          break
        }
      }

      if (result === "stop") break
      if (result === "compact") {
        const cause = processor.compactionRequest?.reason === "context_length" ? "context_length" : "overflow"
        const compacted = await requestAutoCompaction({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          cause,
        })

        if (!compacted && processor.compactionRequest?.fallbackError) {
          const fallback = processor.compactionRequest.fallbackError
          processor.message.error = fallback
          await Session.updateMessage(processor.message)
          Bus.publish(Session.Event.Error, {
            sessionID: processor.message.sessionID,
            error: fallback,
          })
          break
        }
      }
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

  export const loop = fn(Identifier.schema("session"), runLoop)

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

    return "default"
  }

  async function resolveSystemPrompt(input: {
    sessionID: string
    system?: string
    agent: Agent.Info
    model: Provider.Model
    isLastStep?: boolean
  }) {
    let system = SystemPrompt.header(input.model.providerID)
    system.push(
      ...(() => {
        if (input.system) return [input.system]
        if (input.agent.prompt) return [input.agent.prompt]
        return SystemPrompt.provider(input.model)
      })(),
    )
    system.push(...(await getCachedEnvironment(input.sessionID)))
    system.push(...(await SystemPrompt.custom()))

    if (input.isLastStep) {
      system.push(MAX_STEPS)
    }

    // max 2 system prompt messages for caching purposes
    const [first, ...rest] = system
    system = [first, rest.join("\n")]
    return system
  }

  async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
  }) {
    const cfg = await Config.get()
    const tools: Record<string, AITool> = {}
    // Tools restricted to primary sessions only (not available to subagents)
    const primaryOnlyTools = new Set(cfg.experimental?.primary_tools ?? [])
    const isPrimarySession = input.session.sessionType !== "subagent"

    const context = (args: any, options: ToolCallOptions): Tool.Context => ({
      sessionID: input.session.id,
      abort: options.abortSignal!,
      messageID: input.processor.message.id,
      callID: options.toolCallId,
      extra: { model: input.model, session: input.session },
      agent: input.agent.name,
      metadata: async (val: { title?: string; metadata?: any }) => {
        const match = input.processor.partFromToolCall(options.toolCallId)
        if (match && match.state.status === "running") {
          await Session.updatePart({
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running",
              input: args,
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
    })

    for (const item of await ToolRegistry.tools(input.model.providerID, input.agent)) {
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
        toModelOutput(result) {
          return {
            type: "text",
            value: result.output,
          }
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

        return {
          title: "",
          metadata: result.metadata ?? {},
          output: textParts.join("\n\n"),
          attachments,
          content: result.content, // directly return content to preserve ordering when outputting to model
        }
      }
      item.toModelOutput = (result) => {
        return {
          type: "text",
          value: result.output,
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
                    text: Buffer.from(part.url, "base64url").toString(),
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
          text: BUILD_SWITCH.replace("{{plan}}", plan),
          synthetic: true,
        })
        userMessage.parts.push(part)
      }
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
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

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
  export async function shell(input: ShellInput) {
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError({ sessionID: input.sessionID })
    }
    using _ = defer(() => cancel(input.sessionID))

    const session = await Session.get(input.sessionID)
    if (session.revert) {
      SessionRevert.cleanup(session)
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

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
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

  export async function command(input: CommandInput) {
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
    let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

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

    const model = await (async () => {
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
      await Provider.getModel(model.providerID, model.modelID)
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

    const parts =
      (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: command.description ?? "",
              command: input.command,
              // TODO: how can we make subagent_spawn accept a more complex input?
              prompt: await resolvePromptParts(template).then((x) => x.find((y) => y.type === "text")?.text ?? ""),
            },
          ]
        : await resolvePromptParts(template)

    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model,
      agent: agentName,
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
    const result = await LLM.stream({
      agent,
      user: input.message.info as MessageV2.User,
      system: [],
      small: true,
      tools: {},
      model: await iife(async () => {
        if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
        return (
          (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
        )
      }),
      abort: new AbortController().signal,
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content: "Generate a title for this conversation:\n",
        },
        ...MessageV2.toModelMessage([
          {
            info: {
              id: Identifier.ascending("message"),
              role: "user",
              sessionID: input.session.id,
              time: {
                created: Date.now(),
              },
              agent: input.message.info.role === "user" ? input.message.info.agent : await Agent.defaultAgent(),
              model: {
                providerID: input.providerID,
                modelID: input.modelID,
              },
            },
            parts: input.message.parts,
          },
        ]),
      ],
    })
    const text = await result.text.catch((err) => log.error("failed to generate title", { error: err }))
    if (text)
      return Session.update(input.session.id, (draft) => {
        const cleaned = text
          .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0)
        if (!cleaned) return

        const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
        draft.title = title
      })
  }
}
