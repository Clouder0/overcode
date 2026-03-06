import type { Provider } from "@/provider/provider"
import { supportsOpenAIFastMode } from "@/provider/openai/service-tier"

export function nextFastModeTier(value: string | undefined) {
  if (value === "priority") return "auto"
  return "priority"
}

export function fastModeState(input: {
  model: Pick<Provider.Model, "api"> | undefined
  serviceTier: string | undefined
}) {
  const supported = !!input.model && supportsOpenAIFastMode(input.model)
  const enabled = supported && input.serviceTier === "priority"
  if (!supported) {
    return {
      supported: false,
      enabled: false,
      title: "Fast mode unavailable",
      badge: "",
    }
  }
  return {
    supported: true,
    enabled,
    title: enabled ? "Disable fast mode" : "Enable fast mode",
    badge: enabled ? " · FAST" : "",
  }
}
