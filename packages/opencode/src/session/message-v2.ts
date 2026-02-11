import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import {
  APICallError,
  convertToModelMessages,
  JSONParseError,
  LoadAPIKeyError,
  TypeValidationError,
  type ModelMessage,
  type UIMessage,
} from "ai"
import { Identifier } from "../id/id"
import { LSP } from "../lsp"
import { Snapshot } from "@/snapshot"
import { fn } from "@/util/fn"
import { Storage } from "@/storage/storage"
import { ProviderTransform } from "@/provider/transform"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import { SkillProjection } from "@/util/skill-projection"
import { modelVisibleMessage } from "@/util/model-visible"
import { type SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { MessageParser } from "./message-parser"

export namespace MessageV2 {
  export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
  export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
  export const AuthError = NamedError.create(
    "ProviderAuthError",
    z.object({
      providerID: z.string(),
      message: z.string(),
    }),
  )
  export const APIError = NamedError.create(
    "APIError",
    z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.boolean(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      responseBody: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  )
  export type APIError = z.infer<typeof APIError.Schema>

  const PartBase = z.object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
  })

  export const SnapshotPart = PartBase.extend({
    type: z.literal("snapshot"),
    snapshot: z.string(),
  }).meta({
    ref: "SnapshotPart",
  })
  export type SnapshotPart = z.infer<typeof SnapshotPart>

  export const PatchPart = PartBase.extend({
    type: z.literal("patch"),
    hash: z.string(),
    files: z.string().array(),
  }).meta({
    ref: "PatchPart",
  })
  export type PatchPart = z.infer<typeof PatchPart>

  export const TextPart = PartBase.extend({
    type: z.literal("text"),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    time: z
      .object({
        start: z.number(),
        end: z.number().optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "TextPart",
  })
  export type TextPart = z.infer<typeof TextPart>

  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    ignored: z.boolean().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
      end: z.number().optional(),
    }),
  }).meta({
    ref: "ReasoningPart",
  })
  export type ReasoningPart = z.infer<typeof ReasoningPart>

  const FilePartSourceBase = z.object({
    text: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .meta({
        ref: "FilePartSourceText",
      }),
  })

  export const FileSource = FilePartSourceBase.extend({
    type: z.literal("file"),
    path: z.string(),
  }).meta({
    ref: "FileSource",
  })

  export const SymbolSource = FilePartSourceBase.extend({
    type: z.literal("symbol"),
    path: z.string(),
    range: LSP.Range,
    name: z.string(),
    kind: z.number().int(),
  }).meta({
    ref: "SymbolSource",
  })

  export const ResourceSource = FilePartSourceBase.extend({
    type: z.literal("resource"),
    clientName: z.string(),
    uri: z.string(),
  }).meta({
    ref: "ResourceSource",
  })

  export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
    ref: "FilePartSource",
  })

  export const FilePart = PartBase.extend({
    type: z.literal("file"),
    mime: z.string(),
    filename: z.string().optional(),
    url: z.string(),
    source: FilePartSource.optional(),
  }).meta({
    ref: "FilePart",
  })
  export type FilePart = z.infer<typeof FilePart>

  const FILE_LABEL_MAX = 200

  function capLabel(value: string) {
    if (value.length <= FILE_LABEL_MAX) return value
    return value.slice(0, FILE_LABEL_MAX) + "..."
  }

  // CPD delta text should never inline raw file payloads (eg, `data:` base64 URLs).
  // This produces a short, stable label for attachments.
  export function fileLabel(file: MessageV2.FilePart) {
    if (file.filename) return file.filename

    const src = file.source
    if (src) {
      if (src.type === "file" || src.type === "symbol") return src.path
      if (src.type === "resource") return `resource ${src.clientName}:${capLabel(src.uri)}`
    }

    const url = file.url
    if (url.startsWith("file://")) return url.replace(/^file:\/\//, "").split("?")[0]
    if (url.startsWith("data:")) return `inline ${file.mime}`
    return capLabel(url.split("?")[0])
  }

  export function excerpt(value: string, max: number) {
    if (value.length <= max) return value
    return value.slice(0, max) + `\n...[${value.length - max} chars omitted]...`
  }

  export const AgentPart = PartBase.extend({
    type: z.literal("agent"),
    name: z.string(),
    source: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .optional(),
  }).meta({
    ref: "AgentPart",
  })
  export type AgentPart = z.infer<typeof AgentPart>

  export const CompactionPart = PartBase.extend({
    type: z.literal("compaction"),
    auto: z.boolean(),
  }).meta({
    ref: "CompactionPart",
  })
  export type CompactionPart = z.infer<typeof CompactionPart>

  export const SubtaskPart = PartBase.extend({
    type: z.literal("subtask"),
    prompt: z.string(),
    description: z.string(),
    agent: z.string(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    command: z.string().optional(),
  })
  export type SubtaskPart = z.infer<typeof SubtaskPart>

  export const MessagePart = PartBase.extend({
    type: z.literal("message"),
    direction: z.enum(["outgoing", "incoming"]),
    peer: z.string(),
    peerType: z.enum(["human", "agent", "system"]),
    text: z.string(),
    timeout: z.number().optional(),
    timeoutOccurred: z.boolean().optional(),
    time: z.object({
      created: z.number(),
    }),
  }).meta({
    ref: "MessagePart",
  })
  export type MessagePart = z.infer<typeof MessagePart>

  export const WaitPart = PartBase.extend({
    type: z.literal("wait"),
    sources: z.array(z.string()),
    timeout: z.number(),
    mode: z.enum(["all", "any"]),
    status: z.enum(["waiting", "resolved", "timedOut"]),
    respondedSources: z.array(z.string()).default([]),
    time: z.object({
      created: z.number(),
      resolved: z.number().optional(),
    }),
  }).meta({
    ref: "WaitPart",
  })
  export type WaitPart = z.infer<typeof WaitPart>

  export const RetryPart = PartBase.extend({
    type: z.literal("retry"),
    attempt: z.number(),
    error: APIError.Schema,
    time: z.object({
      created: z.number(),
    }),
  }).meta({
    ref: "RetryPart",
  })
  export type RetryPart = z.infer<typeof RetryPart>

  export const StepStartPart = PartBase.extend({
    type: z.literal("step-start"),
    snapshot: z.string().optional(),
  }).meta({
    ref: "StepStartPart",
  })
  export type StepStartPart = z.infer<typeof StepStartPart>

  export const StepFinishPart = PartBase.extend({
    type: z.literal("step-finish"),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
  }).meta({
    ref: "StepFinishPart",
  })
  export type StepFinishPart = z.infer<typeof StepFinishPart>

  export const ToolStatePending = z
    .object({
      status: z.literal("pending"),
      input: z.record(z.string(), z.any()),
      raw: z.string(),
    })
    .meta({
      ref: "ToolStatePending",
    })

  export type ToolStatePending = z.infer<typeof ToolStatePending>

  export const ToolStateRunning = z
    .object({
      status: z.literal("running"),
      input: z.record(z.string(), z.any()),
      title: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateRunning",
    })
  export type ToolStateRunning = z.infer<typeof ToolStateRunning>

  export const ToolStateCompleted = z
    .object({
      status: z.literal("completed"),
      input: z.record(z.string(), z.any()),
      output: z.string(),
      title: z.string(),
      metadata: z.record(z.string(), z.any()),
      time: z.object({
        start: z.number(),
        end: z.number(),
        compacted: z.number().optional(),
      }),
      attachments: FilePart.array().optional(),
    })
    .meta({
      ref: "ToolStateCompleted",
    })
  export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

  export const ToolStateError = z
    .object({
      status: z.literal("error"),
      input: z.record(z.string(), z.any()),
      error: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
        end: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateError",
    })
  export type ToolStateError = z.infer<typeof ToolStateError>

  export const ToolState = z
    .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
    .meta({
      ref: "ToolState",
    })

  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: ToolState,
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "ToolPart",
  })
  export type ToolPart = z.infer<typeof ToolPart>

  const Base = z.object({
    id: z.string(),
    sessionID: z.string(),
  })

  export const User = Base.extend({
    role: z.literal("user"),
    time: z.object({
      created: z.number(),
    }),
    summary: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        diffs: Snapshot.FileDiff.array(),
      })
      .optional(),
    agent: z.string(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
    }),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    variant: z.string().optional(),
  }).meta({
    ref: "UserMessage",
  })
  export type User = z.infer<typeof User>

  export const Part = z
    .discriminatedUnion("type", [
      TextPart,
      SubtaskPart,
      ReasoningPart,
      FilePart,
      ToolPart,
      StepStartPart,
      StepFinishPart,
      SnapshotPart,
      PatchPart,
      AgentPart,
      RetryPart,
      CompactionPart,
      MessagePart,
      WaitPart,
    ])
    .meta({
      ref: "Part",
    })
  export type Part = z.infer<typeof Part>

  export const Assistant = Base.extend({
    role: z.literal("assistant"),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    error: z
      .discriminatedUnion("name", [
        AuthError.Schema,
        NamedError.Unknown.Schema,
        OutputLengthError.Schema,
        AbortedError.Schema,
        APIError.Schema,
      ])
      .optional(),
    parentID: z.string(),
    modelID: z.string(),
    providerID: z.string(),
    /**
     * @deprecated
     */
    mode: z.string(),
    agent: z.string(),
    path: z.object({
      cwd: z.string(),
      root: z.string(),
    }),
    summary: z.boolean().optional(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    finish: z.string().optional(),
  }).meta({
    ref: "AssistantMessage",
  })
  export type Assistant = z.infer<typeof Assistant>

  export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
    ref: "Message",
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "message.updated",
      z.object({
        info: Info,
      }),
    ),
    Removed: BusEvent.define(
      "message.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
      }),
    ),
    PartUpdated: BusEvent.define(
      "message.part.updated",
      z.object({
        part: Part,
        delta: z.string().optional(),
      }),
    ),
    PartRemoved: BusEvent.define(
      "message.part.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
        partID: z.string(),
      }),
    ),
  }

  export const WithParts = z.object({
    info: Info,
    parts: z.array(Part),
  })
  export type WithParts = z.infer<typeof WithParts>

  export function modelVisible(msg: WithParts) {
    return modelVisibleMessage({
      message: msg.info,
      parts: msg.parts,
      aborted(error) {
        return MessageV2.AbortedError.isInstance(error)
      },
    })
  }

  export function toModelMessages(input: WithParts[], model: Provider.Model): ModelMessage[] {
    const result: UIMessage[] = []
    const toolNames = new Set<string>()
    const visible = input.filter((msg) => modelVisible(msg))
    const projection = SkillProjection.project(
      visible.map((msg) => ({
        id: msg.info.id,
        role: msg.info.role,
        parts: msg.parts,
      })),
    )

    const skillMarker = (names: string[]) => {
      return `Context note: superseded skill loads omitted: ${names.join(", ")}. Newer successful loads are authoritative.`
    }

    const toModelOutput = (output: unknown) => {
      if (typeof output === "string") {
        return { type: "text", value: output }
      }

      if (typeof output === "object") {
        const outputObject = output as {
          text: string
          attachments?: Array<{ mime: string; url: string }>
        }
        const attachments = (outputObject.attachments ?? []).filter((attachment) => {
          return attachment.url.startsWith("data:") && attachment.url.includes(",")
        })

        return {
          type: "content",
          value: [
            { type: "text", text: outputObject.text },
            ...attachments.map((attachment) => ({
              type: "media",
              mediaType: attachment.mime,
              data: iife(() => {
                const commaIndex = attachment.url.indexOf(",")
                return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
              }),
            })),
          ],
        }
      }

      return { type: "json", value: output as never }
    }

    const partSeq = (part: MessagePart) => {
      const meta = part.metadata
      const opencode = meta && typeof meta === "object" ? (meta as { opencode?: unknown }).opencode : undefined
      if (!opencode || typeof opencode !== "object") return
      const value = (opencode as { seq?: unknown }).seq
      if (typeof value !== "number") return
      if (!Number.isInteger(value) || value <= 0) return
      return value
    }

    const systemMessageText = (part: MessagePart) => {
      const seq = partSeq(part)
      const head = typeof seq === "number" ? `${part.peer} (seq: ${seq}):` : `${part.peer}:`
      return [head, "<content>", part.text, "</content>"].join("\n")
    }

    for (const msg of visible) {
      if (msg.info.role === "user") {
        const userMessage: UIMessage = {
          id: msg.info.id,
          role: "user",
          parts: [],
        }
        result.push(userMessage)
        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored)
            userMessage.parts.push({
              type: "text",
              text: part.text,
            })
          // text/plain and directory files are converted into text parts, ignore them
          if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory")
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })

          if (part.type === "message") {
            if (part.direction === "outgoing") continue

            const legacyInbox = msg.parts.some(
              (p) => p.type === "text" && p.synthetic && p.text.startsWith("Sender Agent with session id"),
            )

            if (legacyInbox && part.direction === "incoming" && part.peerType === "agent") continue

            const text = (() => {
              if (part.direction === "incoming" && part.peerType === "system") {
                return systemMessageText(part)
              }

              if (part.direction === "incoming" && part.peerType === "agent") {
                const seq = partSeq(part)

                return MessageParser.formatInbox([
                  {
                    from: part.peer,
                    text: part.text,
                    seq,
                    messageType: part.timeoutOccurred ? "timeout" : "normal",
                  },
                ])
              }

              const dir = part.direction === "incoming" ? "from" : "to"
              const who = part.peerType === "agent" ? `Agent with session id ${part.peer}` : part.peer
              const suffix = part.timeoutOccurred ? " (timed out)" : ""
              return [`Message ${dir} ${who}${suffix}:`, "<content>", part.text, "</content>"].join("\n")
            })()

            userMessage.parts.push({
              type: "text",
              text,
            })
          }

          // Compaction parts are a UI/session marker only; do not inject them into model context.
          if (part.type === "subtask") {
            userMessage.parts.push({
              type: "text",
              text: "The following tool was executed by the user",
            })
          }
        }
      }

      if (msg.info.role === "assistant") {
        const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`

        const assistantMessage: UIMessage = {
          id: msg.info.id,
          role: "assistant",
          parts: [],
        }
        const superseded = projection.supersededNamesByMessageID.get(msg.info.id)
        if (superseded && superseded.length > 0) {
          assistantMessage.parts.push({
            type: "text",
            text: skillMarker(superseded),
          })
        }
        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored)
            assistantMessage.parts.push({
              type: "text",
              text: part.text,
              ...(differentModel ? {} : { providerMetadata: part.metadata }),
            })

          if (part.type === "message") {
            if (part.direction === "outgoing") continue

            const text = (() => {
              if (part.direction === "incoming" && part.peerType === "system") {
                return systemMessageText(part)
              }

              if (part.direction === "incoming" && part.peerType === "agent") {
                const seq = partSeq(part)

                return MessageParser.formatInbox([
                  {
                    from: part.peer,
                    text: part.text,
                    seq,
                    messageType: part.timeoutOccurred ? "timeout" : "normal",
                  },
                ])
              }

              const dir = part.direction === "incoming" ? "from" : "to"
              const who = part.peerType === "agent" ? `Agent with session id ${part.peer}` : part.peer
              const suffix = part.timeoutOccurred ? " (timed out)" : ""
              return [`Message ${dir} ${who}${suffix}:`, "<content>", part.text, "</content>"].join("\n")
            })()

            assistantMessage.parts.push({
              type: "text",
              text,
            })
          }
          if (part.type === "step-start")
            assistantMessage.parts.push({
              type: "step-start",
            })
          if (part.type === "tool") {
            const noOpSkill =
              part.tool === "skill" &&
              part.state.status === "completed" &&
              (() => {
                const meta = part.state.metadata
                if (!meta || typeof meta !== "object") return false
                return (meta as { applied?: unknown }).applied === false
              })()

            if (
              part.tool === "skill" &&
              part.state.status === "completed" &&
              (projection.supersededPartIDs.has(part.id) || noOpSkill)
            ) {
              continue
            }

            toolNames.add(part.tool)
            if (part.state.status === "completed") {
              const outputText = part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output
              const attachments = part.state.time.compacted ? [] : (part.state.attachments ?? [])
              const output =
                attachments.length > 0
                  ? {
                      text: outputText,
                      attachments,
                    }
                  : outputText

              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
            }
            if (part.state.status === "error")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
            // Handle pending/running tool calls to prevent dangling tool_use blocks
            // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
            if (part.state.status === "pending" || part.state.status === "running")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: "[Tool execution was interrupted]",
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
          }
          if (part.type === "reasoning" && !part.ignored) {
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
              ...(differentModel ? {} : { providerMetadata: part.metadata }),
            })
          }
        }
        if (assistantMessage.parts.length > 0) {
          result.push(assistantMessage)
        }
      }
    }

    const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

    return convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    )
  }

  export const stream = fn(Identifier.schema("session"), async function* (sessionID) {
    const list = await Array.fromAsync(await Storage.list(["message", sessionID]))
    for (let i = list.length - 1; i >= 0; i--) {
      yield await get({
        sessionID,
        messageID: list[i][2],
      })
    }
  })

  export const parts = fn(Identifier.schema("message"), async (messageID) => {
    const result = [] as MessageV2.Part[]
    for (const item of await Storage.list(["part", messageID])) {
      const read = await Storage.read<MessageV2.Part>(item)
      result.push(read)
    }
    result.sort((a, b) => (a.id > b.id ? 1 : -1))
    return result
  })

  export const get = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input): Promise<WithParts> => {
      return {
        info: await Storage.read<MessageV2.Info>(["message", input.sessionID, input.messageID]),
        parts: await parts(input.messageID),
      }
    },
  )

  export async function filterCompacted(stream: AsyncIterable<MessageV2.WithParts>) {
    const result = [] as MessageV2.WithParts[]
    const completed = new Set<string>()
    for await (const msg of stream) {
      result.push(msg)
      if (
        msg.info.role === "user" &&
        completed.has(msg.info.id) &&
        msg.parts.some((part) => part.type === "compaction")
      )
        break
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish) completed.add(msg.info.parentID)
    }
    result.reverse()
    return result
  }

  const OPENAI_STREAM_ERROR_BODY_MAX = 4096

  function capText(value: string | undefined) {
    if (!value) return
    if (value.length <= OPENAI_STREAM_ERROR_BODY_MAX) return value
    return value.slice(0, OPENAI_STREAM_ERROR_BODY_MAX)
  }

  function openAIResponseErrorChunk(value: unknown):
    | {
        message: string
        code?: string
        errorType?: string
        param?: string
        responseBody?: string
      }
    | undefined {
    if (!isRecord(value)) return
    if (value["type"] !== "error") return

    const nested = value["error"]
    if (isRecord(nested)) {
      const message = nested["message"]
      if (typeof message !== "string") return

      const rawCode = nested["code"]
      const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : undefined

      const rawType = nested["type"]
      const errorType = typeof rawType === "string" ? rawType : undefined

      const rawParam = nested["param"]
      const param = typeof rawParam === "string" ? rawParam : undefined

      const responseBody = capText(
        safeJsonStringify({
          type: "error",
          error: {
            message,
            code,
            type: errorType,
            param,
          },
        }),
      )

      return {
        message,
        code,
        errorType,
        param,
        responseBody,
      }
    }

    const message = value["message"]
    if (typeof message !== "string") return

    const rawCode = value["code"]
    const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : undefined

    const rawParam = value["param"]
    const param = typeof rawParam === "string" ? rawParam : undefined

    const responseBody = capText(
      safeJsonStringify({
        type: "error",
        message,
        code,
        param,
      }),
    )

    return {
      message,
      code,
      param,
      responseBody,
    }
  }

  function openAIResponseErrorEnvelope(value: unknown):
    | {
        message: string
        code?: string
        errorType?: string
        param?: string
        responseBody?: string
      }
    | undefined {
    if (!isRecord(value)) return
    const nested = value["error"]
    if (!isRecord(nested)) return

    const message = nested["message"]
    if (typeof message !== "string") return

    const rawCode = nested["code"]
    const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : undefined

    const rawType = nested["type"]
    const errorType = typeof rawType === "string" ? rawType : undefined

    const rawParam = nested["param"]
    const param = typeof rawParam === "string" ? rawParam : undefined

    const responseBody = capText(
      safeJsonStringify({
        error: {
          message,
          code,
          type: errorType,
          param,
        },
      }),
    )

    return {
      message,
      code,
      errorType,
      param,
      responseBody,
    }
  }

  function openAIResponseErrorRetryable(input: { message: string; code?: string; errorType?: string }) {
    const code = input.code?.toLowerCase()
    if (code && code.includes("context_length")) return false

    const msg = input.message.toLowerCase()
    if (msg.includes("maximum context length")) return false
    if (msg.includes("context length") && msg.includes("exceed")) return false
    if (msg.includes("context window") && msg.includes("exceed")) return false

    const type = input.errorType?.toLowerCase()
    if (type && type.includes("rate_limit")) return true
    if (type && type.includes("too_many_requests")) return true
    if (type && type.includes("server_error")) return true
    if (type && type.includes("stream_error")) return true

    if (code && code.includes("rate_limit")) return true
    if (code && code.includes("too_many_requests")) return true
    if (code && code.includes("unavailable")) return true
    if (code && code.includes("exhausted")) return true
    if (code && code.includes("internal")) return true

    if (msg.includes("overloaded")) return true

    // Some gateways misclassify broken SSE streams as invalid_request_error.
    if (msg.includes("sse") && msg.includes("response.completed")) return true
    if (msg.includes("stream") && msg.includes("response.completed")) return true
    if (msg.includes("stream") && msg.includes("closed") && msg.includes("response.completed")) return true
    if (msg.includes("消息流出现异常")) return true
    if (msg.includes("流在收到") && msg.includes("response.completed")) return true

    return false
  }

  function safeJsonStringify(value: unknown) {
    try {
      return JSON.stringify(value)
    } catch {
      return
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }

  const isOpenAiErrorRetryable = (e: APICallError) => {
    const status = e.statusCode
    if (!status) return e.isRetryable
    // openai sometimes returns 404 for models that are actually available
    return status === 404 || e.isRetryable
  }

  export function fromError(e: unknown, ctx: { providerID: string }) {
    const stream = openAIResponseErrorChunk(e)
    if (stream) {
      const metadata: Record<string, string> = {}
      if (stream.code !== undefined) metadata.code = stream.code
      if (stream.param !== undefined) metadata.param = stream.param
      if (stream.errorType !== undefined) metadata.type = stream.errorType

      const retryable = openAIResponseErrorRetryable(stream)

      return new MessageV2.APIError(
        {
          message: stream.message,
          isRetryable: retryable,
          responseBody: stream.responseBody,
          metadata: Object.keys(metadata).length ? metadata : undefined,
        },
        { cause: e },
      ).toObject()
    }

    const gateway = openAIResponseErrorEnvelope(e)
    if (gateway) {
      const metadata: Record<string, string> = {}
      if (gateway.code !== undefined) metadata.code = gateway.code
      if (gateway.param !== undefined) metadata.param = gateway.param
      if (gateway.errorType !== undefined) metadata.type = gateway.errorType

      const retryable = openAIResponseErrorRetryable(gateway)

      return new MessageV2.APIError(
        {
          message: gateway.message,
          isRetryable: retryable,
          responseBody: gateway.responseBody,
          metadata: Object.keys(metadata).length ? metadata : undefined,
        },
        { cause: e },
      ).toObject()
    }

    if (TypeValidationError.isInstance(e)) {
      const nested = openAIResponseErrorEnvelope(e.value)
      if (nested) {
        const metadata: Record<string, string> = {}
        if (nested.code !== undefined) metadata.code = nested.code
        if (nested.param !== undefined) metadata.param = nested.param
        if (nested.errorType !== undefined) metadata.type = nested.errorType

        const retryable = openAIResponseErrorRetryable(nested)

        return new MessageV2.APIError(
          {
            message: nested.message,
            isRetryable: retryable,
            responseBody: nested.responseBody,
            metadata: Object.keys(metadata).length ? metadata : undefined,
          },
          { cause: e },
        ).toObject()
      }
    }

    if (JSONParseError.isInstance(e)) {
      const responseBody = typeof e.text === "string" ? capText(e.text) : undefined

      return new MessageV2.APIError(
        {
          message: "Provider stream interrupted",
          isRetryable: true,
          responseBody,
          metadata: {
            type: "json_parse_error",
          },
        },
        { cause: e },
      ).toObject()
    }

    switch (true) {
      case e instanceof DOMException && e.name === "AbortError":
        return new MessageV2.AbortedError(
          { message: e.message },
          {
            cause: e,
          },
        ).toObject()
      case MessageV2.OutputLengthError.isInstance(e):
        return e
      case LoadAPIKeyError.isInstance(e):
        return new MessageV2.AuthError(
          {
            providerID: ctx.providerID,
            message: e.message,
          },
          { cause: e },
        ).toObject()
      case (e as SystemError)?.code === "ECONNRESET":
        return new MessageV2.APIError(
          {
            message: "Connection reset by server",
            isRetryable: true,
            metadata: {
              code: (e as SystemError).code ?? "",
              syscall: (e as SystemError).syscall ?? "",
              message: (e as SystemError).message ?? "",
            },
          },
          { cause: e },
        ).toObject()
      case APICallError.isInstance(e): {
        const message = iife(() => {
          let msg = e.message
          if (msg === "") {
            if (e.responseBody) return e.responseBody
            if (e.statusCode) {
              const err = STATUS_CODES[e.statusCode]
              if (err) return err
            }
            return "Unknown error"
          }
          const transformed = ProviderTransform.error(ctx.providerID, e)
          if (transformed !== msg) {
            return transformed
          }
          if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
            return msg
          }

          try {
            const body = JSON.parse(e.responseBody)
            // try to extract common error message fields
            const errMsg = body.message || body.error || body.error?.message
            if (errMsg && typeof errMsg === "string") {
              return `${msg}: ${errMsg}`
            }
          } catch {}

          return `${msg}: ${e.responseBody}`
        }).trim()

        const metadata = e.url ? { url: e.url } : undefined
        return new MessageV2.APIError(
          {
            message,
            statusCode: e.statusCode,
            isRetryable: ctx.providerID.startsWith("openai") ? isOpenAiErrorRetryable(e) : e.isRetryable,
            responseHeaders: e.responseHeaders,
            responseBody: e.responseBody,
            metadata,
          },
          { cause: e },
        ).toObject()
      }
      case e instanceof Error:
        return new NamedError.Unknown({ message: e.toString() }, { cause: e }).toObject()
      default:
        return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e })
    }
  }
}
