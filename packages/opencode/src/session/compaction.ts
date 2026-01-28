import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import { jsonSchema, stepCountIs, tool } from "ai"
import z from "zod"
import { InvalidTool } from "@/tool/invalid"
import { SessionPrompt } from "./prompt"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { Storage } from "@/storage/storage"
import { SessionCPD } from "./cpd"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  export type AutoPolicy = "allow" | "deny" | "ask"

  export function autoPolicy(input?: Config.PermissionAction | boolean): AutoPolicy {
    if (input === undefined) return "allow"
    if (typeof input === "boolean") return input ? "allow" : "deny"
    return input
  }

  type Marker = {
    requestID: string
    startedAt: number
    time: {
      created: number
    }
  }

  const MARKER_TTL = 60 * 60 * 1000

  function markerKey(sessionID: string) {
    return ["compaction", sessionID]
  }

  export async function marker(sessionID: string): Promise<{ requestID: string; startedAt: number } | undefined> {
    const existing = await Storage.read<Marker>(markerKey(sessionID)).catch(() => undefined)
    if (!existing) return

    const stale = Date.now() - existing.time.created > MARKER_TTL
    if (stale) {
      Storage.remove(markerKey(sessionID)).catch(() => {})
      return
    }

    return {
      requestID: existing.requestID,
      startedAt: existing.startedAt,
    }
  }

  export async function mark(input: { sessionID: string; requestID: string; startedAt: number }) {
    await Storage.write(markerKey(input.sessionID), {
      requestID: input.requestID,
      startedAt: input.startedAt,
      time: {
        created: Date.now(),
      },
    } satisfies Marker)
  }

  async function clearMarker(sessionID: string, requestID: string) {
    const existing = await marker(sessionID)
    if (!existing) return
    if (existing.requestID !== requestID) return
    await Storage.remove(markerKey(sessionID)).catch(() => {})
  }

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    if (autoPolicy(config.compaction?.auto) === "deny") return false
    const context = input.model.limit.context
    if (context === 0) return false
    const count = input.tokens.input + input.tokens.cache.read + input.tokens.output
    const output = Math.min(input.model.limit.output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
    const usable = input.model.limit.input || context - output
    return count > usable
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill"]

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: string }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    // NOTE: Only tool outputs are pruned. MessageParts (agent-to-agent communication)
    // are intentionally preserved as they provide critical context for understanding
    // the conversation flow and subagent coordination.
    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      await SessionCPD.flag(input.sessionID, { trim: true })
      log.info("pruned", { count: toPrune.length })
    }
  }

  function omitAssistantReasoning(messages: MessageV2.WithParts[]) {
    return messages.map((msg) => {
      if (msg.info.role !== "assistant") return msg
      return {
        ...msg,
        parts: msg.parts.filter((p) => p.type !== "reasoning"),
      }
    })
  }

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
  }) {
    try {
      const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User
      const agent = await Agent.get("compaction")
      const model = agent.model
        ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
        : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
      const msg = (await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        summary: true,
        path: {
          cwd: Instance.directory,
          root: Instance.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      })) as MessageV2.Assistant
      const processor = SessionProcessor.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
        abort: input.abort,
      })
      // Allow plugins to inject context or replace compaction prompt
      const compacting = await Plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const invalid = await InvalidTool.init()
      const defaultPrompt =
        "Provide a detailed prompt for continuing our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next considering new session will not have access to our conversation."
      const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
      const result = await processor.process({
        user: userMessage,
        agent,
        abort: input.abort,
        sessionID: input.sessionID,
        tools: {
          invalid: tool({
            id: "invalid" as any,
            description: invalid.description,
            inputSchema: jsonSchema(z.toJSONSchema(invalid.parameters) as any),
            async execute(args, options) {
              return invalid.execute(args as any, {
                sessionID: input.sessionID,
                abort: options.abortSignal!,
                messageID: msg.id,
                callID: options.toolCallId,
                extra: { model },
                agent: agent.name,
                metadata: () => {},
                ask: async () => {},
              })
            },
            toModelOutput(result) {
              return {
                type: "text",
                value: result.output,
              }
            },
          }),
        },
        system: [],
        stopWhen: stepCountIs(3),
        messages: [
          ...MessageV2.toModelMessage(omitAssistantReasoning(input.messages)),
          {
            role: "user",
            content: [
              {
                type: "text",
                text: promptText,
              },
            ],
          },
        ],
        model,
      })

      if (result === "continue" && input.auto) {
        const parentIndex = input.messages.findIndex((m) => m.info.id === input.parentID)
        const history = parentIndex > 0 ? input.messages.slice(0, parentIndex) : []
        const target = history
          .slice()
          .reverse()
          .find((m) => {
            if (m.info.role !== "user") return false
            if (m.parts.some((p) => p.type === "compaction")) return false
            if (m.parts.some((p) => p.type === "text" && !p.ignored && !p.synthetic)) return true
            if (m.parts.some((p) => p.type === "message" && p.direction === "incoming")) return true
            if (m.parts.some((p) => p.type === "file")) return true
            return false
          })

        const targetUser = target ? (target.info as MessageV2.User) : undefined

        const answered = (() => {
          if (!targetUser) return false
          return history.some((m) => {
            if (m.info.role !== "assistant") return false
            const assistant = m.info as MessageV2.Assistant
            if (assistant.parentID !== targetUser.id) return false
            if (!assistant.finish) return false
            if (["tool-calls", "unknown"].includes(assistant.finish)) return false
            if (assistant.error) return false
            return true
          })
        })()

        const replayable = !!target && !!targetUser && !answered

        if (replayable) {
          const now = Date.now()
          const replayMsg = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: input.sessionID,
            time: {
              created: now,
            },
            agent: targetUser.agent,
            model: targetUser.model,
            system: targetUser.system,
            tools: targetUser.tools,
            variant: targetUser.variant,
          })

          const meta = {
            opencode: {
              replay: true,
              sourceMessageID: targetUser.id,
            },
          }

          const fileLabel = (file: MessageV2.FilePart) => {
            if (file.filename) return file.filename
            const src = file.source
            if (src && (src.type === "file" || src.type === "symbol")) return src.path
            if (file.url.startsWith("file://")) return file.url.replace(/^file:\/\//, "").split("?")[0]
            if (file.url.startsWith("data:")) return `inline ${file.mime}`
            return file.url
          }

          const files = target.parts.filter((p): p is MessageV2.FilePart => p.type === "file")
          const dropped = files.filter((f) => f.mime === "text/plain" || f.mime === "application/x-directory")

          if (dropped.length > 0) {
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text: [
                "Some attachments may not be available after compaction:",
                ...dropped.map((f) => `- ${fileLabel(f)} (${f.mime})`),
                "Re-read them in this session if needed.",
              ].join("\n"),
              time: {
                start: now,
                end: now,
              },
            })
          }

          const msgs = target.parts.filter(
            (p): p is MessageV2.MessagePart => p.type === "message" && p.direction === "incoming",
          )
          for (const msg of msgs) {
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
              type: "message",
              direction: msg.direction,
              peer: msg.peer,
              peerType: msg.peerType,
              text: msg.text,
              timeout: msg.timeout,
              timeoutOccurred: msg.timeoutOccurred,
              time: msg.time,
            })
          }

          const texts = target.parts.filter(
            (p): p is MessageV2.TextPart => p.type === "text" && !p.ignored && !p.synthetic,
          )

          for (const text of texts) {
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
              type: "text",
              text: text.text,
              synthetic: true,
              metadata: meta,
              time: {
                start: now,
                end: now,
              },
            })
          }

          if (texts.length === 0) {
            const list =
              files.length > 0
                ? ["Attachments:", ...files.map((f) => `- ${fileLabel(f)} (${f.mime})`)].join("\n")
                : undefined
            const note =
              msgs.length > 0 ? "Please respond to the message(s) above." : "Please respond to the previous user input."
            const text = list ? [note, list].join("\n\n") : note
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
              type: "text",
              text,
              synthetic: true,
              metadata: meta,
              time: {
                start: now,
                end: now,
              },
            })
          }

          for (const file of files) {
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
              type: "file",
              mime: file.mime,
              filename: file.filename,
              url: file.url,
              source: file.source,
            })
          }
        }

        if (!replayable) {
          const now = Date.now()
          const continueMsg = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: input.sessionID,
            time: {
              created: now,
            },
            agent: userMessage.agent,
            model: userMessage.model,
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: continueMsg.id,
            sessionID: input.sessionID,
            type: "text",
            synthetic: true,
            text: "Continue if you have next steps",
            time: {
              start: now,
              end: now,
            },
          })
        }
      }
      if (processor.message.error) return "stop"
      Bus.publish(Event.Compacted, { sessionID: input.sessionID })
      return "continue"
    } finally {
      await clearMarker(input.sessionID, input.parentID).catch(() => {})
    }
  }

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      auto: z.boolean(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
      })
      await mark({
        sessionID: input.sessionID,
        requestID: msg.id,
        startedAt: msg.time.created,
      })
    },
  )
}
