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
    status: "resolved" | "timedOut" | "interrupted"
    timeoutMs: number
    mode: "all" | "any"
    since: number
    sources: string[]
    responded: string[]
    respondedSeqs?: Record<string, number>
    timedOut: TimeoutSnapshot[]
    agents?: Record<string, string>
  }

  export function waitResultStatus(text: string) {
    const line = text.trim().split("\n", 1)[0]
    if (line === "Wait resolved") return "resolved" as const
    if (line.startsWith("Wait timed out")) return "timedOut" as const
  }

  export function formatWaitResult(input: WaitResultInput): string {
    const lines: string[] = []

    const tag = (id: string, agent?: string, seq?: number) => {
      const parts = [agent, typeof seq === "number" && seq > 0 ? `seq=${seq}` : undefined].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
      if (parts.length === 0) return id
      return `${id} (${parts.join(", ")})`
    }

    const wildcard = input.sources.length === 1 && input.sources[0] === "*"
    const status = input.status

    // Header
    if (status === "timedOut") {
      lines.push(`Wait timed out after ${input.timeoutMs}ms`)
    }
    if (status === "resolved") {
      lines.push("Wait resolved")
    }
    if (status === "interrupted") {
      lines.push("Wait interrupted")
    }
    lines.push(`Mode: ${input.mode}`)
    lines.push(`Since: ${input.since}`)
    if (wildcard) {
      lines.push(`Sources: any agent`)
    } else {
      lines.push(`Sources: ${input.sources.join(", ")}`)
    }
    lines.push("")

    if (status === "resolved") {
      const reason =
        input.mode === "any"
          ? "at least one source sent a message with seq > since."
          : "all required sources sent a message with seq > since."
      lines.push(`Reason: ${reason}`)
    }

    // Responded sources
    if (input.responded.length > 0) {
      const responded = input.responded.map((id) => tag(id, input.agents?.[id], input.respondedSeqs?.[id])).join(", ")
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

    if (status === "timedOut" && wildcard && input.timedOut.length === 0) {
      lines.push("No agent message was received before the timeout.")
    }

    lines.push("")
    lines.push(
      "Note: wait_agent_message does not return message bodies; replies appear as separate incoming agent messages.",
    )

    return lines.join("\n").trimEnd()
  }
}
