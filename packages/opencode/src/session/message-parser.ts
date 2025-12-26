export namespace MessageParser {
  export function formatInbox(messages: Array<{ from: string; text: string; messageType?: string }>): string {
    const parts: string[] = []

    for (const msg of messages) {
      const label = msg.messageType === "timeout" ? "timed out" : "sent a message"
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
}
