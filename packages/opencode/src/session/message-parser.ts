export namespace MessageParser {
  export type TimeoutSnapshot = {
    source: string
    agent?: string
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

  export function formatInbox(
    messages: Array<{ from: string; text: string; messageType?: string; seq?: number }>,
  ): string {
    const parts: string[] = []

    for (const msg of messages) {
      const label = msg.messageType === "timeout" ? "did not respond before your timeout" : "sent a message"
      const suffix = typeof msg.seq === "number" && msg.seq > 0 ? ` (seq: ${msg.seq})` : ""
      parts.push(`Sender Agent with session id ${msg.from}${suffix} ${label}:`)
      parts.push("<content>")
      parts.push(msg.text)
      parts.push("</content>")
    }

    return parts.join("\n").trimEnd()
  }

  export type WaitResultInput = {
    timeoutMs: number
    mode: "all" | "any"
    responded: string[]
    timedOut: TimeoutSnapshot[]
    agents?: Record<string, string>
    wildcard?: boolean
  }

  export function formatWaitResult(input: WaitResultInput): string {
    const lines: string[] = []

    const tag = (id: string, agent?: string) => {
      if (!agent) return id
      return `${id} (${agent})`
    }

    const wildcard = input.wildcard === true

    // Header
    if (input.timedOut.length > 0 || wildcard) {
      lines.push(`Wait timed out after ${input.timeoutMs}ms`)
    } else {
      lines.push(`Wait resolved`)
    }
    lines.push(`Mode: ${input.mode}`)
    if (wildcard) {
      lines.push(`Sources: any agent`)
    }
    lines.push("")

    // Responded sources
    if (input.responded.length > 0) {
      const responded = input.responded.map((id) => tag(id, input.agents?.[id])).join(", ")
      lines.push(`Responded: ${responded}`)
    }

    // Timed out sources with status
    if (input.timedOut.length > 0) {
      lines.push("Timed out:")
      for (const snap of input.timedOut) {
        const id = tag(snap.source, snap.agent ?? input.agents?.[snap.source])
        lines.push(`  ${id}: ${snap.run}`)
      }
      lines.push("")
      lines.push("Note: replies can be delayed and may arrive after timeouts.")
      lines.push("")

      // Suggestions per source
      for (const snap of input.timedOut) {
        const id = tag(snap.source, snap.agent ?? input.agents?.[snap.source])
        if (snap.run === "working" || snap.run === "waiting" || snap.run === "retry") {
          lines.push(`${id} is still processing - consider waiting again.`)
          continue
        }
        if (snap.run === "idle") {
          lines.push(`${id} is idle - consider sending a message to check status.`)
          continue
        }
        lines.push(`${id} status unknown - consider waiting again or checking status.`)
      }
    }

    if (wildcard && input.timedOut.length === 0) {
      lines.push("No agent message was received before the timeout.")
    }

    return lines.join("\n").trimEnd()
  }
}
