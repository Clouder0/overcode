import os from "os"
import path from "path"
import fs from "fs/promises"
import { randomBytes, randomUUID } from "crypto"
import { Global } from "../global"
import { ProviderRequestContext } from "./request-context"

export namespace ClaudeCode {
  export const Identity = "You are Claude Code, Anthropic's official CLI for Claude."
  export const IdentitySDK =
    "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
  export const IdentityAgent = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

  const USER_AGENT = "claude-cli/2.1.5 (external, repl_main_thread)"
  const STAINLESS_PKG_VERSION = "0.70.0"
  const STAINLESS_RUNTIME_VERSION = "v20.0.0"

  const USER_ID_RE = /^[0-9a-f]{64}$/

  // Stable per-machine id (best-effort persisted), and per-session uuid mapping.
  const state = {
    user: undefined as Promise<string> | undefined,
    fallback: undefined as string | undefined,
    sessions: new Map<string, string>(),
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }

  function isTextBlock(value: unknown): value is { type?: unknown; text?: unknown; cache_control?: unknown } {
    return isRecord(value)
  }

  function platform() {
    const p = os.platform()
    if (p === "win32") return "Windows"
    if (p === "darwin") return "Darwin"
    return "Linux"
  }

  function arch() {
    const a = os.arch()
    if (a === "x64") return "x64"
    if (a === "arm64") return "arm64"
    return a
  }

  function isMessagesPath(pathname: string) {
    return pathname.endsWith("/v1/messages") || pathname.endsWith("/v1/messages/count_tokens")
  }

  export function isMessagesEndpoint(input: unknown) {
    const raw = (() => {
      if (typeof input === "string") return input
      if (input instanceof URL) return input.toString()
      if (input instanceof Request) return input.url
      return undefined
    })()

    if (!raw) return false

    const url = new URL(raw)
    return isMessagesPath(url.pathname)
  }

  export function url(input: unknown) {
    const raw = (() => {
      if (typeof input === "string") return input
      if (input instanceof URL) return input.toString()
      if (input instanceof Request) return input.url
      return undefined
    })()

    if (!raw) return input

    const next = new URL(raw)
    if (!isMessagesPath(next.pathname)) return input
    if (!next.searchParams.has("beta")) next.searchParams.set("beta", "true")

    if (input instanceof URL) return next
    if (input instanceof Request) return new Request(next, input)
    return next.toString()
  }

  export function helper(body: unknown) {
    if (!isRecord(body)) return {}

    return {
      ...(body["stream"] === true ? { "x-stainless-helper-method": "stream" } : {}),
      ...(Array.isArray(body["tools"]) && body["tools"].length > 0 ? { "x-stainless-helper": "BetaToolRunner" } : {}),
    }
  }

  export function defaults() {
    return {
      accept: "application/json",
      "content-type": "application/json",
      "x-app": "cli",
      "user-agent": USER_AGENT,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-stainless-lang": "js",
      "x-stainless-package-version": STAINLESS_PKG_VERSION,
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": STAINLESS_RUNTIME_VERSION,
      "x-stainless-os": platform(),
      "x-stainless-arch": arch(),
      "x-stainless-retry-count": "0",
      "x-stainless-timeout": "600",
      "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
      ...(process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION ? { "x-anthropic-additional-protection": "true" } : {}),
    }
  }

  function normalizeHeaderKey(key: string) {
    return key.trim().toLowerCase()
  }

  export function parseCustomHeaders(value?: string) {
    if (!value) return {}
    const out: Record<string, string> = {}

    for (const line of value.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const idx = trimmed.indexOf(":")
      if (idx <= 0) continue

      const key = normalizeHeaderKey(trimmed.slice(0, idx))
      const v = trimmed.slice(idx + 1).trim()
      if (!key || !v) continue

      // Don't allow this escape hatch to clobber auth.
      if (key === "authorization" || key === "x-api-key") continue

      out[key] = v
    }

    return out
  }

