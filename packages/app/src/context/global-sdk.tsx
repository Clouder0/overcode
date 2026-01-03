import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { onCleanup } from "solid-js"
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

    const eventSdk = createOpencodeClient({
      baseUrl: server.url,
      fetch: platform.fetch,
      throwOnError: true,
    })

    const streams = new Map<string, AbortController>()
    const subscribe = (directory: string) => {
      if (!directory) return
      if (streams.has(directory)) return

      const abort = new AbortController()
      streams.set(directory, abort)

      eventSdk.global
        .event({ directory }, { signal: abort.signal })
        .then(async (events) => {
          for await (const event of events.stream) {
            emitter.emit(event.directory ?? "global", event.payload)
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
    })

    const sdk = createOpencodeClient({
      baseUrl: server.url,
      fetch: platform.fetch,
      throwOnError: true,
    })

    return { url: server.url, client: sdk, event: emitter, subscribe }
  },
})
