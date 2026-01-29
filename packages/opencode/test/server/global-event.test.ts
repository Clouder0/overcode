import { describe, expect, test } from "bun:test"
import path from "path"

import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

async function firstSseData(response: Response, abort: AbortController) {
  const body = response.body
  if (!body) throw new Error("Expected streaming response body")

  const decoder = new TextDecoder()
  const reader = body.getReader()

  const find = (text: string) => {
    const i = text.indexOf("data: ")
    if (i === -1) return
    const start = i + "data: ".length
    const end = text.indexOf("\n", start)
    if (end === -1) return
    return text.slice(start, end).trim()
  }

  const state = { text: "" }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      state.text += decoder.decode(chunk.value, { stream: true })
      const data = find(state.text)
      if (!data) continue
      abort.abort()
      return JSON.parse(data) as unknown
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  throw new Error(`Failed to read SSE data (got: ${state.text.slice(0, 200)})`)
}

describe("global.event", () => {
  test("includes directory on initial event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const abort = new AbortController()
        const response = await app.request("/global/event", { signal: abort.signal })
        expect(response.status).toBe(200)
        const event = await firstSseData(response, abort)
        expect(event).toBeTruthy()

        const record = event as { directory?: unknown; payload?: unknown }
        expect(typeof record.directory).toBe("string")
        expect(record.directory).toBe("global")

        const payload = record.payload as { type?: unknown }
        expect(payload.type).toBe("server.connected")
      },
    })
  })
})
