type MessageLike = {
  id: string
  role?: string
  parentID?: string
}

export const collectAssistants = <T extends MessageLike>(messages: readonly T[], parentID: string, start: number) => {
  const out: T[] = []
  const from = Math.max(0, start)
  for (let i = from; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg || msg.role !== "assistant") continue
    if (msg.parentID !== parentID) continue
    out.push(msg)
  }
  return out
}
