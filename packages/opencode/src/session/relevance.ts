import { MessageV2 } from "./message-v2"

function opencodeMeta(input: unknown) {
  if (!input || typeof input !== "object") return
  const opencode = (input as { opencode?: unknown }).opencode
  if (!opencode || typeof opencode !== "object") return
  return opencode as Record<string, unknown>
}

function isReplayText(part: MessageV2.TextPart) {
  if (part.synthetic !== true) return false
  const meta = opencodeMeta(part.metadata)
  if (!meta) return false
  return meta["replay"] === true
}

function isBootstrapText(part: MessageV2.TextPart) {
  if (part.synthetic !== true) return false
  const meta = opencodeMeta(part.metadata)
  if (!meta) return false
  return meta["bootstrap"] === true
}

function isConsumedMessage(part: MessageV2.MessagePart) {
  const meta = opencodeMeta(part.metadata)
  if (!meta) return false
  return meta["consumed"] === true
}

function inboundMessageType(part: MessageV2.MessagePart) {
  const meta = opencodeMeta(part.metadata)
  if (!meta) return
  const value = meta["messageType"]
  if (typeof value !== "string") return
  return value
}

export function isRelevantInboundMessage(part: MessageV2.MessagePart) {
  if (part.direction !== "incoming") return false
  if (isConsumedMessage(part)) return false
  if (part.peerType === "system") {
    const type = inboundMessageType(part)
    if (type === "notice") return true
    if (type === "wait_result") return true
    return false
  }
  return true
}

export function isTextRelevant(part: MessageV2.TextPart) {
  if (part.ignored) return false
  if (part.synthetic !== true) return true
  return isReplayText(part) || isBootstrapText(part)
}

export function isUserRelevant(msg: MessageV2.WithParts) {
  if (msg.info.role !== "user") return false
  return msg.parts.some((part) => {
    if (part.type === "text") {
      return isTextRelevant(part)
    }
    if (part.type === "file") return true
    if (part.type === "subtask") return true
    if (part.type === "agent") return true
    if (part.type === "message") return isRelevantInboundMessage(part)
    return false
  })
}

export function isAssistantAnswered(info: MessageV2.Assistant) {
  if (!info.time.completed) return false
  if (info.summary === true) return false
  // A completed assistant error is terminal for the parent user message.
  // Treat it as answered so FIFO can continue to newer queued user inputs.
  if (info.error) return true
  if (!info.finish) return false
  if (["tool-calls", "unknown"].includes(info.finish)) return false
  return true
}
