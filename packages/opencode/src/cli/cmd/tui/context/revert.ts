import { sortMessages } from "./message-sort"

type Sortable = {
  id: string
  order?: number
  time?: {
    created?: number
  }
}

type RevertLike = {
  messageID: string
  partID?: string
}

export const swap = (input: { id: string; revert: RevertLike | undefined }) => {
  const revert = input.revert
  if (!revert?.messageID) return false
  if (revert.partID) return false
  return input.id === revert.messageID
}

export const show = (input: { list: { id: string }[]; revert: RevertLike | undefined }) => {
  const revert = input.revert
  if (!revert?.messageID) return false
  if (revert.partID) return true
  return !input.list.some((m) => m.id === revert.messageID)
}

export const reverted = <T extends Sortable & { role?: string }>(input: {
  list: T[]
  revert: RevertLike | undefined
  boundary?: Sortable
  role?: string
}) => {
  const list = input.list
  const revert = input.revert
  if (!revert?.messageID) return [] as T[]

  const part = revert.partID
  const role = input.role
  const boundary = input.boundary
  if (boundary) {
    return list.filter((msg) => {
      const diff = sortMessages(msg, boundary)
      if (part) {
        if (diff <= 0) return false
      }
      if (!part) {
        if (diff < 0) return false
      }
      if (role && msg.role !== role) return false
      return true
    })
  }

  const idx = list.findIndex((m) => m.id === revert.messageID)
  if (idx === -1) return [] as T[]
  const start = part ? idx + 1 : idx
  return list.filter((msg, i) => {
    if (i < start) return false
    if (role && msg.role !== role) return false
    return true
  })
}

export const cut = <T extends Sortable>(input: { list: T[]; revert: RevertLike | undefined; boundary?: Sortable }) => {
  const list = input.list
  const revert = input.revert
  if (!revert?.messageID) return list

  const id = revert.messageID
  const part = revert.partID
  const idx = list.findIndex((m) => m.id === id)
  if (idx !== -1) {
    const end = part ? idx + 1 : idx
    return list.slice(0, end)
  }

  const boundary = input.boundary
  if (!boundary) return []

  const keep = (m: T) => {
    const diff = sortMessages(m, boundary)
    if (part) return diff <= 0
    return diff < 0
  }
  return list.filter(keep)
}

export const after = <T extends Sortable & { role?: string }>(input: {
  list: T[]
  boundary: Sortable
  role?: string
}) => {
  const role = input.role
  for (const msg of input.list) {
    if (sortMessages(msg, input.boundary) <= 0) continue
    if (role && msg.role !== role) continue
    return msg
  }
}
