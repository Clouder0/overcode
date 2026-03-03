type Sortable = {
  id: string
  order?: number
  time?: {
    created?: number
  }
}

export const order = (msg: { order?: number } | undefined) => {
  const value = msg?.order
  if (typeof value !== "number") return
  if (!Number.isInteger(value) || value <= 0) return
  return value
}

export const ord = (msg: { order?: number } | undefined) => order(msg) ?? Number.MAX_SAFE_INTEGER

export const sortMessages = (a: Sortable, b: Sortable) => {
  const ao = ord(a)
  const bo = ord(b)
  if (ao !== bo) return ao - bo

  const at = typeof a.time?.created === "number" ? a.time.created : 0
  const bt = typeof b.time?.created === "number" ? b.time.created : 0
  if (at !== bt) return at - bt

  return a.id.localeCompare(b.id)
}
