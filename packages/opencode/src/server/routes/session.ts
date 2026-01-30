import { Hono } from "hono"
import { stream } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Identifier } from "../../id/id"
import { Session } from "../../session"
import { MessageV2 } from "../../session/message-v2"
import { SessionPrompt } from "../../session/prompt"
import { SessionCPD } from "../../session/cpd"
import { SessionRevert } from "../../session/revert"
import { isAssistantAnswered, isTextRelevant, isUserRelevant } from "../../session/relevance"
import { SessionCompaction } from "../../session/compaction"
import { SystemPrompt } from "../../session/system"
import { SessionStatus } from "@/session/status"
import { SessionMessage } from "../../session/message-routing"
import { SessionSummary } from "@/session/summary"
import { Todo } from "../../session/todo"
import { Agent } from "../../agent/agent"
import { Snapshot } from "@/snapshot"
import { Log } from "../../util/log"
import { PermissionNext } from "@/permission/next"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import type { ModelMessage } from "ai"
import { Provider } from "@/provider/provider"
import { Token } from "@/util/token"
import { iife } from "@/util/iife"

const log = Log.create({ service: "server" })

const MANUAL_SUMMARIZE_TIMEOUT = 15 * 60 * 1000

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

type Marker = {
  kind: string
  at: number
  count?: number
  tokens?: number
}

function markerFromPart(part: MessageV2.Part): Marker | undefined {
  if (part.type !== "text") return
  if (part.ignored !== true) return
  if (!part.metadata || typeof part.metadata !== "object") return
  const base = part.metadata as Record<string, unknown>
  const opencode = base.opencode
  if (!opencode || typeof opencode !== "object") return
  const marker = (opencode as Record<string, unknown>).marker
  if (!marker || typeof marker !== "object") return

  const record = marker as Record<string, unknown>
  const kind = record.kind
  const at = record.at

  if (typeof kind !== "string") return
  if (typeof at !== "number") return

  const count = typeof record.count === "number" ? record.count : undefined
  const tokens = typeof record.tokens === "number" ? record.tokens : undefined

  return { kind, at, count, tokens }
}

function opencodeMeta(input: unknown) {
  if (!input || typeof input !== "object") return
  const base = input as Record<string, unknown>
  const value = base.opencode
  if (!value || typeof value !== "object") return
  return value as Record<string, unknown>
}

function omittedReason(part: MessageV2.ReasoningPart) {
  if (part.ignored !== true) return
  const meta = opencodeMeta(part.metadata)
  if (!meta) return
  const value = meta.reason
  if (typeof value !== "string") return
  return value
}

function omittedAt(part: MessageV2.ReasoningPart) {
  const meta = opencodeMeta(part.metadata)
  const at = meta?.at
  if (typeof at === "number") return at
  return part.time.start
}

function latestMarker(messages: MessageV2.WithParts[], kind: string): Marker | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j]
      const marker = markerFromPart(part)
      if (!marker) continue
      if (marker.kind !== kind) continue
      return marker
    }
  }
}

const SessionContext = z
  .object({
    cpd: SessionCPD.Data.extend({
      size: z.number().optional(),
    }).nullable(),
    flags: z.object({
      cpd: z.boolean(),
      trim: z.boolean(),
      think: z.boolean(),
      rctx: z.boolean(),
    }),
    actions: z.object({
      trim: z.object({
        at: z.number().nullable(),
        count: z.number(),
        tokens: z.number(),
      }),
      think: z.object({
        at: z.number().nullable(),
        count: z.number(),
        tokens: z.number(),
      }),
      rctx: z.object({
        at: z.number().nullable(),
      }),
    }),
    estimate: z.object({
      target: z.string().nullable(),
      total: z.number(),
      system: z.number(),
      messages: z.number(),
      budget: z.number().nullable(),
      context: z.number().nullable(),
    }),
  })
  .meta({
    ref: "SessionContext",
  })

