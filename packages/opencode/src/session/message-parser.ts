export namespace MessageParser {
  export type TimeoutSnapshot = {
    source: string
    run: "idle" | "working" | "waiting" | "retry" | "unknown"
    waiting?: {
      sources: string[]
      mode: "all" | "any"
      deadline?: number
    }
    retry?: {
      attempt: number
      message: string
      next: number
    }
  }

  export function formatInbox(messages: Array<{ from: string; text: string; messageType?: string }>): string {
    const parts: string[] = []

    for (const msg of messages) {
      const label = msg.messageType === "timeout" ? "did not respond before your timeout" : "sent a message"
      parts.push(`Sender Agent with session id ${msg.from} ${label}:`)
      parts.push("<content>")
      parts.push(msg.text)
      parts.push("</content>")
    }

    return parts.join("\n").trimEnd()
  }

  export function formatTimeoutMessage(timeoutMs: number): string {
    return `Timeout after ${timeoutMs}ms waiting for response`
  }

  export function formatWaitTimeoutMessage(input: { timeoutMs: number; snapshot: TimeoutSnapshot }): string {
    const lines: string[] = [formatTimeoutMessage(input.timeoutMs)]

    lines.push(`Source status snapshot: ${input.snapshot.run}`)

    if (input.snapshot.run === "waiting" && input.snapshot.waiting) {
      const sources = input.snapshot.waiting.sources.join(", ") || "(none)"
      lines.push(`Source is waiting (mode=${input.snapshot.waiting.mode}) for: ${sources}`)
      if (input.snapshot.waiting.deadline !== undefined) {
        lines.push(`Wait deadline: ${input.snapshot.waiting.deadline}`)
      }
      lines.push("Suggested action: wait again")
      return lines.join("\n")
    }

    if (input.snapshot.run === "retry" && input.snapshot.retry) {
      lines.push(
        `Retry: attempt=${input.snapshot.retry.attempt} next=${input.snapshot.retry.next} reason=${input.snapshot.retry.message}`,
      )
      lines.push("Suggested action: wait again")
      return lines.join("\n")
    }

    if (input.snapshot.run === "idle") {
      lines.push(`Suggested action: ping ${input.snapshot.source} for results`)
      return lines.join("\n")
    }

    if (input.snapshot.run === "working") {
      lines.push("Suggested action: wait again")
      return lines.join("\n")
    }

    lines.push("Suggested action: wait again")
    return lines.join("\n")
  }
}
