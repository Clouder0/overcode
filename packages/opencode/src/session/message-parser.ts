import z from "zod"

export namespace MessageParser {
  export const ParsedMessage = z.object({
    to: z.string(),
    timeout: z.number(),
    content: z.string(),
  })
  export type ParsedMessage = z.infer<typeof ParsedMessage>

  export const ParsedWait = z.object({
    sources: z.array(z.string()),
    timeout: z.number(),
    mode: z.enum(["all", "any"]),
  })
  export type ParsedWait = z.infer<typeof ParsedWait>

  export const ParseResult = z.object({
    messages: z.array(ParsedMessage),
    wait: ParsedWait.optional(),
    remainingText: z.string(),
    malformed: z.boolean().optional(),
    errors: z.array(z.string()).optional(),
  })
  export type ParseResult = z.infer<typeof ParseResult>

  // Helper to extract attribute value from tag content
  function extractAttribute(tagContent: string, attr: string): string | undefined {
    const regex = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i")
    const match = tagContent.match(regex)
    return match?.[1]
  }

  // Parse all structural tags from output
  // Protocol rule: At most ONE <wait> tag allowed, and it must be the last element
  export function parse(output: string): ParseResult {
    const messages: ParsedMessage[] = []
    const errors: string[] = []
    let remaining = output

    // Match all <message ...>...</message> tags (global, flexible attribute order)
    const messageRegex = /<message\b([^>]*)>([\s\S]*?)<\/message>/gi
    const messageMatches = Array.from(output.matchAll(messageRegex))

    for (const match of messageMatches) {
      const [fullMatch, tagContent, content] = match
      const to = extractAttribute(tagContent, "to")
      const timeoutStr = extractAttribute(tagContent, "timeout")

      if (to && timeoutStr) {
        const timeout = parseInt(timeoutStr, 10)
        if (!Number.isNaN(timeout)) {
          messages.push({
            to,
            timeout,
            content: content.trim(),
          })
        } else {
          errors.push(`Invalid timeout value in message tag: ${timeoutStr}`)
        }
      } else {
        errors.push(`Missing required attributes in message tag: to=${to}, timeout=${timeoutStr}`)
      }
      remaining = remaining.replace(fullMatch, "")
    }

    // Match all <wait .../> or <wait ...> tags (global)
    const waitRegex = /<wait\b([^>]*?)(?:\/>|>(?:<\/wait>)?)/gi
    const waitMatches = Array.from(output.matchAll(waitRegex))

    // Protocol rule: At most ONE wait tag allowed
    if (waitMatches.length > 1) {
      errors.push(`Multiple <wait> tags not allowed. Found ${waitMatches.length}, expected at most 1.`)
    }

    let wait: ParsedWait | undefined
    if (waitMatches.length > 0) {
      const match = waitMatches[0]
      const [fullMatch, tagContent] = match
      const sourcesStr = extractAttribute(tagContent, "sources")
      const timeoutStr = extractAttribute(tagContent, "timeout")
      const modeStr = extractAttribute(tagContent, "mode")

      if (sourcesStr && timeoutStr && modeStr) {
        const timeout = parseInt(timeoutStr, 10)
        const mode = modeStr.toLowerCase()
        if (!Number.isNaN(timeout) && (mode === "all" || mode === "any")) {
          wait = {
            sources: sourcesStr.split(",").map((s) => s.trim()),
            timeout,
            mode: mode as "all" | "any",
          }
        } else {
          errors.push(`Invalid wait tag: timeout=${timeoutStr}, mode=${modeStr}`)
        }
      } else {
        errors.push(
          `Missing required attributes in wait tag: sources=${sourcesStr}, timeout=${timeoutStr}, mode=${modeStr}`,
        )
      }

      // Remove all wait tags from remaining
      for (const m of waitMatches) {
        remaining = remaining.replace(m[0], "")
      }

      // Protocol rule: <wait> must be the last element
      // Check if there's any structural content after the first wait tag in original output
      const firstWaitIndex = output.indexOf(waitMatches[0][0])
      const contentAfterWait = output.slice(firstWaitIndex + waitMatches[0][0].length)
      const hasMessageAfterWait = /<message\b/i.test(contentAfterWait)
      if (hasMessageAfterWait) {
        errors.push(`<wait> must be the last element. Found <message> tag after <wait>.`)
      }
    }

    const trimmedRemaining = remaining.trim()

    // STRICT STRUCTURAL OUTPUT: All LLM output must be in structural tags.
    // Malformed if:
    // 1. There were parsing errors
    // 2. There's non-whitespace text outside structural tags
    const malformed = errors.length > 0 || trimmedRemaining.length > 0

    return {
      messages,
      wait,
      remainingText: trimmedRemaining,
      malformed,
      errors: errors.length > 0 ? errors : undefined,
    }
  }

  export function serialize(message: ParsedMessage): string {
    return `<message to="${message.to}" timeout="${message.timeout}">\n${message.content}\n</message>`
  }

  export function formatIncoming(from: string, content: string, isTimeout = false): string {
    const source = isTimeout ? `system timeout ${from}` : from
    return `[From ${source}]:\n${content}`
  }

  export function formatTimeoutMessage(timeoutMs: number): string {
    return `Timeout after ${timeoutMs}ms waiting for response`
  }
}
