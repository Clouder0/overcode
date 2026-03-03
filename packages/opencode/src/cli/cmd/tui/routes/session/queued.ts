type MessageLike = {
  id: string
  order?: number
  time?: {
    created?: number
  }
}

const valid = (value: unknown): value is number => {
  if (typeof value !== "number") return false
  if (!Number.isInteger(value) || value <= 0) return false
  return true
}

export const isQueued = (input: { messages: MessageLike[]; pending: string; current: string }) => {
  const pendingOrder = input.messages.find((m) => m.id === input.pending)?.order
  const currentOrder = input.messages.find((m) => m.id === input.current)?.order
  if (valid(pendingOrder) && valid(currentOrder) && currentOrder > pendingOrder) return true

  const pendingIndex = input.messages.findIndex((m) => m.id === input.pending)
  const currentIndex = input.messages.findIndex((m) => m.id === input.current)
  if (pendingIndex !== -1 && currentIndex !== -1) return currentIndex > pendingIndex

  const pendingTime = input.messages.find((m) => m.id === input.pending)?.time?.created
  const currentTime = input.messages.find((m) => m.id === input.current)?.time?.created
  if (typeof pendingTime === "number" && typeof currentTime === "number") return currentTime > pendingTime

  return false
}
