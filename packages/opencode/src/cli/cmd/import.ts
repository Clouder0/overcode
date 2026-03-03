import type { Argv } from "yargs"
import { Session } from "../../session"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Storage } from "../../storage/storage"
import { Instance } from "../../project/instance"
import { EOL } from "os"

export const ImportCommand = cmd({
  command: "import <file>",
  describe: "import session data from JSON file or URL",
  builder: (yargs: Argv) => {
    return yargs.positional("file", {
      describe: "path to JSON file or opencode.ai share URL",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      let exportData:
        | {
            info: Session.Info
            messages: Array<{
              info: any
              parts: any[]
            }>
          }
        | undefined

      const isUrl = args.file.startsWith("http://") || args.file.startsWith("https://")

      if (isUrl) {
        const urlMatch = args.file.match(/https?:\/\/opncd\.ai\/share\/([a-zA-Z0-9_-]+)/)
        if (!urlMatch) {
          process.stdout.write(`Invalid URL format. Expected: https://opncd.ai/share/<slug>`)
          process.stdout.write(EOL)
          return
        }

        const slug = urlMatch[1]
        const response = await fetch(`https://opncd.ai/api/share/${slug}`)

        if (!response.ok) {
          process.stdout.write(`Failed to fetch share data: ${response.statusText}`)
          process.stdout.write(EOL)
          return
        }

        const data = await response.json()

        if (!data.info || !data.messages || Object.keys(data.messages).length === 0) {
          process.stdout.write(`Share not found: ${slug}`)
          process.stdout.write(EOL)
          return
        }

        exportData = {
          info: data.info,
          messages: Object.values(data.messages).map((msg: any) => {
            const { parts, ...info } = msg
            return {
              info,
              parts,
            }
          }),
        }
      } else {
        const file = Bun.file(args.file)
        exportData = await file.json().catch(() => {})
        if (!exportData) {
          process.stdout.write(`File not found: ${args.file}`)
          process.stdout.write(EOL)
          return
        }
      }

      if (!exportData) {
        process.stdout.write(`Failed to read session data`)
        process.stdout.write(EOL)
        return
      }

      await Storage.write(["session", Instance.project.id, exportData.info.id], exportData.info)

      const created = (info: unknown) => {
        if (!info || typeof info !== "object") return 0

        const time = (info as { time?: unknown }).time
        const raw = (() => {
          if (!time || typeof time !== "object") return
          const value = (time as { created?: unknown }).created
          if (typeof value === "number") return value
        })()
        if (raw !== undefined) return raw

        const id = (info as { id?: unknown }).id
        if (typeof id !== "string") return 0
        const index = id.indexOf("_")
        if (index < 0) return 0
        const hex = id.slice(index + 1, index + 13)
        if (!/^[0-9a-fA-F]{12}$/.test(hex)) return 0
        const value = Number(BigInt(`0x${hex}`) / 0x1000n)
        if (!Number.isFinite(value)) return 0
        return value
      }

      const sorted = exportData.messages.slice().sort((a, b) => {
        const at = created(a.info)
        const bt = created(b.info)
        const aCreated = at > 0 ? at : Number.POSITIVE_INFINITY
        const bCreated = bt > 0 ? bt : Number.POSITIVE_INFINITY
        if (aCreated !== bCreated) return aCreated - bCreated

        const ar = a.info?.role === "assistant" ? 1 : 0
        const br = b.info?.role === "assistant" ? 1 : 0
        if (ar !== br) return ar - br

        const aid = a.info?.id
        const bid = b.info?.id
        if (typeof aid !== "string") return -1
        if (typeof bid !== "string") return 1
        if (aid === bid) return 0
        return aid > bid ? 1 : -1
      })

      for (const msg of sorted) {
        await Session.updateMessage({
          ...msg.info,
          sessionID: exportData.info.id,
          order: undefined,
        })

        for (const part of msg.parts) {
          await Session.updatePart({
            ...part,
            sessionID: exportData.info.id,
            messageID: msg.info.id,
          })
        }
      }

      process.stdout.write(`Imported session: ${exportData.info.id}`)
      process.stdout.write(EOL)
    })
  },
})
