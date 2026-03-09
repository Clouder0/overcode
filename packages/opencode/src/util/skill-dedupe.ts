import { MessageV2 } from "../session/message-v2"
import { isUserRelevant } from "../session/relevance"

export type SkillReuse =
  | { kind: "duplicate_in_turn"; turns: number }
  | { kind: "same_turn"; turns: number }
  | { kind: "near_context"; turns: number }

export type SkillReuseInput = {
  name: string
  hash: string
  anchorUserID?: string
  visible: MessageV2.WithParts[]
  currentMessageID: string
  current: MessageV2.Part[]
}

function meta(part: MessageV2.Part) {
  if (part.type !== "tool") return
  if (part.tool !== "skill") return
  if (part.state.status !== "completed") return
  const value = part.state.metadata
  if (!value || typeof value !== "object") return
  return value as Record<string, unknown>
}

function name(part: MessageV2.Part) {
  if (part.type !== "tool") return
  if (part.tool !== "skill") return
  if (part.state.status !== "completed") return

  const item = meta(part)?.name
  if (typeof item === "string" && item.trim().length > 0) return item.trim()

  const value = part.state.input.name
  if (typeof value !== "string") return
  if (value.trim().length === 0) return
  return value.trim()
}

function applied(part: MessageV2.Part) {
  if (part.type !== "tool") return false
  if (part.tool !== "skill") return false
  if (part.state.status !== "completed") return false
  return meta(part)?.applied !== false
}

function marker(part: MessageV2.Part) {
  if (!("metadata" in part)) return false
  const value = part.metadata
  if (!value || typeof value !== "object") return false
  const opencode = (value as { opencode?: unknown }).opencode
  if (!opencode || typeof opencode !== "object") return false
  const item = (opencode as { marker?: unknown }).marker
  if (!item || typeof item !== "object") return false
  const kind = (item as { kind?: unknown }).kind
  return kind === "trim" || kind === "think" || kind === "rctx"
}

function hash(part: MessageV2.Part) {
  const value = meta(part)?.hash
  if (typeof value === "string") return value
}

function anchor(part: MessageV2.Part) {
  const value = meta(part)?.anchorUserID
  if (typeof value === "string" && value.length > 0) return value
}

export function inspectSkillReuse(input: SkillReuseInput) {
  const merged = (() => {
    const list = input.visible.map((message) => ({
      id: message.info.id,
      role: message.info.role,
      parts: message.parts,
      user: isUserRelevant(message),
    }))
    const found = list.findIndex((message) => message.id === input.currentMessageID)
    const current = {
      id: input.currentMessageID,
      role: "assistant",
      parts: input.current,
      user: false,
    } as const

    if (found === -1) return [...list, current]
    return list.map((message, index) => (index === found ? current : message))
  })()

  const duplicate = input.current.findLast((part) => {
    if (!applied(part)) return false
    if (name(part) !== input.name) return false
    return hash(part) === input.hash
  })
  if (duplicate) {
    return {
      turns: 0,
      reuse: { kind: "duplicate_in_turn", turns: 0 } as SkillReuse,
    }
  }

  const prior = merged
    .flatMap((message, index) =>
      message.parts.map((part, partIndex) => ({
        message,
        index,
        part,
        partIndex,
      })),
    )
    .findLast((item) => {
      if (item.message.id === input.currentMessageID) return false
      if (item.message.role !== "assistant") return false
      if (!applied(item.part)) return false
      if (name(item.part) !== input.name) return false
      return hash(item.part) === input.hash
    })

  if (!prior) return { turns: 0 }

  const turns = merged.slice(prior.index + 1).filter((message) => message.user).length
  const invalid = [
    ...prior.message.parts.slice(prior.partIndex + 1),
    ...merged.slice(prior.index + 1).flatMap((message) => message.parts),
  ].some(marker)

  const same = !invalid && turns <= 1 && !!input.anchorUserID && anchor(prior.part) === input.anchorUserID

  if (same) {
    return {
      turns,
      reuse: { kind: "same_turn", turns } as SkillReuse,
    }
  }

  if (invalid || turns > 1) return { turns }

  return {
    turns,
    reuse: { kind: "near_context", turns } as SkillReuse,
  }
}

export function classifySkillReuse(input: SkillReuseInput): SkillReuse | undefined {
  return inspectSkillReuse(input).reuse
}
