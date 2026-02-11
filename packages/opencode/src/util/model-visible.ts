type Msg = {
  role: string
  error?: unknown
}

type Part = {
  type: string
}

export function modelVisibleMessage(input: { message: Msg; parts: Part[]; aborted(error: unknown): boolean }) {
  if (input.parts.length === 0) return false
  if (input.message.role !== "assistant") return true
  if (!input.message.error) return true
  if (!input.aborted(input.message.error)) return false
  return input.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
}
