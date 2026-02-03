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

  // If a compaction crashes mid-flight, the marker is the only signal used to
  // inject "arrived while compacting" reminders for delivered messages.
  // Keep this TTL short to avoid false reminders long after a crash.
  const MARKER_TTL = 10 * 60 * 1000

  type Active = {
    abort: AbortController
    requestID: string
    startedAt: number
  }

  // Manual `/compact` (server summarize endpoint) runs outside the prompt-loop state.
  // Track it separately so we can reject overlaps and support session.abort cancellation.

  const active = Instance.state(
    () => new Map<string, Active>(),
    async (map) => {
      for (const item of map.values()) {
        item.abort.abort()
      }
      map.clear()
    },
  )

  export function manual(sessionID: string): { requestID: string; startedAt: number } | undefined {
    const entry = getActive(sessionID)
    if (!entry) return
    return {
      requestID: entry.requestID,
      startedAt: entry.startedAt,
    }
  }

  function getActive(sessionID: string) {
    return active().get(sessionID)
  }

  function markerKey(sessionID: string) {
    return ["compaction", sessionID]
  }

  export async function marker(sessionID: string): Promise<{ requestID: string; startedAt: number } | undefined> {
    const existing = await Storage.read<Marker>(markerKey(sessionID)).catch((error) => {
      // Marker records are derived; if the JSON is corrupt, clear it.
      if (Storage.NotFoundError.isInstance(error)) return
      Storage.remove(markerKey(sessionID)).catch(() => {})
      return
    })
    if (!existing) return

    const created = existing.time?.created
    if (typeof created !== "number") {
      Storage.remove(markerKey(sessionID)).catch(() => {})
      return
    }

    if (typeof existing.requestID !== "string" || !existing.requestID) {
      Storage.remove(markerKey(sessionID)).catch(() => {})
      return
    }

    if (typeof existing.startedAt !== "number") {
      Storage.remove(markerKey(sessionID)).catch(() => {})
      return
    }

    const stale = Date.now() - created > MARKER_TTL
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

  export async function unmark(sessionID: string, requestID: string) {
    await clearMarker(sessionID, requestID)
  }

  export function beginManual(input: { sessionID: string; requestID: string; startedAt: number }) {
    const existing = getActive(input.sessionID)
    if (existing) return

    const abort = new AbortController()
    const entry: Active = {
      abort,
      requestID: input.requestID,
      startedAt: input.startedAt,
    }
    active().set(input.sessionID, entry)
    return entry
  }

  export function abortManual(sessionID: string) {
    const entry = getActive(sessionID)
    if (!entry) return false
    entry.abort.abort()
    return true
  }

  export function endManual(input: { sessionID: string; requestID: string }) {
    const existing = active().get(input.sessionID)
    if (!existing) return
    if (existing.requestID !== input.requestID) return
    active().delete(input.sessionID)
  }

  export function forceEndManual(sessionID: string) {
    if (!active().has(sessionID)) return false
    active().delete(sessionID)
    return true
  }

  export async function clearAnyMarker(sessionID: string) {
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
      const started = Date.now()
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = started
          await Session.updatePart(part)
        }
      }
      await SessionCPD.flag(input.sessionID, { trim: true })

      const messageID = msgs.at(-1)?.info.id
      if (messageID) {
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: input.sessionID,
          messageID,
          type: "text",
          synthetic: true,
          ignored: true,
          text: `Tool outputs trimmed (${toPrune.length}; ~${pruned.toLocaleString()} tokens)`,
          time: {
            start: started,
            end: started,
          },
          metadata: {
            opencode: {
              marker: {
                kind: "trim",
                at: started,
                count: toPrune.length,
                tokens: pruned,
              },
            },
          },
        })
      }
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
                  messages: input.messages,
                  metadata: () => {},
                  ask: async (_req) => {},
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
          ...MessageV2.toModelMessages(omitAssistantReasoning(input.messages), model),
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

      // Legacy auto-compaction replay prompts are retired. The context pipeline
      // continues the session without synthesizing new user messages.
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
