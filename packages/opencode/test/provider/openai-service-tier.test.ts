import { describe, expect, test } from "bun:test"
import {
  getOpenAIServiceTierSupport,
  sanitizeOpenAIServiceTier,
  supportsOpenAIFastMode,
} from "../../src/provider/openai/service-tier"

describe("OpenAI service tier helpers", () => {
  test("reports priority support for supported GPT-5 models", () => {
    expect(getOpenAIServiceTierSupport("gpt-5")).toEqual({
      flex: true,
      priority: true,
    })
    expect(getOpenAIServiceTierSupport("gpt-5-mini")).toEqual({
      flex: true,
      priority: true,
    })
  })

  test("reports missing priority support for unsupported models", () => {
    expect(getOpenAIServiceTierSupport("gpt-5-nano")).toEqual({
      flex: true,
      priority: false,
    })
    expect(getOpenAIServiceTierSupport("gpt-5-chat")).toEqual({
      flex: false,
      priority: false,
    })
  })

  test("sanitizes service tier based on provider family and model support", () => {
    expect(
      sanitizeOpenAIServiceTier(
        {
          api: {
            id: "gpt-5",
            npm: "@ai-sdk/openai",
          },
        } as any,
        "priority",
      ),
    ).toBe("priority")

    expect(
      sanitizeOpenAIServiceTier(
        {
          api: {
            id: "gpt-5-nano",
            npm: "@ai-sdk/openai",
          },
        } as any,
        "priority",
      ),
    ).toBeUndefined()

    expect(
      sanitizeOpenAIServiceTier(
        {
          api: {
            id: "gpt-5",
            npm: "@ai-sdk/anthropic",
          },
        } as any,
        "priority",
      ),
    ).toBeUndefined()

    expect(
      sanitizeOpenAIServiceTier(
        {
          api: {
            id: "gpt-5",
            npm: "@ai-sdk/openai",
          },
        } as any,
        "auto",
      ),
    ).toBe("auto")
  })

  test("reports fast mode availability for supported OpenAI-family models", () => {
    expect(
      supportsOpenAIFastMode({
        api: {
          id: "gpt-5",
          npm: "@ai-sdk/openai",
        },
      } as any),
    ).toBe(true)

    expect(
      supportsOpenAIFastMode({
        api: {
          id: "gpt-5-nano",
          npm: "@ai-sdk/openai",
        },
      } as any),
    ).toBe(false)

    expect(
      supportsOpenAIFastMode({
        api: {
          id: "gpt-5",
          npm: "@ai-sdk/anthropic",
        },
      } as any),
    ).toBe(false)
  })
})
