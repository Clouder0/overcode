import { describe, expect, test } from "bun:test"
import type { LanguageModelV2Prompt } from "@ai-sdk/provider"
import { convertToOpenAIResponsesInput } from "../../src/provider/sdk/openai-compatible/src/responses/convert-to-openai-responses-input"

describe("convertToOpenAIResponsesInput", () => {
  test("strips OpenAI item ids when store is false", async () => {
    const prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "hi",
            providerOptions: { openai: { itemId: "rs_text" } },
          },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "bash",
            input: { command: "echo hi" },
            providerExecuted: false,
            providerOptions: { openai: { itemId: "rs_tool" } },
          },
          {
            type: "reasoning",
            text: "r",
            providerOptions: { openai: { itemId: "rs_reason", reasoningEncryptedContent: "enc" } },
          },
        ],
      },
    ] as unknown as LanguageModelV2Prompt

    const { input } = await convertToOpenAIResponsesInput({
      prompt,
      systemMessageMode: "system",
      store: false,
      hasLocalShellTool: false,
    })

    const serialized = JSON.stringify(input)
    expect(serialized).not.toContain("rs_text")
    expect(serialized).not.toContain("rs_tool")
    expect(serialized).not.toContain("rs_reason")
    const hasItemReference = input.some(
      (x) => typeof x === "object" && x !== null && (x as { type?: string }).type === "item_reference",
    )
    expect(hasItemReference).toBe(false)
  })

  test("keeps item ids when store is true", async () => {
    const prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "hi",
            providerOptions: { openai: { itemId: "rs_text" } },
          },
        ],
      },
    ] as unknown as LanguageModelV2Prompt

    const { input } = await convertToOpenAIResponsesInput({
      prompt,
      systemMessageMode: "system",
      store: true,
      hasLocalShellTool: false,
    })

    expect(JSON.stringify(input)).toContain("rs_text")
  })
})