export const SessionRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List sessions",
        description: "Get a list of all OpenCode sessions, sorted by most recently updated.",
        operationId: "session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Filter sessions by project directory" }),
          roots: z.coerce.boolean().optional().meta({ description: "Only return root sessions (no parentID)" }),
          start: z.coerce
            .number()
            .optional()
            .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const term = query.search?.toLowerCase()
        const sessions: Session.Info[] = []
        for await (const session of Session.list()) {
          if (query.directory !== undefined && session.directory !== query.directory) continue
          if (query.roots && session.parentID) continue
          if (query.start !== undefined && session.time.updated < query.start) continue
          if (term !== undefined && !session.title.toLowerCase().includes(term)) continue
          sessions.push(session)
          if (query.limit !== undefined && sessions.length >= query.limit) break
        }
        return c.json(sessions)
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get session status",
        description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
        operationId: "session.status",
        responses: {
          200: {
            description: "Get session status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), SessionStatus.Info)),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const result = SessionStatus.list()
        return c.json(result)
      },
    )
    .get(
      "/:sessionID",
      describeRoute({
        summary: "Get session",
        description: "Retrieve detailed information about a specific OpenCode session.",
        tags: ["Session"],
        operationId: "session.get",
        responses: {
          200: {
            description: "Get session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.get.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/context",
      describeRoute({
        summary: "Get session context",
        description: "Retrieve the Compacted Prefix Digest (CPD) and context integrity flags for a session.",
        operationId: "session.context",
        responses: {
          200: {
            description: "Session context",
            content: {
              "application/json": {
                schema: resolver(SessionContext),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.get.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const session = await Session.get(sessionID)
        const cpd = await SessionCPD.get(sessionID)

        const history = await Session.messages({ sessionID })
        const trim = latestMarker(history, "trim")
        const think = latestMarker(history, "think")
        const rctx = latestMarker(history, "rctx")

        const actions = {
          trim: iife(() => {
            if (trim) {
              return {
                at: trim.at,
                count: trim.count ?? 0,
                tokens: trim.tokens ?? 0,
              }
            }

            const tools = history
              .flatMap((m) => m.parts)
              .filter((p): p is MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted } => {
                if (p.type !== "tool") return false
                if (p.state.status !== "completed") return false
                return typeof p.state.time.compacted === "number"
              })

            const at = tools.reduce((max, part) => {
              const value = part.state.time.compacted
              if (typeof value !== "number") return max
              return Math.max(max, value)
            }, 0)

            if (at === 0) {
              return {
                at: null,
                count: 0,
                tokens: 0,
              }
            }

            const latest = tools.filter((p) => p.state.time.compacted === at)
            const tokens = latest.reduce((sum, part) => sum + Token.estimate(part.state.output), 0)
            return {
              at,
              count: latest.length,
              tokens,
            }
          }),
          think: iife(() => {
            if (think) {
              return {
                at: think.at,
                count: think.count ?? 0,
                tokens: think.tokens ?? 0,
              }
            }

            const parts = history
              .flatMap((m) => m.parts)
              .filter((p): p is MessageV2.ReasoningPart => p.type === "reasoning")
              .filter((p) => omittedReason(p) === "context_limit")

            if (parts.length === 0) {
              return {
                at: null,
                count: 0,
                tokens: 0,
              }
            }

            const at = parts.reduce((max, part) => Math.max(max, omittedAt(part)), 0)
            const tokens = parts.reduce((sum, part) => sum + Token.estimate(part.text), 0)
            return {
              at,
              count: parts.length,
              tokens,
            }
          }),
          rctx: iife(() => {
            if (rctx) {
              return {
                at: rctx.at,
              }
            }

            const parts = history
              .flatMap((m) => m.parts)
              .filter((p): p is MessageV2.ReasoningPart => p.type === "reasoning")
              .filter((p) => omittedReason(p) === "provider_rejected_reasoning_context")

            if (parts.length === 0) {
              return {
                at: null,
              }
            }

            const at = parts.reduce((max, part) => Math.max(max, omittedAt(part)), 0)
            return {
              at,
            }
          }),
        }

        const users = history.filter(isUserRelevant)
        const byParent = new Map<string, MessageV2.WithParts[]>()
        for (const msg of history) {
          if (msg.info.role !== "assistant") continue
          const info = msg.info as MessageV2.Assistant
          if (!info.parentID) continue
          const existing = byParent.get(info.parentID)
          if (existing) existing.push(msg)
          if (!existing) byParent.set(info.parentID, [msg])
        }

        const targetUser = users.find((m) => {
          const replies = byParent.get(m.info.id) ?? []
          return !replies.some((reply) => {
            if (reply.info.role !== "assistant") return false
            return isAssistantAnswered(reply.info as MessageV2.Assistant)
          })
        })

        const estimate = await iife(async () => {
          if (!targetUser) {
            return {
              target: null,
              total: 0,
              system: 0,
              messages: 0,
              budget: null,
              context: null,
            }
          }

          const user = targetUser.info as MessageV2.User
          const model = await Provider.getModel(user.model.providerID, user.model.modelID)
          const agentName = session.agentName ?? user.agent
          const agent = await Agent.get(agentName)

          const baseIndex = (() => {
            const upto = cpd?.upto
            if (!upto) return 0
            const idx = users.findIndex((m) => m.info.id > upto)
            if (idx >= 0) return idx
            return users.length
          })()

          const targetIndex = users.findIndex((m) => m.info.id === targetUser.info.id)
          const startIndex = baseIndex > targetIndex ? targetIndex : baseIndex
          const slice = users.slice(startIndex, targetIndex + 1)
          const thread = slice.flatMap((m) => [m, ...(byParent.get(m.info.id) ?? [])])

          const inputSystem = [
            ...(await SessionPrompt.getCachedEnvironment(sessionID)),
            ...(await SystemPrompt.custom()),
            ...SystemPrompt.messageProtocol(session.sessionType, sessionID, session.parentID, session.subagentPrompt),
            ...(cpd ? [cpdBlock(cpd.text)] : []),
            integrity(session),
          ]

          const system = SystemPrompt.header(model.providerID)
          system.push(
            [
              ...(agent.prompt ? [agent.prompt] : SystemPrompt.provider(model)),
              ...inputSystem,
              ...(user.system ? [user.system] : []),
            ]
              .filter((x) => x)
              .join("\n"),
          )

          const mm = MessageV2.toModelMessage(thread)
          const systemTokens = estimateSystem(system)
          const messageTokens = estimateModel(mm)

          const outputReserve = model.limit.output
          const usable = model.limit.input || model.limit.context - outputReserve
          const budget = Math.max(0, Math.floor(usable * 0.9))

          return {
            target: targetUser.info.id,
            total: systemTokens + messageTokens,
            system: systemTokens,
            messages: messageTokens,
            budget,
            context: model.limit.context,
          }
        })

        return c.json({
          cpd: cpd
            ? {
                ...cpd,
                size: session.context?.cpd?.size,
              }
            : null,
          flags: {
            cpd: !!cpd,
            trim: session.context?.trim === true,
            think: session.context?.think === true,
            rctx: session.context?.rctx === true,
          },
          actions,
          estimate,
        })
      },
    )
    .get(
      "/:sessionID/children",
      describeRoute({
        summary: "Get session children",
        tags: ["Session"],
        description: "Retrieve all child sessions that were forked from the specified parent session.",
        operationId: "session.children",
        responses: {
          200: {
            description: "List of children",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.children.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const session = await Session.children(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/todo",
      describeRoute({
        summary: "Get session todos",
        description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
        operationId: "session.todo",
        responses: {
          200: {
            description: "Todo list",
            content: {
              "application/json": {
                schema: resolver(Todo.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const todos = await Todo.get(sessionID)
        return c.json(todos)
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create session",
        description: "Create a new OpenCode session for interacting with AI assistants and managing conversations.",
        operationId: "session.create",
        responses: {
          ...errors(400),
          200: {
            description: "Successfully created session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator("json", Session.create.schema.optional()),
      async (c) => {
        const body = c.req.valid("json") ?? {}
        const session = await Session.create(body)
        return c.json(session)
      },
    )
    .delete(
      "/:sessionID",
      describeRoute({
        summary: "Delete session",
        description: "Delete a session and permanently remove all associated data, including messages and history.",
        operationId: "session.delete",
        responses: {
          200: {
            description: "Successfully deleted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.remove.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.remove(sessionID)
        return c.json(true)
      },
    )
    .patch(
      "/:sessionID",
      describeRoute({
        summary: "Update session",
        description: "Update properties of an existing session, such as title or other metadata.",
        operationId: "session.update",
        responses: {
          200: {
            description: "Successfully updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      validator(
        "json",
        z.object({
          title: z.string().optional(),
          time: z
            .object({
              archived: z.number().optional(),
            })
            .optional(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const updates = c.req.valid("json")

        const updatedSession = await Session.update(sessionID, (session) => {
          if (updates.title !== undefined) {
            session.title = updates.title
          }
          if (updates.time?.archived !== undefined) session.time.archived = updates.time.archived
        })

        return c.json(updatedSession)
      },
    )
    .post(
      "/:sessionID/init",
      describeRoute({
        summary: "Initialize session",
        description:
          "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
        operationId: "session.init",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", Session.initialize.schema.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        await Session.initialize({ ...body, sessionID })
        return c.json(true)
      },
    )
    .post(
      "/:sessionID/fork",
      describeRoute({
        summary: "Fork session",
        description: "Create a new session by forking an existing session at a specific message point.",
        operationId: "session.fork",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.fork.schema.shape.sessionID,
        }),
      ),
      validator("json", Session.fork.schema.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const result = await Session.fork({ ...body, sessionID })
        return c.json(result)
      },
    )
    .post(
      "/:sessionID/abort",
      describeRoute({
        summary: "Abort session",
        description: "Abort an active session and stop any ongoing AI processing or command execution.",
        operationId: "session.abort",
        responses: {
          200: {
            description: "Aborted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      validator(
        "query",
        z.object({
          // Only allow explicit boolean-like strings.
          // NOTE: z.coerce.boolean() treats any non-empty string as true.
          force: z
            .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
            .optional()
            .transform((v) => v === "true" || v === "1"),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const force = c.req.valid("query").force

        if (force) {
          // Force-clear manual summarize state (used for wedged compactions).
          SessionCompaction.abortManual(sessionID)
          SessionCompaction.forceEndManual(sessionID)
          await SessionCompaction.clearAnyMarker(sessionID)
          await Session.update(sessionID, (draft) => {
            draft.time.compacting = undefined
          }).catch(() => {})
          SessionPrompt.cancel(sessionID)
          return c.json(true)
        }

        const status = SessionStatus.get(sessionID)
        if (status.type === "waiting") {
          SessionPrompt.cancel(sessionID)
          SessionCompaction.abortManual(sessionID)
          // Manual summarize is still in-flight (even if aborted); keep the session busy
          // until the summarize endpoint unwinds and clears its own busy state.
          if (SessionCompaction.manual(sessionID)) SessionStatus.set(sessionID, { type: "busy" })
          return c.json(true)
        }

        if (status.type === "retry") {
          SessionPrompt.cancel(sessionID)
          SessionCompaction.abortManual(sessionID)
          if (SessionCompaction.manual(sessionID)) SessionStatus.set(sessionID, { type: "busy" })
          return c.json(true)
        }

        // Avoid clearing SessionStatus to idle when there is no prompt loop state.
        // This prevents reopening the session while manual compaction is still in-flight.
        SessionCompaction.abortManual(sessionID)
        SessionPrompt.cancel(sessionID, { force: false })
        if (SessionCompaction.manual(sessionID)) SessionStatus.set(sessionID, { type: "busy" })
        return c.json(true)
      },
    )
    .post(
      "/:sessionID/share",
      describeRoute({
        summary: "Share session",
        description: "Create a shareable link for a session, allowing others to view the conversation.",
        operationId: "session.share",
        responses: {
          200: {
            description: "Successfully shared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.share(sessionID)
        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/diff",
      describeRoute({
        summary: "Get message diff",
        description: "Get the file changes (diff) that resulted from a specific user message in the session.",
        operationId: "session.diff",
        responses: {
          200: {
            description: "Successfully retrieved diff",
            content: {
              "application/json": {
                schema: resolver(Snapshot.FileDiff.array()),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionSummary.diff.schema.shape.sessionID,
        }),
      ),
      validator(
        "query",
        z.object({
          messageID: SessionSummary.diff.schema.shape.messageID,
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const params = c.req.valid("param")
        const result = await SessionSummary.diff({
          sessionID: params.sessionID,
          messageID: query.messageID,
        })
        return c.json(result)
      },
    )
    .delete(
      "/:sessionID/share",
      describeRoute({
        summary: "Unshare session",
        description: "Remove the shareable link for a session, making it private again.",
        operationId: "session.unshare",
        responses: {
          200: {
            description: "Successfully unshared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.unshare.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.unshare(sessionID)
        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/summarize",
      describeRoute({
        summary: "Summarize session",
        description: "Generate a concise summary of the session using AI compaction to preserve key information.",
        operationId: "session.summarize",
        responses: {
          200: {
            description: "Summarized session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          providerID: z.string(),
          modelID: z.string(),
          auto: z.boolean().optional().default(false),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")

        // Manual compaction mutates session-wide state; do not run concurrently with the prompt loop.
        SessionPrompt.assertNotBusy(sessionID)

        const started = Date.now()
        const entry = SessionCompaction.beginManual({
          sessionID,
          // Will be replaced once we know the actual user message we are compacting towards.
          requestID: "pending",
          startedAt: started,
        })
        if (!entry) {
          // Avoid overlapping manual compactions.
          return c.json({ error: "Session is already compacting" }, 409)
        }

        const request = { id: entry.requestID }
        const abort = AbortSignal.any([entry.abort.signal, AbortSignal.timeout(MANUAL_SUMMARIZE_TIMEOUT)])

        try {
          // Ensure the compaction can be interrupted via POST /session/:id/abort.
          // Also propagate HTTP abort (client disconnect) to the compaction abort.
          c.req.raw.signal.addEventListener("abort", () => entry.abort.abort(), { once: true })

          // Make manual compaction visible to the TUI (spinner/interrupt).
          SessionStatus.set(sessionID, { type: "busy" })

          // Manual summarize runs outside the prompt loop; surface it on the session itself.
          await Session.update(sessionID, (draft) => {
            draft.time.compacting = started
          })

          const base = await Session.get(sessionID)
          await SessionRevert.cleanup(base)
          const session = await Session.get(sessionID)
          const msgs = await Session.messages({ sessionID })

          const hadRctx = session.context?.rctx === true

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
          const target = users.find((msg) => {
            const user = msg.info as MessageV2.User
            const replies = byParent.get(user.id) ?? []
            return !replies.some((m) => {
              if (m.info.role !== "assistant") return false
              return isAssistantAnswered(m.info as MessageV2.Assistant)
            })
          })

          const uptoUser = (() => {
            if (target) {
              const idx = users.findIndex((m) => m.info.id === target.info.id)
              if (idx <= 0) return
              return users[idx - 1]?.info.id
            }
            return users.at(-1)?.info.id
          })()

          if (!uptoUser) {
            return c.json(true)
          }

          const requestID = target ? (target.info as MessageV2.User).id : uptoUser
          request.id = requestID
          entry.requestID = requestID

           if (SessionCompaction.manual(sessionID)?.requestID !== requestID) {
             entry.abort.abort()
             return c.json(true)
           }

           await SessionCompaction.mark({ sessionID, requestID, startedAt: started }).catch(() => {})

          const existing = await SessionCPD.get(sessionID)
          const startIndex = (() => {
            if (!existing?.upto) return 0
            const idx = users.findIndex((m) => m.info.id > existing.upto)
            if (idx === -1) return users.length
            return idx
          })()
          const uptoIndex = users.findIndex((m) => m.info.id === uptoUser)
          if (uptoIndex === -1 || startIndex > uptoIndex) {
            return c.json(true)
          }

          const deltaUsers = users.slice(startIndex, uptoIndex + 1)
          const deltaMsgs = deltaUsers.flatMap((m) => [m, ...(byParent.get(m.info.id) ?? [])])

          const delta = deltaMsgs
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
                  if (p.state.status !== "completed") return []

                  const raw = p.state.output
                  const excerpt = MessageV2.excerpt(raw, 4000)
                  const truncated = excerpt !== raw
                  const note = truncated ? `[Output truncated for CPD delta (${raw.length} chars total)]` : ""
                  const trimmed = p.state.time.compacted ? "[Tool output trimmed in continuation prompt]" : ""
                  const body = [excerpt, note, trimmed].filter((x) => x).join("\n")
                  return [
                    [
                      `Tool ${p.tool}:`,
                      `Input: ${JSON.stringify(p.state.input)}`,
                      `Output:\n${body}`,
                    ].join("\n"),
                  ]
                })
              const blocks = [texts.join("\n"), files.join("\n"), msgs.join("\n\n"), tools.join("\n\n")].filter(
                (x) => x,
              )
              if (blocks.length === 0) return ""
              return [`[${role}]`, ...blocks].join("\n")
            })
            .filter((x) => x)
            .join("\n\n")

          const userText = (msg: MessageV2.WithParts) =>
            msg.parts
              .filter((p): p is MessageV2.TextPart => p.type === "text")
              .filter(isTextRelevant)
              .map((p) => p.text.trim())
              .filter((t) => t)
              .join("\n")
              .trim()

          const requestText = target ? userText(target) : users.at(-1) ? userText(users.at(-1)!) : ""

          const reasoning = (() => {
            const assistant = msgs.findLast(
              (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "reasoning"),
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
            }
          })()

           const updated = await SessionCPD.update({
             sessionID,
             model: {
               providerID: body.providerID,
               modelID: body.modelID,
             },
            user: {
              sessionID,
              id: requestID,
              model: {
                providerID: body.providerID,
                modelID: body.modelID,
              },
              agent: target ? (target.info as MessageV2.User).agent : await Agent.defaultAgent(),
            },
            tail: {
              request: requestText,
              flags: {
                trim: session.context?.trim === true,
                think: session.context?.think === true,
                rctx: session.context?.rctx === true,
              },
            },
             reasoning,
             existing: existing?.text,
             delta,
             abort,
           }).catch((error) => {
             const name = typeof error === "object" && error ? (error as any).name : undefined
             if (name === "AbortError") return
             throw error
           })

           if (!updated) {
             return c.json(true)
           }

           if (SessionCompaction.manual(sessionID)?.requestID !== requestID) {
             entry.abort.abort()
             return c.json(true)
           }

           // Some providers may ignore abort and return normally. Once aborted,
           // manual summarize must not write CPD/flags.
           if (abort.aborted) {
             return c.json(true)
           }

          await SessionCPD.set(sessionID, {
            text: updated.text,
            upto: uptoUser,
          })
          if (updated.rctx) {
            await SessionCPD.flag(sessionID, { rctx: true })

            if (!hadRctx) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: requestID,
                sessionID,
                type: "text",
                synthetic: true,
                ignored: true,
                text: "Provider rejected prior reasoning context (rctx)",
                time: {
                  start: started,
                  end: started,
                },
                metadata: {
                  opencode: {
                    marker: {
                      kind: "rctx",
                      at: started,
                    },
                  },
                },
              })
            }
          }
        } finally {
          await Session.update(sessionID, (draft) => {
            if (draft.time.compacting === started) draft.time.compacting = undefined
          }).catch(() => {})

          await SessionCompaction.unmark(sessionID, request.id).catch(() => {})
          SessionCompaction.endManual({ sessionID, requestID: request.id })

          // Clear busy after manual state is gone so /abort can't re-assert busy
          // while the summarize handler is unwinding.
          SessionStatus.set(sessionID, { type: "idle" })

          // If any delivered messages arrived mid-compaction, wake once we're safe.
          if (SessionMessage.hasPending(sessionID)) {
            SessionPrompt.loop(sessionID).catch((error) => {
              log.error("failed to wake session after summarize", { sessionID, error: error?.message })
            })
          }
        }
        return c.json(true)
      },
    )
    .get(
      "/:sessionID/message",
      describeRoute({
        summary: "Get session messages",
        description: "Retrieve all messages in a session, including user prompts and AI responses.",
        operationId: "session.messages",
        responses: {
          200: {
            description: "List of messages",
            content: {
              "application/json": {
                schema: resolver(MessageV2.WithParts.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator(
        "query",
        z.object({
          limit: z.coerce.number().optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const messages = await Session.messages({
          sessionID: c.req.valid("param").sessionID,
          limit: query.limit,
        })
        return c.json(messages)
      },
    )
    .get(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Get message",
        description: "Retrieve a specific message from a session by its message ID.",
        operationId: "session.message",
        responses: {
          200: {
            description: "Message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Info,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
          messageID: z.string().meta({ description: "Message ID" }),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const message = await MessageV2.get({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        return c.json(message)
      },
    )
    .delete(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Delete a part from a message",
        operationId: "part.delete",
        responses: {
          200: {
            description: "Successfully deleted part",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
          messageID: z.string().meta({ description: "Message ID" }),
          partID: z.string().meta({ description: "Part ID" }),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await Session.removePart({
          sessionID: params.sessionID,
          messageID: params.messageID,
          partID: params.partID,
        })
        return c.json(true)
      },
    )
    .patch(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Update a part in a message",
        operationId: "part.update",
        responses: {
          200: {
            description: "Successfully updated part",
            content: {
              "application/json": {
                schema: resolver(MessageV2.Part),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
          messageID: z.string().meta({ description: "Message ID" }),
          partID: z.string().meta({ description: "Part ID" }),
        }),
      ),
      validator("json", MessageV2.Part),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        if (body.id !== params.partID || body.messageID !== params.messageID || body.sessionID !== params.sessionID) {
          throw new Error(
            `Part mismatch: body.id='${body.id}' vs partID='${params.partID}', body.messageID='${body.messageID}' vs messageID='${params.messageID}', body.sessionID='${body.sessionID}' vs sessionID='${params.sessionID}'`,
          )
        }
        const part = await Session.updatePart(body)
        return c.json(part)
      },
    )
    .post(
      "/:sessionID/message",
      describeRoute({
        summary: "Send message",
        description: "Create and send a new message to a session, streaming the AI response.",
        operationId: "session.prompt",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID

        // Reject prompt submissions during manual summarize so we don't
        // persist orphan prompts that can't be processed.
        if (SessionCompaction.manual(sessionID)) {
          throw new Session.BusyError({ sessionID })
        }

        c.status(200)
        c.header("Content-Type", "application/json")
        const body = c.req.valid("json")
        return stream(c, async (stream) => {
          const msg = await SessionPrompt.prompt({ ...body, sessionID })
          stream.write(JSON.stringify(msg))
        })
      },
    )
    .post(
      "/:sessionID/prompt_async",
      describeRoute({
        summary: "Send async message",
        description:
          "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
        operationId: "session.prompt_async",
        responses: {
          204: {
            description: "Prompt accepted",
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID

        if (SessionCompaction.manual(sessionID)) {
          throw new Session.BusyError({ sessionID })
        }

        c.status(204)
        c.header("Content-Type", "application/json")
        return stream(c, async () => {
          const body = c.req.valid("json")
          SessionPrompt.prompt({ ...body, sessionID }).catch((error) => {
            log.error("prompt_async failed", { sessionID, error: error?.message })
          })
        })
      },
    )
    .post(
      "/:sessionID/command",
      describeRoute({
        summary: "Send command",
        description: "Send a new command to a session for execution by the AI assistant.",
        operationId: "session.command",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", SessionPrompt.CommandInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const msg = await SessionPrompt.command({ ...body, sessionID })
        return c.json(msg)
      },
    )
    .post(
      "/:sessionID/shell",
      describeRoute({
        summary: "Run shell command",
        description: "Execute a shell command within the session context and return the AI's response.",
        operationId: "session.shell",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(MessageV2.Assistant),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", SessionPrompt.ShellInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const msg = await SessionPrompt.shell({ ...body, sessionID })
        return c.json(msg)
      },
    )
    .post(
      "/:sessionID/revert",
      describeRoute({
        summary: "Revert message",
        description: "Revert a specific message in a session, undoing its effects and restoring the previous state.",
        operationId: "session.revert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      validator("json", SessionRevert.RevertInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        log.info("revert", c.req.valid("json"))
        const session = await SessionRevert.revert({
          sessionID,
          ...c.req.valid("json"),
        })
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/unrevert",
      describeRoute({
        summary: "Restore reverted messages",
        description: "Restore all previously reverted messages in a session.",
        operationId: "session.unrevert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const session = await SessionRevert.unrevert({ sessionID })
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/permissions/:permissionID",
      describeRoute({
        summary: "Respond to permission",
        deprecated: true,
        description: "Approve or deny a permission request from the AI assistant.",
        operationId: "permission.respond",
        responses: {
          200: {
            description: "Permission processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
          permissionID: z.string(),
        }),
      ),
      validator("json", z.object({ response: PermissionNext.Reply })),
      async (c) => {
        const params = c.req.valid("param")
        PermissionNext.reply({
          requestID: params.permissionID,
          reply: c.req.valid("json").response,
        })
        return c.json(true)
      },
    ),
)
