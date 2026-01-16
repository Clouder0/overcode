import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
}

export type SessionInfo = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type MessageWithParts = {
  info: UserMessage | AssistantMessage
  parts: Part[]
}

export function formatTranscript(
  session: SessionInfo,
  messages: MessageWithParts[],
  options: TranscriptOptions,
): string {
  let transcript = `# ${session.title}\n\n`
  transcript += `**Session ID:** ${session.id}\n`
  transcript += `**Created:** ${new Date(session.time.created).toLocaleString()}\n`
  transcript += `**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n`
  transcript += `---\n\n`

  for (const msg of messages) {
    transcript += formatMessage(msg.info, msg.parts, options)
    transcript += `---\n\n`
  }

  return transcript
}

export function formatMessage(msg: UserMessage | AssistantMessage, parts: Part[], options: TranscriptOptions): string {
  let result = ""

  if (msg.role === "user") {
    result += `## User\n\n`
  } else {
    result += formatAssistantHeader(msg, options.assistantMetadata)
  }

  for (const part of parts) {
    result += formatPart(part, options)
  }

  return result
}

export function formatAssistantHeader(msg: AssistantMessage, includeMetadata: boolean): string {
  if (!includeMetadata) {
    return `## Assistant\n\n`
  }

  const duration =
    msg.time.completed && msg.time.created ? ((msg.time.completed - msg.time.created) / 1000).toFixed(1) + "s" : ""

  return `## Assistant (${Locale.titlecase(msg.agent)} · ${msg.modelID}${duration ? ` · ${duration}` : ""})\n\n`
}

export function formatPart(part: Part, options: TranscriptOptions): string {
  if (part.type === "text" && !part.synthetic) {
    return `${part.text}\n\n`
  }

  if (part.type === "reasoning") {
    if (!options.thinking) return ""

    const meta = part.metadata
    const opencode = meta && typeof meta === "object" ? (meta as { opencode?: unknown }).opencode : undefined
    const reason = opencode && typeof opencode === "object" ? (opencode as { reason?: unknown }).reason : undefined

    const label =
      part.ignored !== true
        ? "_Thinking:_"
        : reason === "interrupted"
          ? "_Thinking (omitted when you continued):_"
          : "_Thinking (omitted from model context):_"

    return `${label}\n\n${part.text}\n\n`
  }

  if (part.type === "tool") {
    let result = `\`\`\`\nTool: ${part.tool}\n`
    if (options.toolDetails && part.state.input) {
      result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\``
    }
    if (options.toolDetails && part.state.status === "completed" && part.state.output) {
      result += `\n**Output:**\n\`\`\`\n${part.state.output}\n\`\`\``
    }
    if (options.toolDetails && part.state.status === "error" && part.state.error) {
      result += `\n**Error:**\n\`\`\`\n${part.state.error}\n\`\`\``
    }
    result += `\n\`\`\`\n\n`
    return result
  }

  if (part.type === "message") {
    const dir = part.direction === "incoming" ? "from" : "to"
    const peer = (() => {
      if (part.peerType === "agent") return `agent ${part.peer}`
      if (part.peerType === "system") return `system ${part.peer}`
      return part.peer
    })()

    const meta = (part as any).metadata
    const opencode = meta && typeof meta === "object" ? (meta as { opencode?: unknown }).opencode : undefined
    const seq = opencode && typeof opencode === "object" ? (opencode as { seq?: unknown }).seq : undefined
    const seqLabel = typeof seq === "number" ? ` seq: ${seq}` : ""

    const suffix = part.timeoutOccurred ? " (timed out)" : ""

    return `_Message ${dir} ${peer}${seqLabel}${suffix}:_\n\n${part.text}\n\n`
  }

  return ""
}
