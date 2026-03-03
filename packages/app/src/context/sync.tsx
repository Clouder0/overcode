import { batch, createMemo } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@opencode-ai/util/binary"
import { retry } from "@opencode-ai/util/retry"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { sortMessages } from "./message-sort"
import { mergeMessages, mergeParts, seal } from "./message-merge"

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const globalSync = useGlobalSync()
    const sdk = useSDK()

    type Child = ReturnType<(typeof globalSync)["child"]>
    type Setter = Child[1]

    const current = createMemo(() => globalSync.child(sdk.directory))
    const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
    const chunk = 400
    const inflight = new Map<string, Promise<void>>()
    const inflightDiff = new Map<string, Promise<void>>()
    const inflightTodo = new Map<string, Promise<void>>()
    const [meta, setMeta] = createStore({
      limit: {} as Record<string, number>,
      complete: {} as Record<string, boolean>,
      loading: {} as Record<string, boolean>,
    })

    const getSession = (sessionID: string) => {
      const store = current()[0]
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      if (match.found) return store.session[match.index]
      return undefined
    }

    const limitFor = (count: number) => {
      if (count <= chunk) return chunk
      return Math.ceil(count / chunk) * chunk
    }

    const loadMessages = async (input: {
      directory: string
      client: typeof sdk.client
      store: Child[0]
      setStore: Setter
      sessionID: string
      limit: number
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      if (meta.loading[key]) return

      setMeta("loading", key, true)
      await retry(() => input.client.session.messages({ sessionID: input.sessionID, limit: input.limit }))
        .then((messages) => {
          const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
          const tombstone = input.store.tombstone.message[input.sessionID] ?? {}
          const live = items.filter((x) => !tombstone[x.info.id])

          const snapshot = live
            .map((x) => x.info)
            .filter((m) => !!m?.id)
            .sort(sortMessages)

          const next = mergeMessages({
            current: input.store.message[input.sessionID] ?? [],
            snapshot,
            limit: input.limit,
            tombstone,
          })

          const removed = (() => {
            const prev = new Set((input.store.message[input.sessionID] ?? []).map((m) => m.id))
            for (const msg of next) {
              prev.delete(msg.id)
            }
            return prev
          })()

          batch(() => {
            input.setStore("message", input.sessionID, reconcile(next, { key: "id" }))

            for (const message of live) {
              const current = input.store.part[message.info.id] ?? []
              const tombstone = input.store.tombstone.part[message.info.id] ?? {}
              const sealed = seal(message.info)
              const snapshot = (message.parts ?? [])
                .filter((p) => !!p?.id)
                .filter((p) => !tombstone[p.id])
                .sort((a, b) => a.id.localeCompare(b.id))

              input.setStore(
                "part",
                message.info.id,
                reconcile(mergeParts({ current, snapshot, tombstone, sealed }), { key: "id" }),
              )
            }

            if (removed.size > 0) {
              input.setStore(
                produce((draft) => {
                  for (const id of removed) {
                    delete draft.part[id]
                  }
                }),
              )
            }

            setMeta("limit", key, input.limit)
            setMeta("complete", key, items.length < input.limit)
          })
        })
        .finally(() => {
          setMeta("loading", key, false)
        })
    }

    return {
      get data() {
        return current()[0]
      },
      get set(): Setter {
        return current()[1]
      },
      get status() {
        return current()[0].status
      },
      get ready() {
        return current()[0].status !== "loading"
      },
      get project() {
        const store = current()[0]
        const match = Binary.search(globalSync.data.project, store.project, (p) => p.id)
        if (match.found) return globalSync.data.project[match.index]
        return undefined
      },
      session: {
        get: getSession,
        addOptimisticMessage(input: {
          sessionID: string
          messageID: string
          parts: Part[]
          agent: string
          model: { providerID: string; modelID: string }
        }) {
          const message: Message = {
            id: input.messageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.agent,
            model: input.model,
          }
          current()[1](
            produce((draft) => {
              const messages = draft.message[input.sessionID]
              if (!messages) {
                draft.message[input.sessionID] = [message]
              } else {
                const idx = messages.findIndex((m) => m.id === input.messageID)
                if (idx !== -1) messages[idx] = message
                if (idx === -1) messages.push(message)
                messages.sort(sortMessages)
              }
              draft.part[input.messageID] = input.parts.filter((p) => !!p?.id).sort((a, b) => a.id.localeCompare(b.id))
            }),
          )
        },
        async sync(sessionID: string) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          const key = keyFor(directory, sessionID)
          const hasSession = (() => {
            const match = Binary.search(store.session, sessionID, (s) => s.id)
            return match.found
          })()

          const hasMessages = store.message[sessionID] !== undefined
          const hydrated = meta.limit[key] !== undefined
          if (hasSession && hasMessages && hydrated) return
          const pending = inflight.get(key)
          if (pending) return pending

          const count = store.message[sessionID]?.length ?? 0
          const limit = hydrated ? (meta.limit[key] ?? chunk) : limitFor(count)

          const sessionReq = hasSession
            ? Promise.resolve()
            : retry(() => client.session.get({ sessionID })).then((session) => {
                const data = session.data
                if (!data) return
                setStore(
                  "session",
                  produce((draft) => {
                    const match = Binary.search(draft, sessionID, (s) => s.id)
                    if (match.found) {
                      draft[match.index] = data
                      return
                    }
                    draft.splice(match.index, 0, data)
                  }),
                )
              })

          const messagesReq =
            hasMessages && hydrated
              ? Promise.resolve()
              : loadMessages({
                  directory,
                  client,
                  store,
                  setStore,
                  sessionID,
                  limit,
                })

          const promise = Promise.all([sessionReq, messagesReq])
            .then(() => {})
            .finally(() => {
              inflight.delete(key)
            })

          inflight.set(key, promise)
          return promise
        },
        async diff(sessionID: string) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          if (store.session_diff[sessionID] !== undefined) return

          const key = keyFor(directory, sessionID)
          const pending = inflightDiff.get(key)
          if (pending) return pending

          const promise = retry(() => client.session.diff({ sessionID }))
            .then((diff) => {
              setStore("session_diff", sessionID, reconcile(diff.data ?? [], { key: "file" }))
            })
            .finally(() => {
              inflightDiff.delete(key)
            })

          inflightDiff.set(key, promise)
          return promise
        },
        async todo(sessionID: string) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          if (store.todo[sessionID] !== undefined) return

          const key = keyFor(directory, sessionID)
          const pending = inflightTodo.get(key)
          if (pending) return pending

          const promise = retry(() => client.session.todo({ sessionID }))
            .then((todo) => {
              setStore("todo", sessionID, reconcile(todo.data ?? [], { key: "id" }))
            })
            .finally(() => {
              inflightTodo.delete(key)
            })

          inflightTodo.set(key, promise)
          return promise
        },
        history: {
          more(sessionID: string) {
            const store = current()[0]
            const key = keyFor(sdk.directory, sessionID)
            if (store.message[sessionID] === undefined) return false
            if (meta.limit[key] === undefined) return false
            if (meta.complete[key]) return false
            return true
          },
          loading(sessionID: string) {
            const key = keyFor(sdk.directory, sessionID)
            return meta.loading[key] ?? false
          },
          async loadMore(sessionID: string, count = chunk) {
            const directory = sdk.directory
            const client = sdk.client
            const [store, setStore] = globalSync.child(directory)
            const key = keyFor(directory, sessionID)
            if (meta.loading[key]) return
            if (meta.complete[key]) return

            const currentLimit = meta.limit[key] ?? chunk
            await loadMessages({
              directory,
              client,
              store,
              setStore,
              sessionID,
              limit: currentLimit + count,
            })
          },
        },
        fetch: async (count = 10) => {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          setStore("limit", (x) => x + count)
          await client.session.list({ directory }).then((x) => {
            const sessions = (x.data ?? [])
              .filter((s) => !!s?.id)
              .sort((a, b) => a.id.localeCompare(b.id))
              .slice(0, store.limit)
            setStore("session", reconcile(sessions, { key: "id" }))
          })
        },
        more: createMemo(() => current()[0].session.length >= current()[0].limit),
        archive: async (sessionID: string) => {
          const directory = sdk.directory
          const client = sdk.client
          const [, setStore] = globalSync.child(directory)
          await client.session.update({ sessionID, time: { archived: Date.now() } })
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session.splice(match.index, 1)
            }),
          )
        },
      },
      absolute,
      get directory() {
        return current()[0].path.directory
      },
    }
  },
})
