import type { Config } from "@opencode-ai/sdk/v2"

export function lspMax(config: Config) {
  const experimental = config.experimental
  if (!experimental) return

  const lsp = (experimental as Record<string, unknown>).lsp
  if (!lsp || typeof lsp !== "object") return

  const max = (lsp as Record<string, unknown>).maxServers
  if (typeof max !== "number") return
  return max
}
