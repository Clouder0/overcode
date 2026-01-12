import { Server } from "../../server/server"
import type { CommandModule } from "yargs"

function camel(input: string) {
  const parts = input.split(/[_-]/g)
  const first = parts[0] ?? ""
  const rest = parts
    .slice(1)
    .map((part) => {
      if (!part) return ""
      return part.slice(0, 1).toUpperCase() + part.slice(1)
    })
    .join("")
  return first + rest
}

function sdkPath(operationId: string) {
  return operationId
    .split(".")
    .map((part) => camel(part))
    .join(".")
}

function jsSample(operationId: string) {
  if (operationId === "pty.connect") {
    return [
      'import { createOpencodeClient } from "@opencode-ai/sdk"',
      "",
      "const client = createOpencodeClient()",
      "",
      "// PTY connect uses WebSocket (not fetch).",
      "// Use a WebSocket client against /pty/<ptyID>/connect.",
      "// const ws = new WebSocket('ws://localhost:4096/pty/<ptyID>/connect')",
      "",
      "void client",
    ].join("\n")
  }

  const call = sdkPath(operationId)
  return [
    'import { createOpencodeClient } from "@opencode-ai/sdk"',
    "",
    "const client = createOpencodeClient()",
    `await client.${call}({`,
    "  ...",
    "})",
  ].join("\n")
}

export const GenerateCommand = {
  command: "generate",
  handler: async () => {
    const specs = await Server.openapi()
    for (const item of Object.values(specs.paths)) {
      for (const method of ["get", "post", "put", "delete", "patch"] as const) {
        const operation = item[method]
        if (!operation?.operationId) continue
        // @ts-expect-error
        operation["x-codeSamples"] = [
          {
            lang: "js",
            source: jsSample(operation.operationId),
          },
        ]
      }
    }
    const json = JSON.stringify(specs, null, 2)

    // Wait for stdout to finish writing before process.exit() is called
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(json, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  },
} satisfies CommandModule
