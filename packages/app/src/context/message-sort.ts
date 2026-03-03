type Sortable = {
  id: string
  order?: number
  time?: {
    created?: number
  }
}

export const ord = (msg: { order?: number } | undefined) => {
  const value = msg?.order
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  return Number.MAX_SAFE_INTEGER
}

export const sortMessages = (a: Sortable, b: Sortable) => {
  const ao = ord(a)
  const bo = ord(b)
  if (ao !== bo) return ao - bo

  const at = typeof a.time?.created === "number" ? a.time.created : 0
  const bt = typeof b.time?.created === "number" ? b.time.created : 0
  if (at !== bt) return at - bt

  return a.id.localeCompare(b.id)
}

export const upsertMessage = <T extends Sortable>(list: T[], msg: T) => {
  const idx = list.findIndex((m) => m.id === msg.id)
  if (idx === -1) {
    list.push(msg)
  }
  if (idx !== -1) {
    list[idx] = msg
  }
  list.sort(sortMessages)
  return list
}
