import { SkillProjection } from "@/util/skill-projection"
import { modelVisibleMessage } from "@/util/model-visible"

type Msg = {
  id: string
  role: string
  error?: unknown
}

type Part = {
  id: string
  type: string
  tool?: string
  state?: {
    status?: string
    metadata?: unknown
    input?: unknown
  }
}

function aborted(error: unknown) {
  if (!error || typeof error !== "object") return false
  return (error as { name?: unknown }).name === "MessageAbortedError"
}

function visible(input: { message: Msg; parts: Part[] }) {
  return modelVisibleMessage({
    message: input.message,
    parts: input.parts,
    aborted,
  })
}

export function projectSkillProjection(input: {
  messages: Msg[]
  partsByMessageID: Record<string, Part[] | undefined>
}) {
  const list = input.messages.flatMap((message) => {
    const parts = input.partsByMessageID[message.id] ?? []
    if (!visible({ message, parts })) return []
    return [{ id: message.id, role: message.role, parts }]
  })

  return SkillProjection.project(list)
}