  export function customHeaders() {
    return parseCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS)
  }

  export function parseBody(body: unknown): Record<string, unknown> | undefined {
    if (typeof body !== "string") return
    const trimmed = body.trim()
    if (!trimmed) return

    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (!isRecord(parsed)) return
      return parsed
    } catch {
      return
    }
  }

  // Prefer state dir (less likely to be locked down than config).
  const filepath = path.join(Global.Path.state, "claude-code.json")

  async function loadUserID() {
    const stored = await Bun.file(filepath)
      .json()
      .catch(() => undefined)
      .then((data) => {
        if (!isRecord(data)) return undefined
        const id = data["userIDHex64"]
        if (typeof id !== "string") return undefined
        if (!USER_ID_RE.test(id)) return undefined
        return id
      })

    if (stored) return stored

    const next = randomBytes(32).toString("hex")
    await Bun.write(filepath, JSON.stringify({ userIDHex64: next }, null, 2))
    await fs.chmod(filepath, 0o600).catch(() => {})
    return next
  }

  export async function userID() {
    if (state.user) return state.user

    state.user = loadUserID().catch(() => {
      state.user = undefined
      const fallback = state.fallback ?? randomBytes(32).toString("hex")
      state.fallback = fallback
      return fallback
    })

    return state.user
  }

  function sessionID() {
    const ctx = ProviderRequestContext.get()
    if (!ctx) return "process"
    return ctx.sessionID
  }

  function sessionUUID() {
    const key = sessionID()
    const existing = state.sessions.get(key)
    if (existing) return existing

    const next = randomUUID()
    state.sessions.set(key, next)
    return next
  }

  export async function metadataUserId() {
    const user = await userID()
    const session = sessionUUID()
    return `user_${user}_account__session_${session}`
  }

  export function canonicalizeSystem(existing: unknown) {
    const identities = [Identity, IdentitySDK, IdentityAgent]

    const strings: string[] = []
    const blocks: Array<{ type: "text"; text: string }> = []

    const push = (text: string) => {
      const t = text.trim()
      if (!t) return
      strings.push(t)
    }

    if (typeof existing === "string") push(existing)

    if (Array.isArray(existing)) {
      for (const x of existing) {
        if (typeof x === "string") {
          push(x)
          continue
        }
        if (isTextBlock(x)) {
          const text = x.text
          if (typeof text === "string") push(text)
        }
      }
    }

    const billing = strings.find((t) => t.startsWith("x-anthropic-billing-header"))
    const remainder = strings.filter((t) => t !== billing)

    const identity = identities.find((id) => remainder.some((t) => t.includes(id))) ?? Identity

    const withoutIdentity = remainder
      .map((t) => {
        const stripped = identities.reduce((acc, id) => acc.split(id).join(""), t)
        return stripped.trim()
      })
      .filter(Boolean)

    const joined = withoutIdentity.join("\n").trim()

    if (billing) blocks.push({ type: "text", text: billing })
    blocks.push({ type: "text", text: identity })
    if (joined) blocks.push({ type: "text", text: joined })

    return blocks
  }

  // NOTE: Do not inject body-level `cache_control`.
  // The Anthropic SDK enforces strict rules (e.g. thinking blocks are not cacheable)
  // and caps breakpoints. We apply caching via providerOptions in ProviderTransform.

  export async function transform(input: {
    model: { api: { npm: string }; providerID: string }
    request: { input: any; init?: BunFetchRequestInit }
  }): Promise<{ input: any; init: BunFetchRequestInit }> {
    const model = input.model
    const shouldShape = model.api.npm === "@ai-sdk/anthropic" && model.providerID !== "google-vertex-anthropic"

    if (!shouldShape) {
      return {
        input: input.request.input,
        init: input.request.init ?? {},
      }
    }

    const nextInput = url(input.request.input)
    const endpoint = isMessagesEndpoint(nextInput)

    const init = input.request.init ?? {}

    const headers = new Headers(init.headers)
    const auth = {
      authorization: headers.get("authorization") ?? undefined,
      apiKey: headers.get("x-api-key") ?? undefined,
    }

    // Apply defaults + escape hatch (case-insensitive, auth-protected).
    for (const [k, v] of Object.entries(defaults())) headers.set(k, v)
    for (const [k, v] of Object.entries(customHeaders())) headers.set(k, v)

    if (auth.authorization) headers.set("authorization", auth.authorization)
    if (auth.apiKey) headers.set("x-api-key", auth.apiKey)

    if (!endpoint) {
      return {
        input: nextInput,
        init: {
          ...init,
          headers,
        },
      }
    }

    const body = parseBody(init.body)
    if (!body) {
      return {
        input: nextInput,
        init: {
          ...init,
          headers,
        },
      }
    }

    body.metadata = (() => {
      const existing = body.metadata
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        if (typeof (existing as { user_id?: unknown }).user_id === "string") return existing
        return { ...existing, user_id: "" }
      }
      return {}
    })()

    const id = await metadataUserId()
    ;(body.metadata as { user_id?: unknown }).user_id = id

    body.system = canonicalizeSystem(body.system)

    // IMPORTANT: do not inject `cache_control` at the body layer.
    // It can invalidate requests when the prompt contains thinking blocks.

    for (const [k, v] of Object.entries(helper(body))) headers.set(k, v)

    return {
      input: nextInput,
      init: {
        ...init,
        headers,
        body: JSON.stringify(body),
      },
    }
  }
}
