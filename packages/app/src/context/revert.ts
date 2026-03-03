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
