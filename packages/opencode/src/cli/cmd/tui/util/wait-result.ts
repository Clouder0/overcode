type WaitStatus = "resolved" | "timedOut"

type Part = {
  direction: string
  peerType: string
  peer: string
  timeoutOccurred?: boolean
  metadata?: Record<string, unknown>
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

export function waitResultState(part: Part) {
  const opencode = record(part.metadata).opencode
  const data = record(opencode)
  const type = typeof data.messageType === "string" ? data.messageType : undefined
  const status = typeof data.waitStatus === "string" ? (data.waitStatus as WaitStatus) : undefined
  const isWaitResult =
    part.direction === "incoming" &&
    part.peerType === "system" &&
    (part.peer === "Wait result" || type === "wait_result")

  if (!isWaitResult) {
    return {
      isWaitResult: false,
      tone: undefined,
      icon: undefined,
      showTimeoutLabel: !!part.timeoutOccurred,
    }
  }

  if (status === "resolved") {
    return {
      isWaitResult: true,
      tone: "success" as const,
      icon: "✓",
      showTimeoutLabel: false,
    }
  }

  if (status === "timedOut") {
    return {
      isWaitResult: true,
      tone: "error" as const,
      icon: "⏱",
      showTimeoutLabel: true,
    }
  }

  return {
    isWaitResult: true,
    tone: "warning" as const,
    icon: "⏱",
    showTimeoutLabel: false,
  }
}
