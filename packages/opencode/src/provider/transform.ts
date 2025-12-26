import type { APICallError, ModelMessage, ToolCallPart, ToolResultPart } from "ai"
import { unique } from "remeda"
import type { JSONSchema } from "zod/v4/core"
import type { Provider } from "./provider"
import type { ModelsDev } from "./models"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export namespace ProviderTransform {
  function normalizeMessages(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    if (model.api.id.includes("claude")) {
      return msgs.map((msg) => {
        if ((msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if ((part.type === "tool-call" || part.type === "tool-result") && "toolCallId" in part) {
              return {
                ...part,
                toolCallId: part.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_"),
              }
            }
            return part
          })
        }
        return msg
      })
    }
    if (model.providerID === "mistral" || model.api.id.toLowerCase().includes("mistral")) {
      const result: ModelMessage[] = []
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        const nextMsg = msgs[i + 1]

        if ((msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if ((part.type === "tool-call" || part.type === "tool-result") && "toolCallId" in part) {
              // Mistral requires alphanumeric tool call IDs with exactly 9 characters
              const normalizedId = part.toolCallId
                .replace(/[^a-zA-Z0-9]/g, "") // Remove non-alphanumeric characters
                .substring(0, 9) // Take first 9 characters
                .padEnd(9, "0") // Pad with zeros if less than 9 characters

              return {
                ...part,
                toolCallId: normalizedId,
              }
            }
            return part
          })
        }

        result.push(msg)

        // Fix message sequence: tool messages cannot be followed by user messages
        if (msg.role === "tool" && nextMsg?.role === "user") {
          result.push({
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Done.",
              },
            ],
          })
        }
      }
      return result
    }

    if (
      model.capabilities.interleaved &&
      typeof model.capabilities.interleaved === "object" &&
      model.capabilities.interleaved.field === "reasoning_content"
    ) {
      return msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
          const reasoningText = reasoningParts.map((part: any) => part.text).join("")

          // Filter out reasoning parts from content
          const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

          // Include reasoning_content directly on the message for all assistant messages
          if (reasoningText) {
            return {
              ...msg,
              content: filteredContent,
              providerOptions: {
                ...msg.providerOptions,
                openaiCompatible: {
                  ...(msg.providerOptions as any)?.openaiCompatible,
                  reasoning_content: reasoningText,
                },
              },
            }
          }

          return {
            ...msg,
            content: filteredContent,
          }
        }

        return msg
      })
    }

    return msgs
  }

  function isToolCallPart(part: unknown): part is ToolCallPart {
    if (!part || typeof part !== "object") return false
    const obj = part as Record<string, unknown>
    if (obj["type"] !== "tool-call") return false
    if (typeof obj["toolCallId"] !== "string") return false
    if (typeof obj["toolName"] !== "string") return false
    return true
  }

  function isToolResultPart(part: unknown): part is ToolResultPart {
    if (!part || typeof part !== "object") return false
    const obj = part as Record<string, unknown>
    if (obj["type"] !== "tool-result") return false
    if (typeof obj["toolCallId"] !== "string") return false
    if (typeof obj["toolName"] !== "string") return false
    return true
  }

  function ensureToolResults(msgs: ModelMessage[]): ModelMessage[] {
    const out: ModelMessage[] = []
    const output: ToolResultPart["output"] = {
      type: "error-text",
      value:
        "Tool result missing. The previous tool call did not complete (session may have been interrupted). Please retry.",
    }

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      out.push(msg)

      if (msg.role !== "assistant") continue
      if (!Array.isArray(msg.content)) continue

      const calls = msg.content.filter((part): part is ToolCallPart => {
        if (!isToolCallPart(part)) return false
        return part.providerExecuted !== true
      })
      if (calls.length === 0) continue

      const next = msgs[i + 1]
      if (next && next.role === "tool" && Array.isArray(next.content)) {
        const existing = new Set(
          next.content.filter((part): part is ToolResultPart => isToolResultPart(part)).map((part) => part.toolCallId),
        )
        const missing = calls.filter((call) => !existing.has(call.toolCallId))
        if (missing.length === 0) continue

        out.push({
          ...next,
          content: [
            ...next.content,
            ...missing.map((call) => ({
              type: "tool-result" as const,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output,
            })),
          ],
        })
        i++
        continue
      }

      out.push({
        role: "tool",
        content: calls.map((call) => ({
          type: "tool-result" as const,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output,
        })),
      } as ModelMessage)
    }

    return out
  }

  function applyCaching(msgs: ModelMessage[], providerID: string): ModelMessage[] {
    const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
    const final = msgs.filter((msg) => msg.role !== "system").slice(-2)

    const providerOptions = {
      anthropic: {
        cacheControl: { type: "ephemeral" },
      },
      openrouter: {
        cache_control: { type: "ephemeral" },
      },
      bedrock: {
        cachePoint: { type: "ephemeral" },
      },
      openaiCompatible: {
        cache_control: { type: "ephemeral" },
      },
    }

    for (const msg of unique([...system, ...final])) {
      const shouldUseContentOptions = providerID !== "anthropic" && Array.isArray(msg.content) && msg.content.length > 0

      if (shouldUseContentOptions) {
        const lastContent = msg.content[msg.content.length - 1]
        if (lastContent && typeof lastContent === "object") {
          lastContent.providerOptions = {
            ...lastContent.providerOptions,
            ...providerOptions,
          }
          continue
        }
      }

      msg.providerOptions = {
        ...msg.providerOptions,
        ...providerOptions,
      }
    }

    return msgs
  }

  function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    return msgs.map((msg) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

      const filtered = msg.content.map((part) => {
        if (part.type !== "file" && part.type !== "image") return part

        // Check for empty base64 image data
        if (part.type === "image") {
          const imageStr = part.image.toString()
          if (imageStr.startsWith("data:")) {
            const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
            if (match && (!match[2] || match[2].length === 0)) {
              return {
                type: "text" as const,
                text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
              }
            }
          }
        }

        const mime = part.type === "image" ? part.image.toString().split(";")[0].replace("data:", "") : part.mediaType
        const filename = part.type === "file" ? part.filename : undefined
        const modality = mimeToModality(mime)
        if (!modality) return part
        if (model.capabilities.input[modality]) return part

        const name = filename ? `"${filename}"` : modality
        return {
          type: "text" as const,
          text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
        }
      })

      return { ...msg, content: filtered }
    })
  }

  function sanitizeOpenAIOrphanReasoning(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    const isOpenAI = model.api.npm === "@ai-sdk/openai"
    const isOpenAICompatibleGPT5 = model.api.npm === "@ai-sdk/openai-compatible" && model.api.id.includes("gpt-5")
    if (!isOpenAI && !isOpenAICompatibleGPT5) return msgs

    const out: ModelMessage[] = []

    for (const msg of msgs) {
      if (msg.role !== "assistant") {
        out.push(msg)
        continue
      }

      if (!Array.isArray(msg.content)) {
        out.push(msg)
        continue
      }

      const reasoning = msg.content.filter((part) => part.type === "reasoning")
      if (reasoning.length === 0) {
        out.push(msg)
        continue
      }

      const nonReasoning = msg.content.filter((part) => part.type !== "reasoning")
      if (nonReasoning.length > 0) {
        out.push(msg)
        continue
      }

      const summary = reasoning
        .map((part) => (part as { text?: unknown }).text)
        .filter((t): t is string => typeof t === "string")
        .join("")
        .trim()

      const text = summary
        ? `[Recovery note] Previous generation was interrupted after emitting a reasoning summary, but no final output/tool call was produced. The original reasoning item cannot be replayed safely. Partial summary (for context only):\n\n${summary}`
        : "[Recovery note] Previous generation was interrupted during reasoning. No usable summary was captured."

      out.push({
        ...msg,
        content: [
          {
            type: "text",
            text,
          },
        ],
      })
    }

    return out
  }

  export function message(msgs: ModelMessage[], model: Provider.Model) {
    msgs = unsupportedParts(msgs, model)
    msgs = normalizeMessages(msgs, model)
    msgs = sanitizeOpenAIOrphanReasoning(msgs, model)
    if (
      model.providerID === "anthropic" ||
      model.api.id.includes("anthropic") ||
      model.api.id.includes("claude") ||
      model.api.npm === "@ai-sdk/anthropic"
    ) {
      msgs = ensureToolResults(msgs)
      msgs = applyCaching(msgs, model.providerID)
    }

    return msgs
  }

  export function temperature(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 0.55
    if (id.includes("claude")) return undefined
    if (id.includes("gemini-3-pro")) return 1.0
    if (id.includes("glm-4.6")) return 1.0
    if (id.includes("glm-4.7")) return 1.0
    if (id.includes("minimax-m2")) return 1.0
    if (id.includes("kimi-k2")) {
      if (id.includes("thinking")) return 1.0
      return 0.6
    }
    return undefined
  }

  export function topP(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 1
    if (id.includes("minimax-m2")) {
      if (id.includes("m2.1")) return 0.9
      return 0.95
    }
    return undefined
  }

  export function topK(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("minimax-m2")) return 20
    return undefined
  }

  export function options(
    model: Provider.Model,
    sessionID: string,
    providerOptions?: Record<string, any>,
  ): Record<string, any> {
    const result: Record<string, any> = {}

    if (model.api.npm === "@openrouter/ai-sdk-provider") {
      result["usage"] = {
        include: true,
      }
      if (model.api.id.includes("gemini-3")) {
        result["reasoning"] = { effort: "high" }
      }
    }

    if (
      model.providerID === "baseten" ||
      (model.providerID === "opencode" && ["kimi-k2-thinking", "glm-4.6"].includes(model.api.id))
    ) {
      result["chat_template_args"] = { enable_thinking: true }
    }

    if (model.providerID === "openai" || providerOptions?.setCacheKey) {
      result["promptCacheKey"] = sessionID
    }

    if (model.api.npm === "@ai-sdk/google" || model.api.npm === "@ai-sdk/google-vertex") {
      result["thinkingConfig"] = {
        includeThoughts: true,
      }
      if (model.api.id.includes("gemini-3")) {
        result["thinkingConfig"]["thinkingLevel"] = "high"
      }
    }

    if (model.api.id.includes("gpt-5") && !model.api.id.includes("gpt-5-chat")) {
      if (model.providerID.includes("codex")) {
        result["store"] = false
      }

      if (!model.api.id.includes("codex") && !model.api.id.includes("gpt-5-pro")) {
        result["reasoningEffort"] = "medium"
      }

      if (model.api.id.endsWith("gpt-5.") && model.providerID !== "azure") {
        result["textVerbosity"] = "low"
      }

      if (model.providerID.startsWith("opencode")) {
        result["promptCacheKey"] = sessionID
        result["include"] = ["reasoning.encrypted_content"]
        result["reasoningSummary"] = "auto"
      }
    }
    return result
  }

  export function smallOptions(model: Provider.Model) {
    const options: Record<string, any> = {}

    if (model.providerID === "openai" || model.api.id.includes("gpt-5")) {
      if (model.api.id.includes("5.")) {
        options["reasoningEffort"] = "low"
      } else {
        options["reasoningEffort"] = "minimal"
      }
    }
    if (model.providerID === "google") {
      options["thinkingConfig"] = {
        thinkingBudget: 0,
      }
    }

    return options
  }

  export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
    switch (model.api.npm) {
      case "@ai-sdk/openai":
      case "@ai-sdk/azure":
        return {
          ["openai" as string]: options,
        }
      case "@ai-sdk/amazon-bedrock":
        return {
          ["bedrock" as string]: options,
        }
      case "@ai-sdk/anthropic":
        return {
          ["anthropic" as string]: options,
        }
      case "@ai-sdk/google":
        return {
          ["google" as string]: options,
        }
      case "@ai-sdk/gateway":
        return {
          ["gateway" as string]: options,
        }
      case "@openrouter/ai-sdk-provider":
        return {
          ["openrouter" as string]: options,
        }
      default:
        return {
          [model.providerID]: options,
        }
    }
  }

  export function maxOutputTokens(
    npm: string,
    options: Record<string, any>,
    modelLimit: number,
    globalLimit: number,
  ): number {
    const modelCap = modelLimit || globalLimit
    const standardLimit = Math.min(modelCap, globalLimit)

    if (npm === "@ai-sdk/anthropic") {
      const thinking = options?.["thinking"]
      const budgetTokens = typeof thinking?.["budgetTokens"] === "number" ? thinking["budgetTokens"] : 0
      const enabled = thinking?.["type"] === "enabled"
      if (enabled && budgetTokens > 0) {
        // Return text tokens so that text + thinking <= model cap, preferring 32k text when possible.
        if (budgetTokens + standardLimit <= modelCap) {
          return standardLimit
        }
        return modelCap - budgetTokens
      }
    }

    return standardLimit
  }

  export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema) {
    /*
    if (["openai", "azure"].includes(providerID)) {
      if (schema.type === "object" && schema.properties) {
        for (const [key, value] of Object.entries(schema.properties)) {
          if (schema.required?.includes(key)) continue
          schema.properties[key] = {
            anyOf: [
              value as JSONSchema.JSONSchema,
              {
                type: "null",
              },
            ],
          }
        }
      }
    }
    */

    // Convert integer enums to string enums for Google/Gemini
    if (model.providerID === "google" || model.api.id.includes("gemini")) {
      const sanitizeGemini = (obj: any): any => {
        if (obj === null || typeof obj !== "object") {
          return obj
        }

        if (Array.isArray(obj)) {
          return obj.map(sanitizeGemini)
        }

        const result: any = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === "enum" && Array.isArray(value)) {
            // Convert all enum values to strings
            result[key] = value.map((v) => String(v))
            // If we have integer type with enum, change type to string
            if (result.type === "integer" || result.type === "number") {
              result.type = "string"
            }
          } else if (typeof value === "object" && value !== null) {
            result[key] = sanitizeGemini(value)
          } else {
            result[key] = value
          }
        }

        // Filter required array to only include fields that exist in properties
        if (result.type === "object" && result.properties && Array.isArray(result.required)) {
          result.required = result.required.filter((field: any) => field in result.properties)
        }

        if (result.type === "array" && result.items == null) {
          result.items = {}
        }

        return result
      }

      schema = sanitizeGemini(schema)
    }

    return schema
  }

  export function error(providerID: string, error: APICallError) {
    let message = error.message
    if (providerID === "github-copilot" && message.includes("The requested model is not supported")) {
      return (
        message +
        "\n\nMake sure the model is enabled in your copilot settings: https://github.com/settings/copilot/features"
      )
    }

    return message
  }
}
