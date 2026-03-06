import { MessageV2 } from "./message-v2"
import { isAssistantAnswered } from "./relevance"

function tools(value: MessageV2.User["tools"]) {
  if (!value) return {}
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
  return Object.fromEntries(entries)
}

export function settingsKey(user: MessageV2.User) {
  return JSON.stringify({
    providerID: user.model.providerID,
    modelID: user.model.modelID,
    agent: user.agent,
    system: user.system ?? "",
    tools: tools(user.tools),
    variant: user.variant ?? "",
    serviceTier: user.serviceTier ?? "",
  })
}

function coveredPart(part: MessageV2.Part) {
  if (part.type !== "text") return [] as string[]
  if (part.synthetic !== true) return [] as string[]
  if (part.ignored !== true) return [] as string[]

  const metadata = part.metadata
  if (!metadata || typeof metadata !== "object") return [] as string[]
  const opencode = (metadata as { opencode?: unknown }).opencode
  if (!opencode || typeof opencode !== "object") return [] as string[]
  const batch = (opencode as { batch?: unknown }).batch
  if (!batch || typeof batch !== "object") return [] as string[]
  const users = (batch as { users?: unknown }).users
  if (!Array.isArray(users)) return [] as string[]
  return users.filter((x): x is string => typeof x === "string")
}

export function coveredUsers(msg: MessageV2.WithParts) {
  return Array.from(new Set(msg.parts.flatMap(coveredPart)))
}

export function isAnswered(input: { userID: string; replies: MessageV2.WithParts[]; covered: Set<string> }) {
  if (input.covered.has(input.userID)) return true
  return input.replies.some(
    (msg) => msg.info.role === "assistant" && isAssistantAnswered(msg.info as MessageV2.Assistant),
  )
}

export function batchEnd(input: {
  users: MessageV2.WithParts[]
  start: number
  isUnanswered: (msg: MessageV2.WithParts) => boolean
}) {
  const anchor = input.users[input.start]
  if (!anchor) return input.start
  if (anchor.info.role !== "user") return input.start

  const key = settingsKey(anchor.info)
  const boundary = input.users.slice(input.start + 1).findIndex((msg) => {
    if (msg.info.role !== "user") return true
    if (!input.isUnanswered(msg)) return true
    return settingsKey(msg.info) !== key
  })

  if (boundary === -1) return input.users.length - 1
  return input.start + boundary
}
