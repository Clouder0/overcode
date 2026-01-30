import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@opencode-ai/util/binary"
import { createSimpleContext } from "./helper"
import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import { Log } from "@/util/log"
import type { Path } from "@opencode-ai/sdk"

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
      path: Path
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
      path: { state: "", config: "", worktree: "", directory: "", home: "" },
    })

    const sdk = useSDK()

    const timeoutSignal = (ms: number, message: string) => {
      const abort = new AbortController()
      const err = new Error(message)
      err.name = "TimeoutError"

      const onAbort = () => abort.abort()
      sdk.signal.addEventListener("abort", onAbort)

      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort()
          reject(err)
        }, ms).unref()
      })

      return {
        signal: abort.signal,
        timeout,
        cleanup: () => {
          if (timer) clearTimeout(timer)
          sdk.signal.removeEventListener("abort", onAbort)
        },
      }
    }

    const pins = (permission: typeof store.permission) => {
      const out = new Set<string>()
      for (const list of Object.values(permission)) {
        for (const req of list) {
          const id = req.tool?.messageID
          if (id) out.add(id)
        }
      }
      return out
    }

    const fullSyncedSessions = new Set<string>()
    const fullSyncInFlight = new Map<string, Promise<void>>()
    const sessionInfoInFlight = new Map<string, Promise<void>>()
    // A session.list response can be stale (race with optimistic session creation).
    // Track deletions so a late list can't resurrect a deleted session.
    const sessionTombstones = new Set<string>()

    sdk.event.listen((e) => {
      const event = e.details
      switch (event.type) {
        case "server.instance.disposed":
          fullSyncedSessions.clear()
          fullSyncInFlight.clear()
          sessionInfoInFlight.clear()
          sessionTombstones.clear()
          bootstrap()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.created": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (!result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 0, event.properties.info)
              }),
            )
          }
          break
        }

        case "session.deleted": {
          sessionTombstones.add(event.properties.info.id)
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          const gone: { id?: string } = {}

          const protectedIDs = pins(store.permission)

          batch(() => {
            setStore(
              "message",
              event.properties.info.sessionID,
              produce((draft) => {
                draft.splice(result.index, 0, event.properties.info)
                if (draft.length <= 100) return
                gone.id = draft.shift()?.id
              }),
            )

            const id = gone.id
            if (!id) return
            if (protectedIDs.has(id)) return

            setStore(
              produce((draft) => {
                delete draft.part[id]
              }),
            )
          })
          break
        }
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          const result = messages ? Binary.search(messages, event.properties.messageID, (m) => m.id) : undefined

          const protectedIDs = pins(store.permission)

          batch(() => {
            if (result?.found) {
              setStore(
                "message",
                event.properties.sessionID,
                produce((draft) => {
                  draft.splice(result.index, 1)
                }),
              )
            }

            if (protectedIDs.has(event.properties.messageID)) return

            setStore(
              produce((draft) => {
                delete draft.part[event.properties.messageID]
              }),
            )
          })
          break
        }
        case "message.part.updated": {
          const part = event.properties.part

          const protectedIDs = pins(store.permission)

          const messages = store.message[part.sessionID] ?? []
          const live = messages.some((m) => m.id === part.messageID) || protectedIDs.has(part.messageID)

          if (!live) break

          const parts = store.part[part.messageID]
          if (!parts) {
            setStore("part", part.messageID, [part])
            break
          }
          const result = Binary.search(parts, part.id, (p) => p.id)
          if (result.found) {
            setStore("part", part.messageID, result.index, reconcile(part))
            break
          }
          setStore(
            "part",
            part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, part)
            }),
          )
          break
        }

        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found)
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          break
        }

        case "lsp.updated": {
          sdk.client.lsp.status().then((x) => setStore("lsp", x.data!))
          break
        }

        case "vcs.branch.updated": {
          setStore("vcs", { branch: event.properties.branch })
          break
        }

        default: {
          // Handle events not in the type union.
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap() {
      const start = Date.now() - 30 * 24 * 60 * 60 * 1000
      const sessionListPromise = sdk.client.session.list({ start: start }).then((x) => {
        const list = (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id))

        // Merge instead of replace: session.create() optimistically inserts the
        // new session into the store; a stale session.list response must not
        // delete it and briefly blank the Session route.
        setStore(
          "session",
          produce((draft) => {
            const map = new Map<string, (typeof store.session)[number]>()
            for (const item of draft) {
              map.set(item.id, item)
            }
            for (const item of list) {
              if (sessionTombstones.has(item.id)) continue
              const existing = map.get(item.id)
              if (existing) {
                // Preserve any fields populated via session.get/session.sync.
                Object.assign(existing, item)
                continue
              }
              map.set(item.id, item)
            }
            for (const id of sessionTombstones) {
              map.delete(id)
            }
            const merged = Array.from(map.values()).toSorted((a, b) => a.id.localeCompare(b.id))
            draft.splice(0, draft.length, ...merged)
          }),
        )
      })

      // blocking - include session.list when continuing a session
      const blockingRequests: Promise<unknown>[] = [
        sdk.client.config.providers({}, { throwOnError: true }).then((x) => {
          batch(() => {
            setStore("provider", reconcile(x.data!.providers))
            setStore("provider_default", reconcile(x.data!.default))
          })
        }),
        sdk.client.provider.list({}, { throwOnError: true }).then((x) => {
          batch(() => {
            setStore("provider_next", reconcile(x.data!))
          })
        }),
        sdk.client.app.agents({}, { throwOnError: true }).then((x) => setStore("agent", reconcile(x.data ?? []))),
        sdk.client.config.get({}, { throwOnError: true }).then((x) => setStore("config", reconcile(x.data!))),
        ...(args.continue ? [sessionListPromise] : []),
      ]

      await Promise.all(blockingRequests)
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          Promise.all([
            ...(args.continue ? [] : [sessionListPromise]),
            sdk.client.command.list().then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status().then((x) => setStore("lsp", reconcile(x.data!))),
            sdk.client.mcp.status().then((x) => setStore("mcp", reconcile(x.data!))),
            sdk.client.experimental.resource.list().then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status().then((x) => setStore("formatter", reconcile(x.data!))),
            sdk.client.session.status().then((x) => {
              setStore("session_status", reconcile(x.data!))
            }),
            sdk.client.provider.auth().then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get().then((x) => setStore("vcs", reconcile(x.data))),
            sdk.client.path.get().then((x) => setStore("path", reconcile(x.data!))),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          Log.Default.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          await exit(e)
        })
    }

    onMount(() => {
      bootstrap()
    })
    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        return store.status !== "loading"
      },
      session: {
        get(sessionID: string) {
          // Use .find() for better SolidJS reactivity tracking
          // Binary.search may not track all accessed indices properly
          return store.session.find((s) => s.id === sessionID)
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          const status = store.session_status?.[sessionID] as { type?: string } | undefined
          const compacting = session.time.compacting
          if (typeof compacting === "number") {
            // If status is explicitly idle, treat any lingering timestamp as stale.
            if (status?.type && status.type !== "idle") return "compacting"
            if (!status?.type && Date.now() - compacting < 10 * 60 * 1000) return "compacting"
          }
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async info(sessionID: string) {
          if (result.session.get(sessionID)) return
          const fullInFlight = fullSyncInFlight.get(sessionID)
          if (fullInFlight) return fullInFlight
          const inFlight = sessionInfoInFlight.get(sessionID)
          if (inFlight) return inFlight

          const t = timeoutSignal(15_000, `Timed out loading session: ${sessionID}`)
          const req = sdk.client.session.get(
            { sessionID },
            {
              throwOnError: true,
              signal: t.signal,
            },
          )
          void req.catch(() => {})

          const promise = Promise.race([req, t.timeout])
            .then((session) => {
              setStore(
                produce((draft) => {
                  const match = Binary.search(draft.session, sessionID, (s) => s.id)
                  if (match.found) draft.session[match.index] = session.data!
                  if (!match.found) draft.session.splice(match.index, 0, session.data!)
                }),
              )
            })
            .finally(() => {
              t.cleanup()
              sessionInfoInFlight.delete(sessionID)
            })

          sessionInfoInFlight.set(sessionID, promise)
          return promise
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const inFlight = fullSyncInFlight.get(sessionID)
          if (inFlight) return inFlight

          const t = timeoutSignal(60_000, `Timed out syncing session: ${sessionID}`)
          const req = Promise.all([
            sdk.client.session.get(
              { sessionID },
              {
                throwOnError: true,
                signal: t.signal,
              },
            ),
            sdk.client.session.messages(
              { sessionID, limit: 100 },
              {
                throwOnError: true,
                signal: t.signal,
              },
            ),
            sdk.client.session.todo(
              { sessionID },
              {
                throwOnError: true,
                signal: t.signal,
              },
            ),
            sdk.client.session.diff(
              { sessionID },
              {
                throwOnError: true,
                signal: t.signal,
              },
            ),
          ])
          void req.catch(() => {})

          const promise = Promise.race([req, t.timeout])
            .then(([session, messages, todo, diff]) => {
              const protectedIDs = pins(store.permission)

              setStore(
                produce((draft) => {
                  const match = Binary.search(draft.session, sessionID, (s) => s.id)
                  if (match.found) draft.session[match.index] = session.data!
                  if (!match.found) draft.session.splice(match.index, 0, session.data!)
                  draft.todo[sessionID] = todo.data ?? []

                  const previous = new Set((draft.message[sessionID] ?? []).map((m) => m.id))
                  const next = new Set(messages.data!.map((x) => x.info.id))

                  draft.message[sessionID] = messages.data!.map((x) => x.info)
                  for (const message of messages.data!) {
                    draft.part[message.info.id] = message.parts
                  }

                  for (const id of previous) {
                    if (next.has(id)) continue
                    if (protectedIDs.has(id)) continue
                    delete draft.part[id]
                  }

                  draft.session_diff[sessionID] = diff.data ?? []
                }),
              )
              fullSyncedSessions.add(sessionID)
            })
            .finally(() => {
              t.cleanup()
              fullSyncInFlight.delete(sessionID)
            })

          fullSyncInFlight.set(sessionID, promise)
          return promise
        },
        // Add a session to the store (used when creating a new session to avoid waiting for SSE event)
        add(session: (typeof store.session)[number]) {
          setStore(
            "session",
            produce((draft) => {
              const result = Binary.search(draft, session.id, (s) => s.id)
              if (!result.found) {
                draft.splice(result.index, 0, session)
              }
            }),
          )
        },
      },
      bootstrap,
    }
    return result
  },
})
