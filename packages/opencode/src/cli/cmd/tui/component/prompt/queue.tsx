import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { appendFile, writeFile } from "fs/promises"
import { Identifier } from "@/id/id"
import { createSimpleContext } from "../../context/helper"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useToast } from "../../ui/toast"
import { usePromptStash } from "./stash"
import type { PromptInfo } from "./history"
import { promptQueueFilePath } from "./queue-file"
import { createQueueItem, type QueueItem, toPromptAsyncInput } from "./queue-data"

type QueueEvent =
  | {
      type: "snapshot"
      items: QueueItem[]
    }
  | {
      type: "enqueue"
      item: Omit<QueueItem, "prepared">
    }
  | {
      type: "prepare"
      id: string
      prepared: NonNullable<QueueItem["prepared"]>
    }
  | {
      type: "dequeue"
      id: string
    }

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return
  }
}

function responseStatus(result: unknown): number | undefined {
  if (!result || typeof result !== "object") return
  const response = (result as { response?: unknown }).response
  if (!response || typeof response !== "object") return
  const status = (response as { status?: unknown }).status
  if (typeof status === "number") return status
  return
}

export const { use: usePromptQueue, provider: PromptQueueProvider } = createSimpleContext({
  name: "PromptQueue",
  init: () => {
    const toast = useToast()
    const sdk = useSDK()
    const sync = useSync()
    const stash = usePromptStash()

    const file = Bun.file(promptQueueFilePath())
    const [store, setStore] = createStore<{ items: QueueItem[] }>({ items: [] })

    const [flushing, setFlushing] = createSignal(false)
    const blocked = new Map<string, number>()
    const tries = new Map<string, number>()
    const inflight = new Map<string, number>()

    const pending = {
      timer: undefined as Timer | undefined,
      at: 0,
    }

    const schedule = (ms: number) => {
      const at = Date.now() + ms
      if (pending.timer && at >= pending.at) return
      if (pending.timer) clearTimeout(pending.timer)

      pending.at = at
      pending.timer = setTimeout(() => {
        pending.timer = undefined
        pending.at = 0
        flush()
      }, ms)
    }

    const writer = {
      current: Promise.resolve() as Promise<unknown>,
    }

    const write = (fn: () => Promise<unknown>) => {
      writer.current = writer.current.then(fn).catch(() => {})
      return writer.current
    }

    const append = (event: QueueEvent) => {
      if (!file.name) return Promise.resolve()
      const text = JSON.stringify(event) + "\n"
      return write(() => appendFile(file.name!, text))
    }

    const compact = () => {
      if (!file.name) return Promise.resolve()
      const event: QueueEvent = {
        type: "snapshot",
        items: store.items,
      }
      const text = JSON.stringify(event) + "\n"
      return write(() => writeFile(file.name!, text))
    }

    const dequeue = (id: string) => {
      setStore(
        produce((draft) => {
          draft.items = draft.items.filter((x) => x.id !== id)
        }),
      )
      tries.delete(id)
      inflight.delete(id)
      void append({ type: "dequeue", id })
    }

    const prepare = (item: QueueItem) => {
      if (item.prepared) return item
      const messageID = Identifier.ascending("message")
      const partIDs = [Identifier.ascending("part"), ...item.parts.map(() => Identifier.ascending("part"))]
      const prepared = { messageID, partIDs }

      setStore(
        produce((draft) => {
          const match = draft.items.find((x) => x.id === item.id)
          if (!match) return
          match.prepared = prepared
        }),
      )
      void append({ type: "prepare", id: item.id, prepared })

      return {
        ...item,
        prepared,
      }
    }

    const buildParts = (item: QueueItem) => {
      if (!item.prepared) return
      const textID = item.prepared.partIDs[0]
      if (!textID) return
      if (item.prepared.partIDs.length !== item.parts.length + 1) return
      return [
        {
          id: textID,
          type: "text" as const,
          text: item.text,
        },
        ...item.parts.map((part, i) => ({
          id: item.prepared!.partIDs[i + 1]!,
          ...part,
        })),
      ]
    }

    const existing = async (item: QueueItem): Promise<boolean | undefined> => {
      if (!item.prepared) return false
      const res = await sdk.client.session
        .message(
          {
            sessionID: item.sessionID,
            messageID: item.prepared.messageID,
          },
          {
            throwOnError: false,
          },
        )
        .catch((error) => ({ error }) as unknown)

      const status = responseStatus(res)
      if (status === 404) return false
      if (status && status >= 200 && status < 300) return true
      return
    }

    const send = async (item: QueueItem) => {
      const next = prepare(item)
      const parts = buildParts(next)
      if (!parts) return { ok: false as const, status: undefined, item: next }

      const res = await sdk.client.session
        .promptAsync(
          toPromptAsyncInput({
            item: next as QueueItem & { prepared: NonNullable<QueueItem["prepared"]> },
            parts,
          }),
          {
            throwOnError: false,
          },
        )
        .catch((error) => ({ error }) as unknown)

      const status = responseStatus(res)
      if (status && status >= 200 && status < 300) return { ok: true as const, status, item: next }
      return { ok: false as const, status, item: next }
    }

    async function flush() {
      if (flushing()) return
      if (store.items.length === 0) return
      setFlushing(true)

      let changed = false
      try {
        while (true) {
          const items = store.items
          if (items.length === 0) return

          const now = Date.now()
          const seen = new Set<string>()
          const index = items.findIndex((item) => {
            if (seen.has(item.sessionID)) return false
            seen.add(item.sessionID)
            const until = blocked.get(item.sessionID) ?? 0
            if (now < until) return false
            return true
          })

          if (index === -1) {
            const sessions = new Set<string>()
            const next = items
              .map((item) => item.sessionID)
              .filter((sessionID) => {
                if (sessions.has(sessionID)) return false
                sessions.add(sessionID)
                return true
              })
              .map((sessionID) => blocked.get(sessionID) ?? 0)
              .filter((t) => t > now)
              .sort((a, b) => a - b)
              .at(0)

            if (typeof next === "number") {
              schedule(Math.max(50, next - now))
            }
            return
          }

          const item = items[index]!

          // If we already prepared an id, confirm it didn't land before re-sending.
          if (item.prepared) {
            const landed = await existing(item)
            if (landed === true) {
              dequeue(item.id)
              changed = true
              continue
            }
            if (landed === undefined) {
              blocked.set(item.sessionID, Date.now() + 500)
              schedule(500)
              continue
            }

            const sent = inflight.get(item.id)
            if (sent && Date.now() - sent < 5000) {
              blocked.set(item.sessionID, Date.now() + 500)
              schedule(500)
              continue
            }
          }

          const attempt = (tries.get(item.id) ?? 0) + 1
          tries.set(item.id, attempt)

          const result = await send(item)
          if (result.ok) {
            inflight.set(item.id, Date.now())
            // Confirm the message actually landed; prompt_async returns 204 even
            // if the async prompt later fails before persisting.
            const landed = await existing(result.item)
            if (landed === true) {
              dequeue(item.id)
              changed = true
              continue
            }

            const delay = Math.min(250 * attempt, 1500)
            blocked.set(item.sessionID, Date.now() + delay)
            schedule(delay)
            continue
          }

          if (result.status === 409) {
            const delay = Math.min(1000 * attempt, 5000)
            blocked.set(item.sessionID, Date.now() + delay)
            schedule(delay)
            continue
          }

          // Hard failures should not wedge the queue forever.
          if (result.status === 400 || result.status === 404) {
            stash.push({
              input: item.text,
              parts: item.parts,
            })
            dequeue(item.id)
            changed = true
            toast.show({
              variant: "error",
              message: "Failed to send queued message; stashed for later",
              duration: 3500,
            })
            continue
          }

          const delay = Math.min(1000 * attempt, 5000)
          blocked.set(item.sessionID, Date.now() + delay)
          schedule(delay)
          continue
        }
      } finally {
        setFlushing(false)
        if (changed) void compact()
      }
    }

    function enqueue(input: {
      sessionID: string
      agent: string
      model: { providerID: string; modelID: string }
      variant: string | undefined
      serviceTier: "auto" | "flex" | "priority" | undefined
      text: string
      parts: PromptInfo["parts"]
    }) {
      const item = createQueueItem({
        id: `queue_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        created: Date.now(),
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        variant: input.variant,
        serviceTier: input.serviceTier,
        text: input.text,
        parts: input.parts,
      })

      setStore(
        produce((draft) => {
          draft.items.push({
            ...item,
            prepared: undefined,
          })
        }),
      )
      void append({ type: "enqueue", item })
      toast.show({
        variant: "warning",
        message: `Queued (${store.items.length}); will send when compaction finishes`,
        duration: 2500,
      })
    }

    onMount(async () => {
      const text = await file.text().catch(() => "")
      if (!text) return

      const lines = text.split("\n").filter(Boolean)
      let items: QueueItem[] = []

      for (const line of lines) {
        const parsed = parseLine(line)
        if (!parsed || typeof parsed !== "object") continue

        const type = (parsed as { type?: unknown }).type
        if (type === "snapshot") {
          const next = (parsed as { items?: unknown }).items
          if (!Array.isArray(next)) continue
          items = next as QueueItem[]
          continue
        }

        if (type === "enqueue") {
          const item = (parsed as { item?: unknown }).item
          if (!item || typeof item !== "object") continue
          items.push({
            ...(item as Omit<QueueItem, "prepared">),
            prepared: undefined,
          })
          continue
        }

        if (type === "prepare") {
          const id = (parsed as { id?: unknown }).id
          if (typeof id !== "string") continue

          const prepared = (parsed as { prepared?: unknown }).prepared
          if (!prepared || typeof prepared !== "object") continue
          const messageID = (prepared as { messageID?: unknown }).messageID
          const partIDs = (prepared as { partIDs?: unknown }).partIDs
          if (typeof messageID !== "string") continue
          if (!Array.isArray(partIDs)) continue
          if (!partIDs.every((x) => typeof x === "string")) continue

          items = items.map((x) => (x.id === id ? { ...x, prepared: { messageID, partIDs } } : x))
          continue
        }

        if (type === "dequeue") {
          const id = (parsed as { id?: unknown }).id
          if (typeof id !== "string") continue
          items = items.filter((x) => x.id !== id)
          continue
        }
      }

      setStore("items", items)
      // Compact on startup so old queued payloads don't linger on disk.
      void compact()
    })

    createEffect(() => {
      const items = store.items
      if (items.length === 0) return

      // Wake the flusher when any queued session's compaction timestamp changes.
      for (const item of items) {
        ;(sync.session.get(item.sessionID) as any)?.time?.compacting
      }

      flush()
    })

    onCleanup(() => {
      if (pending.timer) clearTimeout(pending.timer)
    })

    return {
      list() {
        return store.items
      },
      enqueue,
    }
  },
})
