type SkillPartState = {
  status?: string
  metadata?: unknown
  input?: unknown
}

type SkillPart = {
  id: string
  type: string
  tool?: string
  state?: SkillPartState
}

type SkillMessage = {
  id: string
  role: string
  parts: SkillPart[]
}

type Active = {
  partID: string
  messageID: string
}

export namespace SkillProjection {
  export type Message = SkillMessage

  export type Result = {
    activeByName: Map<string, string>
    activePartIDs: Set<string>
    supersededPartIDs: Set<string>
    supersededNamesByMessageID: Map<string, string[]>
  }

  function resolveName(part: SkillPart) {
    const state = part.state
    if (!state) return

    const meta = state.metadata
    if (meta && typeof meta === "object") {
      const value = (meta as { name?: unknown }).name
      if (typeof value === "string" && value.trim().length > 0) return value.trim()
    }

    const input = state.input
    if (!input || typeof input !== "object") return
    const value = (input as { name?: unknown }).name
    if (typeof value !== "string") return
    if (value.trim().length === 0) return
    return value.trim()
  }

  function skill(part: SkillPart) {
    if (part.type !== "tool") return false
    if (part.tool !== "skill") return false
    if (!part.state) return false
    if (part.state.status !== "completed") return false
    return true
  }

  function applied(part: SkillPart) {
    if (!skill(part)) return false
    const meta = part.state?.metadata
    if (!meta || typeof meta !== "object") return true
    return (meta as { applied?: unknown }).applied !== false
  }

  export function project(messages: Message[]): Result {
    const active = new Map<string, Active>()
    const superseded = new Set<string>()
    const markers = new Map<string, Set<string>>()

    for (const msg of messages) {
      if (msg.role !== "assistant") continue

      for (const part of msg.parts) {
        if (!applied(part)) continue
        const name = resolveName(part)
        if (!name) continue

        const prev = active.get(name)
        if (prev) {
          superseded.add(prev.partID)
          const names = markers.get(prev.messageID) ?? new Set<string>()
          names.add(name)
          markers.set(prev.messageID, names)
        }

        active.set(name, {
          partID: part.id,
          messageID: msg.id,
        })
      }
    }

    const activeByName = new Map<string, string>()
    const activePartIDs = new Set<string>()
    for (const [name, value] of active) {
      activeByName.set(name, value.partID)
      activePartIDs.add(value.partID)
    }

    const supersededNamesByMessageID = new Map<string, string[]>()
    for (const [messageID, names] of markers) {
      supersededNamesByMessageID.set(messageID, Array.from(names))
    }

    return {
      activeByName,
      activePartIDs,
      supersededPartIDs: superseded,
      supersededNamesByMessageID,
    }
  }
}
