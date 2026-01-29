import z from "zod"
import { Identifier } from "@/id/id"
import { Storage } from "@/storage/storage"
import { Token } from "@/util/token"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import type { ModelMessage } from "ai"

export namespace SessionCPD {
  export const Data = z
    .object({
      text: z.string(),
      upto: Identifier.schema("message"),
      updated: z.number(),
    })
    .meta({
      ref: "SessionCPD",
    })
  export type Data = z.infer<typeof Data>

  const key = (sessionID: string) => ["cpd", sessionID]

  export async function get(sessionID: string) {
    return Storage.read<Data>(key(sessionID)).catch(() => undefined)
  }

  export async function clear(sessionID: string) {
    await Storage.remove(key(sessionID)).catch(() => {})
    await Session.update(sessionID, (draft) => {
      if (!draft.context) return
      draft.context.cpd = undefined
    })
  }

  export async function set(sessionID: string, input: { text: string; upto: string; updated?: number }) {
    const updated = input.updated ?? Date.now()
    const data: Data = {
      text: input.text,
      upto: Identifier.schema("message").parse(input.upto),
      updated,
    }
    await Storage.write(key(sessionID), data)

    const size = Token.estimate(input.text)
    await Session.update(sessionID, (draft) => {
      if (!draft.context) draft.context = {}
      draft.context.cpd = {
        updated,
        upto: data.upto,
        size,
      }
    })
  }

  export async function flag(sessionID: string, input: { trim?: boolean; think?: boolean; rctx?: boolean }) {
    await Session.update(sessionID, (draft) => {
      if (!draft.context) draft.context = {}
      if (input.trim !== undefined) draft.context.trim = input.trim
      if (input.think !== undefined) draft.context.think = input.think
      if (input.rctx !== undefined) draft.context.rctx = input.rctx
    })
  }

  export async function update(input: {
    sessionID: string
    model: { providerID: string; modelID: string }
    user: { sessionID: string; id: string; model: { providerID: string; modelID: string }; agent: string }
    tail: { request: string; flags: { trim: boolean; think: boolean; rctx: boolean } }
    reasoning?: ModelMessage
    existing?: string
    delta: string
    abort: AbortSignal
  }): Promise<{ text: string; rctx: boolean }> {
    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(input.model.providerID, input.model.modelID)

    const base: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "You are updating the Compacted Prefix Digest (CPD).",
              "",
              "Hard requirements:",
              "- Output ONLY the updated CPD.",
              "- Do NOT include chain-of-thought or hidden reasoning.",
              "- Do NOT call tools.",
              "",
              "The following Tail Snapshot is READ-ONLY context. Use it to decide what prefix info matters, but do not copy it verbatim into CPD unless necessary.",
              "",
              "<tail>",
              input.tail.request,
              "</tail>",
              "",
              "<flags>",
              `tool_outputs_trimmed: ${input.tail.flags.trim ? "true" : "false"}`,
              `reasoning_truncated: ${input.tail.flags.think ? "true" : "false"}`,
              `provider_rejected_reasoning_context: ${input.tail.flags.rctx ? "true" : "false"}`,
              "</flags>",
              "",
              input.existing ? ["<existing_cpd>", input.existing, "</existing_cpd>", ""].join("\n") : "",
              "<prefix_delta>",
              input.delta,
              "</prefix_delta>",
              "",
              "CPD format (use these headings):",
              "- Objective",
              "- Constraints",
              "- Decisions",
              "- Work",
              "- Facts",
              "- Next",
              "- Risks",
            ]
              .filter((x) => x)
              .join("\n"),
          },
        ],
      },
    ]

    const withReasoning = input.reasoning ? [base[0]!, input.reasoning] : base

    const run = async (messages: ModelMessage[]) => {
      const stream = await LLM.stream({
        user: {
          id: input.user.id,
          role: "user",
          sessionID: input.user.sessionID,
          agent: input.user.agent,
          model: input.user.model,
          time: { created: Date.now() },
        },
        sessionID: input.sessionID,
        model,
        agent,
        system: [],
        abort: input.abort,
        messages,
        tools: {},
        retries: 0,
      })

      let text = ""
      let rctx = false

      for await (const item of stream.fullStream) {
        if (item.type === ("stream-start" as any)) {
          const warnings = (item as { warnings?: unknown }).warnings
          if (Array.isArray(warnings)) {
            rctx = warnings.some((w) => {
              const msg = (w as { message?: unknown }).message
              if (typeof msg !== "string") return false
              return msg.includes("Dropped previous reasoning context after OpenAI rejected it")
            })
          }
        }

        if (item.type === "text-start") {
          text = ""
        }
        if (item.type === "text-delta") {
          text += item.text
        }
      }

      return { text: text.trim(), rctx }
    }

    const result = await run(withReasoning).catch((error) => {
      // If the provider rejects reasoning content in the prompt, retry without it.
      // We also mark rctx so the UI/model-visible banner can reflect the degradation.
      const msg = typeof (error as any)?.message === "string" ? String((error as any).message).toLowerCase() : ""
      const rejected = msg.includes("reasoning")
      return run(base).then((fallback) => {
        return {
          ...fallback,
          rctx: fallback.rctx || rejected,
        }
      })
    })
    return result
  }
}
