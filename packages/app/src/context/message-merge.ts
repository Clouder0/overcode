import { sortMessages } from "./message-sort"

type MessageLike = {
  id: string
  role?: string
  order?: number
  time?: {
    created?: number
    completed?: number
  }
}

type PartLike = {
  id: string
}

export const seal = (msg: MessageLike | undefined) => {
  if (msg?.role !== "assistant") return false
  return typeof msg.time?.completed === "number"
}

export const mergeMessages = <T extends MessageLike>(input: {
  current: T[]
  snapshot: T[]
  limit: number
  tombstone?: Record<string, true>
}) => {
  const order = (msg: { order?: number } | undefined) => {
    const value = msg?.order
    if (typeof value !== "number") return
    if (!Number.isInteger(value) || value <= 0) return
    return value
  }

  const tombstone = input.tombstone ?? {}
  const dead = (id: string) => tombstone[id] === true

  const current = input.current.filter((m) => !!m?.id && !dead(m.id))
  const snapshot = input.snapshot.filter((m) => !!m?.id && !dead(m.id))

  const currentByID = new Map<string, T>(current.map((m) => [m.id, m]))

  const snapshotInfos = snapshot.map((msg) => {
    const existing = currentByID.get(msg.id)
    if (!existing) return msg

    if (existing.role === "assistant" && msg.role === "assistant") {
      if (existing.time?.completed !== undefined && msg.time?.completed === undefined) return existing
    }

    return msg
  })

  const bounds = (() => {
    let min = Number.POSITIVE_INFINITY
    let max = 0
    for (const msg of snapshotInfos) {
      const value = order(msg)
      if (value === undefined) continue
      if (value < min) min = value
      if (value > max) max = value
    }
    if (!Number.isFinite(min) || max <= 0) return
    return { min, max }
  })()

  const mergedByID = new Map<string, T>(snapshotInfos.map((m) => [m.id, m]))
  for (const msg of current) {
    if (mergedByID.has(msg.id)) continue
    if (bounds) {
      const value = order(msg)
      if (value !== undefined && value >= bounds.min && value <= bounds.max) continue
    }
    mergedByID.set(msg.id, msg)
  }

  const merged = Array.from(mergedByID.values()).sort(sortMessages)
  const limit = Math.max(0, input.limit)
  if (merged.length <= limit) return merged
  return merged.slice(Math.max(0, merged.length - limit))
}

export const mergeParts = <T extends PartLike>(input: {
  current: T[]
  snapshot: T[]
  tombstone?: Record<string, true>
  sealed?: boolean
}) => {
  const tombstone = input.tombstone ?? {}
  const dead = (id: string) => tombstone[id] === true

  const current = input.current.filter((p) => !!p?.id && !dead(p.id))
  const snapshot = input.snapshot.filter((p) => !!p?.id && !dead(p.id))

  const currentByID = new Map<string, T>(current.map((p) => [p.id, p]))
  const snapshotParts = snapshot.map((p) => currentByID.get(p.id) ?? p)

  const sealed = input.sealed === true

  const snapshotIDs = new Set(snapshotParts.map((p) => p.id))
  const extraParts = current.filter((p) => !snapshotIDs.has(p.id))
  if (!sealed) {
    const merged = snapshotParts.concat(extraParts)
    return merged.toSorted((a, b) => a.id.localeCompare(b.id))
  }

  const max = snapshotParts.reduce((m, p) => (p.id.localeCompare(m) > 0 ? p.id : m), "")
  const keep = extraParts.filter((p) => p.id.localeCompare(max) > 0)
  const merged = snapshotParts.concat(keep)
  return merged.toSorted((a, b) => a.id.localeCompare(b.id))
}
