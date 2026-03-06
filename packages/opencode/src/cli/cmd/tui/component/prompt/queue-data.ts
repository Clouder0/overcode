import type { OpenAIServiceTier } from "@/provider/openai/service-tier"
import type { PromptInfo } from "./history"

export type QueueItem = {
  id: string
  sessionID: string
  agent: string
  model: {
    providerID: string
    modelID: string
  }
  variant: string | undefined
  serviceTier: OpenAIServiceTier | undefined
  text: string
  parts: PromptInfo["parts"]
  time: {
    created: number
  }
  prepared:
    | {
        messageID: string
        partIDs: string[]
      }
    | undefined
}

export function createQueueItem<T extends QueueItem["prepared"]>(
  input: Omit<QueueItem, "time" | "prepared"> & { created: number; prepared?: T },
) {
  const item = {
    id: input.id,
    sessionID: input.sessionID,
    agent: input.agent,
    model: input.model,
    variant: input.variant,
    serviceTier: input.serviceTier,
    text: input.text,
    parts: input.parts,
    time: {
      created: input.created,
    },
    prepared: input.prepared,
  }
  return item as QueueItem & { prepared: T }
}

export function toPromptAsyncInput<T extends object>(input: {
  item: QueueItem & { prepared: NonNullable<QueueItem["prepared"]> }
  parts: T[]
}) {
  return {
    sessionID: input.item.sessionID,
    messageID: input.item.prepared.messageID,
    agent: input.item.agent,
    model: input.item.model,
    variant: input.item.variant,
    serviceTier: input.item.serviceTier,
    parts: input.parts,
  }
}
