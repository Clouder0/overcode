import type { Provider } from "../provider"

export type OpenAIServiceTier = "auto" | "flex" | "priority"

const OPENAI_PROVIDER_NPM = new Set(["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/github-copilot"])

export function getOpenAIServiceTierSupport(modelId: string) {
  return {
    flex:
      modelId.startsWith("o3") ||
      modelId.startsWith("o4-mini") ||
      (modelId.startsWith("gpt-5") && !modelId.startsWith("gpt-5-chat")),
    priority:
      modelId.startsWith("gpt-4") ||
      modelId.startsWith("gpt-5-mini") ||
      (modelId.startsWith("gpt-5") && !modelId.startsWith("gpt-5-nano") && !modelId.startsWith("gpt-5-chat")) ||
      modelId.startsWith("o3") ||
      modelId.startsWith("o4-mini"),
  }
}

export function supportsOpenAIServiceTier(model: Pick<Provider.Model, "api">, tier: OpenAIServiceTier) {
  if (!OPENAI_PROVIDER_NPM.has(model.api.npm)) return false
  if (tier === "auto") return true
  const support = getOpenAIServiceTierSupport(model.api.id)
  if (tier === "flex") return support.flex
  return support.priority
}

export function sanitizeOpenAIServiceTier(model: Pick<Provider.Model, "api">, tier: string | undefined) {
  if (!tier) return
  if (tier !== "auto" && tier !== "flex" && tier !== "priority") return
  if (!supportsOpenAIServiceTier(model, tier)) return
  return tier
}

export function supportsOpenAIFastMode(model: Pick<Provider.Model, "api">) {
  return supportsOpenAIServiceTier(model, "priority")
}
