import type {
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2"
import type {
  Provider,
  Agent,
  Config,
  Command,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
} from "@opencode-ai/sdk/v2"
import type { Snapshot } from "@/snapshot"
import { Binary } from "@opencode-ai/util/binary"

export type SyncStore = {
  status: "loading" | "partial" | "complete"
  provider: Provider[]
  provider_default: Record<string, string>
  provider_next: any
  provider_auth: Record<string, any>
  agent: Agent[]
  command: Command[]
  permission: { [sessionID: string]: PermissionRequest[] }
  question: { [sessionID: string]: QuestionRequest[] }
  config: Config
  session: Session[]
  session_status: { [sessionID: string]: SessionStatus }
  session_diff: { [sessionID: string]: Snapshot.FileDiff[] }
  todo: { [sessionID: string]: Todo[] }
  message: { [sessionID: string]: Message[] }
  part: { [messageID: string]: Part[] }
  lsp: LspStatus[]
  mcp: { [key: string]: McpStatus }
  mcp_resource: { [key: string]: McpResource }
  formatter: FormatterStatus[]
  vcs: any
  path: any
}

export type SyncEvent =
  | {
      type: "message.updated"
      properties: {
        info: Message
      }
    }
  | {
      type: "message.removed"
      properties: {
        sessionID: string
        messageID: string
      }
    }
  | {
      type: "message.part.updated"
      properties: {
        part: Part
      }
    }
  | {
      type: "message.part.removed"
      properties: {
        sessionID: string
        messageID: string
        partID: string
      }
    }
  | {
      type: "permission.asked"
      properties: PermissionRequest
    }
  | {
      type: "permission.replied"
      properties: {
        sessionID: string
        requestID: string
      }
    }

function protectedMessageIDs(store: SyncStore): Set<string> {
  const out = new Set<string>()
  for (const list of Object.values(store.permission)) {
    for (const req of list) {
      const id = req.tool?.messageID
      if (id) out.add(id)
    }
  }
  return out
}

function hasMessage(store: SyncStore, sessionID: string, messageID: string): boolean {
  const messages = store.message[sessionID]
  if (!messages) return false
  return messages.some((m) => m.id === messageID)
}

export function applySyncEvent(store: SyncStore, event: SyncEvent): void {
  const protectedIDs = protectedMessageIDs(store)

  if (event.type === "message.updated") {
    const sessionID = event.properties.info.sessionID
    const messages = store.message[sessionID]
    if (!messages) {
      store.message[sessionID] = [event.properties.info]
      return
    }

    const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
    if (result.found) {
      messages[result.index] = event.properties.info
      return
    }

    messages.splice(result.index, 0, event.properties.info)
    if (messages.length <= 100) return

    const gone = messages.shift()?.id
    if (!gone) return
    if (protectedIDs.has(gone)) return
    delete store.part[gone]
    return
  }

  if (event.type === "message.removed") {
    const messages = store.message[event.properties.sessionID]
    if (messages) {
      const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
      if (result.found) messages.splice(result.index, 1)
    }

    if (!protectedIDs.has(event.properties.messageID)) {
      delete store.part[event.properties.messageID]
    }
    return
  }

  if (event.type === "message.part.updated") {
    const part = event.properties.part

    const live = hasMessage(store, part.sessionID, part.messageID) || protectedIDs.has(part.messageID)
    if (!live) return

    const parts = store.part[part.messageID]
    if (!parts) {
      store.part[part.messageID] = [part]
      return
    }

    const result = Binary.search(parts, part.id, (p) => p.id)
    if (result.found) {
      parts[result.index] = part
      return
    }

    parts.splice(result.index, 0, part)
    return
  }

  if (event.type === "message.part.removed") {
    const parts = store.part[event.properties.messageID]
    if (!parts) return
    const result = Binary.search(parts, event.properties.partID, (p) => p.id)
    if (!result.found) return
    parts.splice(result.index, 1)
    return
  }

  if (event.type === "permission.replied") {
    const list = store.permission[event.properties.sessionID]
    if (!list) return
    const result = Binary.search(list, event.properties.requestID, (r) => r.id)
    if (!result.found) return
    list.splice(result.index, 1)
    return
  }

  if (event.type === "permission.asked") {
    const req = event.properties
    const list = store.permission[req.sessionID]
    if (!list) {
      store.permission[req.sessionID] = [req]
      return
    }
    const result = Binary.search(list, req.id, (r) => r.id)
    if (result.found) {
      list[result.index] = req
      return
    }
    list.splice(result.index, 0, req)
    return
  }
}
