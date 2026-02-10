import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { Storage } from "@/storage/storage"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { SessionCPD } from "./cpd"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false
    let compactionRequest: { reason: "context_length"; fallbackError: MessageV2.Assistant["error"] } | undefined

    const result = {
      get message() {
        return input.assistantMessage
      },
      get compactionRequest() {
        return compactionRequest
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        compactionRequest = undefined
        const config = await Config.get()
        const shouldBreak = config.experimental?.continue_loop_on_deny !== true

        let ignoredOpenAIReasoning = false

        const ignoreOpenAIReasoning = async () => {
          if (ignoredOpenAIReasoning) return
          ignoredOpenAIReasoning = true

          // Persist that the provider rejected reasoning context so:
          // - the model-visible banner can reflect it
          // - the TUI can show an indicator
          await SessionCPD.flag(input.sessionID, { rctx: true })

          // Add a transcript marker (UI-only) for auditability.
          const now = Date.now()
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: input.assistantMessage.id,
            sessionID: input.sessionID,
            type: "text",
            synthetic: true,
            ignored: true,
            text: "Provider rejected prior reasoning context (older thinking dropped)",
            time: {
              start: now,
              end: now,
            },
            metadata: {
              opencode: {
                marker: {
                  kind: "rctx",
                  at: now,
                },
              },
            },
          })

          const msgs = await Session.messages({ sessionID: input.sessionID })

          for (const msg of msgs) {
            for (const part of msg.parts) {
              if (part.type !== "reasoning") continue
              if (part.messageID === input.assistantMessage.id) continue
              if (part.ignored) continue
              if (!part.metadata) continue
              const openai = (part.metadata as { openai?: unknown }).openai
              if (!openai || typeof openai !== "object") continue

              const base =
                part.metadata && typeof part.metadata === "object" ? (part.metadata as Record<string, unknown>) : {}
              const existing =
                base.opencode && typeof base.opencode === "object" ? (base.opencode as Record<string, unknown>) : {}

              part.ignored = true
              part.metadata = {
                ...base,
                opencode: {
                  ...existing,
                  status: "omitted",
                  reason: "provider_rejected_reasoning_context",
                  at: Date.now(),
                },
              }
              await Session.updatePart(part)
            }
          }
        }

        const mergeMetadata = (a?: Record<string, unknown>, b?: Record<string, unknown>) => {
          if (!a) return b
          if (!b) return a

          const result = {
            ...a,
            ...b,
          } as Record<string, unknown>

          const ao = (a as { openai?: unknown }).openai
          const bo = (b as { openai?: unknown }).openai

          if (ao && typeof ao === "object" && bo && typeof bo === "object") {
            result.openai = {
              ...(ao as Record<string, unknown>),
              ...(bo as Record<string, unknown>),
            }
          }

          return result
        }

        const cleanup = async (preserve: Set<string>) => {
          snapshot = undefined
          for (const key of Object.keys(toolcalls)) {
            delete toolcalls[key]
          }

          const parts = await MessageV2.parts(input.assistantMessage.id)
          for (const part of parts) {
            if (preserve.has(part.id)) continue
            await Storage.remove(["part", input.assistantMessage.id, part.id])
            await Bus.publish(MessageV2.Event.PartRemoved, {
              sessionID: input.assistantMessage.sessionID,
              messageID: input.assistantMessage.id,
              partID: part.id,
            })
          }
        }

        while (true) {
          const preserve = new Set((await MessageV2.parts(input.assistantMessage.id)).map((p) => p.id))
          let retrySafe = true

          try {
            let currentText: MessageV2.TextPart | undefined
            const storeReasoning = streamInput.agent.name !== "compaction"
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            let stopStream = false

            const stream = await LLM.stream(streamInput)

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "stream-start" as any: {
                  const warnings = (value as { warnings?: unknown }).warnings
                  if (!Array.isArray(warnings)) break

                  const dropped = warnings.some((w) => {
                    const msg = (w as { message?: unknown }).message
                    if (typeof msg !== "string") return false
                    return msg.includes("Dropped previous reasoning context after OpenAI rejected it")
                  })

                  if (dropped) {
                    await ignoreOpenAIReasoning()
                  }
                  break
                }

                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  break

                case "reasoning-start":
                  if (!storeReasoning) break
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "reasoning-delta":
                  if (!storeReasoning) break
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = mergeMetadata(part.metadata, value.providerMetadata)
                    if (part.text) await Session.updatePart({ part, delta: value.text })
                  }
                  break

                case "reasoning-end":
                  if (!storeReasoning) break
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = mergeMetadata(part.metadata, value.providerMetadata)
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start": {
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })

                  toolcalls[value.id] = part as MessageV2.ToolPart

                  break
                }

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  if (streamInput.tools[value.toolName]) {
                    retrySafe = false
                  }
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input ?? match.state.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    if (match.tool === "wait_agent_message") {
                      const meta = value.output.metadata
                      const base = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : undefined
                      const status = base && typeof base.status === "string" ? base.status : undefined
                      if (status === "waiting") {
                        input.assistantMessage.finish = "tool-calls"
                        stopStream = true
                      }
                    }

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input ?? match.state.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step": {
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model })) {
                    needsCompaction = true
                  }
                  break
                }

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (currentText.text)
                      await Session.updatePart({
                        part: currentText,
                        delta: value.text,
                      })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    if (streamInput.agent.name === "compaction") {
                      currentText.text = currentText.text
                        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
                        .replace(/<analysis>[\s\S]*?<\/analysis>\s*/g, "")
                        .trim()
                    }
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (stopStream) break
              if (needsCompaction) break
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            const cfg = config
            const retry = SessionRetry.retryable(error)

            if (retry !== undefined && retrySafe) {
              const max = cfg.experimental?.chatMaxRetries ?? 3
              const limited = attempt >= max
              if (!limited) {
                attempt++
                const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
                SessionStatus.set(input.sessionID, {
                  type: "retry",
                  attempt,
                  message: retry,
                  next: Date.now() + delay,
                })
                await cleanup(preserve).catch(() => {})
                await SessionRetry.sleep(delay, input.abort).catch(() => {})
                continue
              }
            }

            const compactOnContextLengthError = await (async () => {
              if (streamInput.agent.name === "compaction") return false
              if (!isContextLengthError(error)) return false
              if (SessionCompaction.autoPolicy(cfg.compaction?.auto) === "deny") return false
              if (await isReplayPrompt(streamInput.user.id)) return false
              return true
            })()

            if (compactOnContextLengthError) {
              needsCompaction = true
              compactionRequest = { reason: "context_length", fallbackError: error }
            }

            if (!compactOnContextLengthError) {
              input.assistantMessage.error = error
              Bus.publish(Session.Event.Error, {
                sessionID: input.assistantMessage.sessionID,
                error: input.assistantMessage.error,
              })
            }
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }

  async function isReplayPrompt(messageID: string) {
    const parts = await MessageV2.parts(messageID)
    for (const part of parts) {
      if (part.type !== "text") continue
      if (!isRecord(part.metadata)) continue
      const oc = part.metadata["opencode"]
      if (!isRecord(oc)) continue
      if (oc["replay"] === true) return true
    }
    return false
  }

  function isContextLengthError(error: unknown) {
    const info = apiErrorInfo(error)
    if (!info) return false

    const code = apiErrorCode(info.responseBody)?.toLowerCase()
    if (code && code.includes("context_length")) return true

    const msg = info.message.toLowerCase()
    if (msg.includes("maximum context length")) return true
    if (msg.includes("context length") && msg.includes("exceed")) return true
    if (msg.includes("too many tokens")) return true
    if (msg.includes("prompt is too long")) return true
    if (msg.includes("input is too long")) return true
    if (msg.includes("context window") && (msg.includes("exceed") || msg.includes("too large"))) return true

    return false
  }

  function apiErrorInfo(error: unknown): { message: string; responseBody?: string } | undefined {
    if (!isRecord(error)) return
    if (error["name"] !== "APIError") return
    const data = error["data"]
    if (!isRecord(data)) return
    const message = data["message"]
    if (typeof message !== "string") return
    const responseBody = data["responseBody"]
    return {
      message,
      responseBody: typeof responseBody === "string" ? responseBody : undefined,
    }
  }

  function apiErrorCode(responseBody?: string): string | undefined {
    if (!responseBody) return
    const parsed = safeJsonParse(responseBody)
    if (!isRecord(parsed)) return

    const error = parsed["error"]
    if (isRecord(error)) {
      const code = error["code"]
      if (typeof code === "string") return code
      if (typeof code === "number") return String(code)
      const type = error["type"]
      if (typeof type === "string") return type
    }

    const code = parsed["code"]
    if (typeof code === "string") return code
    if (typeof code === "number") return String(code)

    return
  }

  function safeJsonParse(text: string): unknown {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }
}
