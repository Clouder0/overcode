import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup } from "solid-js"
import { usePlatform } from "./platform"
import { useServer } from "./server"

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const platform = usePlatform()
    const server = useServer()

    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    type Queued = { directory: string; payload: Event }

    const eventSdk = createOpencodeClient({
      baseUrl: server.url,
      fetch: platform.fetch,
      throwOnError: true,
    })

    let queue: Array<Queued | undefined> = []
    let buffer: Array<Queued | undefined> = []
    const coalesced = new Map<string, number>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0

    const key = (directory: string, payload: Event) => {
      if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
      if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`
      }
    }

    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined

      if (queue.length === 0) return

      const events = queue
      queue = buffer
      buffer = events
      queue.length = 0
      coalesced.clear()

      last = Date.now()
      batch(() => {
        for (const event of events) {
          if (!event) continue
          emitter.emit(event.directory, event.payload)
        }
      })

      buffer.length = 0
    }

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, 16 - elapsed))
    }

    const abort = new AbortController()
    const errors = { at: 0 }

    const unwrap = (input: unknown): { directory: string; payload: Event } | undefined => {
      if (!input || typeof input !== "object") return
      const record = input as { directory?: unknown; payload?: unknown }
      const payload = record.payload
      if (!payload || typeof payload !== "object") return
      if (!("type" in payload)) return
      if (typeof (payload as { type?: unknown }).type !== "string") return
      const directory = typeof record.directory === "string" ? record.directory : "global"
      return { directory, payload: payload as Event }
    }

    void (async () => {
      while (true) {
        if (abort.signal.aborted) return
        try {
          const events = await eventSdk.global.event({ signal: abort.signal })
          let yielded = Date.now()
          for await (const event of events.stream) {
            if (abort.signal.aborted) return
            const parsed = unwrap(event)
            if (!parsed) continue

            const k = key(parsed.directory, parsed.payload)
            if (k) {
              const i = coalesced.get(k)
              if (i !== undefined) {
                queue[i] = undefined
              }
              coalesced.set(k, queue.length)
            }
            queue.push({ directory: parsed.directory, payload: parsed.payload })
            schedule()

            if (Date.now() - yielded < 8) continue
            yielded = Date.now()
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
          }
        } catch (error) {
          const now = Date.now()
          const shouldLog = import.meta.env.DEV && now - errors.at > 10_000
          if (shouldLog) {
            errors.at = now
            const message = error instanceof Error ? error.message : String(error)
            console.warn("[GlobalSDK] global event stream error; retrying", message)
          }
        }

        if (abort.signal.aborted) return
        flush()
        await new Promise<void>((resolve) => setTimeout(resolve, 250))
      }
    })().catch(() => undefined)

    const subscribe = (_directory: string) => {
      // No-op: we subscribe to the global event stream.
    }

    onCleanup(() => {
      abort.abort()
      flush()
    })

    const sdk = createOpencodeClient({
      baseUrl: server.url,
      fetch: platform.fetch,
      throwOnError: true,
    })

    return { url: server.url, client: sdk, event: emitter, subscribe }
  },
})
