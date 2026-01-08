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

      const events = queue
      queue = []
      coalesced.clear()
      if (events.length === 0) return

      last = Date.now()
      batch(() => {
        for (const event of events) {
          if (!event) continue
          emitter.emit(event.directory, event.payload)
        }
      })
    }

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, 16 - elapsed))
    }

    const stop = () => {
      flush()
    }

    const streams = new Map<string, AbortController>()
    const subscribe = (directory: string) => {
      if (!directory) return
      if (streams.has(directory)) return

      const abort = new AbortController()
      streams.set(directory, abort)

      eventSdk.global
        .event({ directory }, { signal: abort.signal })
        .then(async (events) => {
          let yielded = Date.now()
          for await (const event of events.stream) {
            const dir = event.directory ?? "global"
            const payload = event.payload
            const k = key(dir, payload)
            if (k) {
              const i = coalesced.get(k)
              if (i !== undefined) {
                queue[i] = undefined
              }
              coalesced.set(k, queue.length)
            }
            queue.push({ directory: dir, payload })
            schedule()

            if (Date.now() - yielded < 8) continue
            yielded = Date.now()
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
          }
        })
        .catch(() => {})
        .finally(() => {
          streams.delete(directory)
        })
    }

    onCleanup(() => {
      for (const ctrl of streams.values()) {
        ctrl.abort()
      }
      streams.clear()
      stop()
    })

    const sdk = createOpencodeClient({
      baseUrl: server.url,
      fetch: platform.fetch,
      throwOnError: true,
    })

    return { url: server.url, client: sdk, event: emitter, subscribe }
  },
})
