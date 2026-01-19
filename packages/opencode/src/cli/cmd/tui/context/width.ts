import { createSimpleContext } from "./helper"
import type { WidthMethod } from "@opentui/core"

export const { use: useWidth, provider: WidthProvider } = createSimpleContext({
  name: "Width",
  init: (props: { method: WidthMethod }) => props,
})
