import { test, expect } from "bun:test"

const coerce = (value: unknown) => value as unknown as any

import { ClaudeCode } from "../../src/provider/claude-code"

test("ClaudeCode.url appends beta=true for messages endpoints", () => {
  expect(ClaudeCode.url("https://api.anthropic.com/v1/messages")).toBe(
    "https://api.anthropic.com/v1/messages?beta=true",
  )
  expect(ClaudeCode.url("https://api.anthropic.com/v1/messages?foo=bar")).toBe(
    "https://api.anthropic.com/v1/messages?foo=bar&beta=true",
  )
  expect(ClaudeCode.url("https://api.anthropic.com/v1/messages/count_tokens")).toBe(
    "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
  )
  expect(ClaudeCode.url("https://api.anthropic.com/v1/complete")).toBe("https://api.anthropic.com/v1/complete")
})

test("ClaudeCode.defaults includes Claude Code header fingerprints", () => {
  const headers = ClaudeCode.defaults()

  expect(headers["x-app"]).toBe("cli")
  expect(headers["user-agent"]).toMatch(/^claude-cli\/\d+\.\d+\.\d+/)
  expect(headers["user-agent"]).toContain("(external, cli)")
  expect(headers["anthropic-version"]).toBe("2023-06-01")
  expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true")

  expect(headers["x-stainless-lang"]).toBe("js")
  expect(headers["x-stainless-runtime"]).toBe("node")
  expect(headers["x-stainless-package-version"]).toBe("0.70.0")
  expect(headers["x-stainless-retry-count"]).toBe("0")
  expect(headers["x-stainless-timeout"]).toBe("600")

  expect(headers["anthropic-beta"]).toContain("claude-code-20250219")
})

test("ClaudeCode.metadataUserId returns Claude Code-shaped user id", async () => {
  const id = await ClaudeCode.metadataUserId()
  expect(id).toMatch(
    /^user_[0-9a-f]{64}_account__session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  )
})

test("ClaudeCode.transform only rewrites body for messages endpoints", async () => {
  const base = {
    model: { api: { npm: "@ai-sdk/anthropic" }, providerID: "anthropic" },
    request: {
      input: "https://api.anthropic.com/v1/complete",
      init: {
        method: "POST",
        headers: { "x-api-key": "test" },
        body: JSON.stringify({ system: "hello" }),
      },
    },
  }

  const out = await ClaudeCode.transform(coerce(base))
  expect(out.input).toBe("https://api.anthropic.com/v1/complete")

  const body = JSON.parse(String(out.init.body)) as any
  expect(body.system).toBe("hello")
  expect(body.metadata).toBeUndefined()
})

test("ClaudeCode.transform canonicalizes system blocks and injects metadata", async () => {
  const out = await ClaudeCode.transform({
    model: { api: { npm: "@ai-sdk/anthropic" }, providerID: "anthropic" },
    request: {
      input: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
        headers: { "x-api-key": "test" },
        body: JSON.stringify({
          system: ["x-anthropic-billing-header: test", "Some other system"],
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }),
      },
    },
  } as unknown as any)

  expect(String(out.input)).toContain("/v1/messages")
  expect(String(out.input)).toContain("beta=true")

  const body = JSON.parse(String(out.init.body)) as any
  expect(Array.isArray(body.system)).toBe(true)
  expect(body.system[0].text).toContain("x-anthropic-billing-header")
  expect(body.system.some((b: any) => typeof b.text === "string" && b.text.includes("You are Claude Code"))).toBe(true)
  expect(body.metadata?.user_id).toMatch(/^user_[0-9a-f]{64}_account__session_/i)

  // cache_control is no longer injected at the body layer.
  const cc = [
    ...(body.system ?? []).map((b: any) => b.cache_control).filter(Boolean),
    ...(body.messages ?? [])
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .map((b: any) => b.cache_control)
      .filter(Boolean),
  ]
  expect(cc.length).toBe(0)
})

test("ClaudeCode.transform does not inject cache_control into message content blocks", async () => {
  const out = await ClaudeCode.transform({
    model: { api: { npm: "@ai-sdk/anthropic" }, providerID: "anthropic" },
    request: {
      input: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
        headers: { "x-api-key": "test" },
        body: JSON.stringify({
          system: ["x-anthropic-billing-header: test", "Some other system"],
          messages: [
            { role: "user", content: [{ type: "text", text: "hi" }] },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "x", signature: "sig" },
                { type: "text", text: "ok" },
              ],
            },
          ],
        }),
      },
    },
  } as unknown as any)

  const body = JSON.parse(String(out.init.body)) as any
  const blocks = (body.messages?.[1]?.content ?? []) as any[]

  expect(blocks[0].type).toBe("thinking")
  expect(blocks[0].cache_control).toBeUndefined()
  expect(blocks[1].type).toBe("text")
  expect(blocks[1].cache_control).toBeUndefined()
})
