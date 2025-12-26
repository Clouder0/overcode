// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import fsSync from "fs"
import { afterAll } from "bun:test"

const dir = path.join(os.tmpdir(), "opencode-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })

const home = path.join(dir, "home")
await fs.mkdir(home, { recursive: true })
process.env["HOME"] = home

afterAll(() => {
  fsSync.rmSync(dir, { recursive: true, force: true })
})
process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")

// Avoid loading/installing default plugins during tests.
process.env["OPENCODE_DISABLE_DEFAULT_PLUGINS"] = "true"

// Pre-populate models.json so tests don't depend on network.
// Also write the cache version file to prevent global/index.ts from clearing the cache.
const cacheDir = path.join(dir, "cache", "opencode")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "14")

const modelsDevFixture = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    api: "https://api.anthropic.com/v1",
    npm: "@ai-sdk/anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-sonnet-4-20250514": {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        release_date: "2025-05-14",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 8192 },
        modalities: { input: ["text"], output: ["text"] },
        options: {},
      },
      "claude-3-5-haiku-20241022": {
        id: "claude-3-5-haiku-20241022",
        name: "Claude 3.5 Haiku",
        release_date: "2024-10-22",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 8192 },
        modalities: { input: ["text"], output: ["text"] },
        options: {},
      },
    },
    options: {},
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    api: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
    env: ["OPENAI_API_KEY"],
    models: {
      "gpt-4": {
        id: "gpt-4",
        name: "GPT-4",
        release_date: "2024-01-01",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 4096 },
        modalities: { input: ["text"], output: ["text"] },
        options: {},
      },
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        release_date: "2025-01-01",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 256000, output: 8192 },
        modalities: { input: ["text"], output: ["text"] },
        options: {},
      },
    },
    options: {},
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    api: "https://openrouter.ai/api/v1",
    npm: "@openrouter/ai-sdk-provider",
    env: ["OPENROUTER_API_KEY"],
    models: {
      "anthropic/claude-3-opus": {
        id: "anthropic/claude-3-opus",
        name: "Claude 3 Opus (OpenRouter)",
        release_date: "2024-03-01",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 8192 },
        modalities: { input: ["text"], output: ["text"] },
        options: {},
      },
    },
    options: {},
  },
}

await fs.writeFile(path.join(cacheDir, "models.json"), JSON.stringify(modelsDevFixture))
// Disable models.dev refresh to avoid race conditions during tests
process.env["OPENCODE_DISABLE_MODELS_FETCH"] = "true"

// Clear provider env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]

// Now safe to import from src/
const { Log } = await import("../src/util/log")

Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})

// Job tests frequently run Subagent jobs which call SessionPrompt.prompt.
// Patch SessionPrompt to avoid hitting real providers/network when job bridge tools are present.
const jobPromptState = new Map<string, "pending" | "canceled">()
const jobSessionTools: Record<string, Record<string, any>> = {}

function marker(text: string, re: RegExp): string | undefined {
  const match = text.match(re)
  if (!match) return
  return match[1]
}

function delayMs(text: string, interactive: boolean): number {
  const slow = marker(text, /\[slow-response:(\d+)\]/)
  if (slow) return parseInt(slow, 10)

  const delay = marker(text, /\[delay:(\d+)\]/)
  if (delay) return parseInt(delay, 10)

  if (interactive) return 75
  return 0
}

function responseText(text: string): string {
  const long = marker(text, /\[long-response:(\d+)\]/)
  if (long) return "x".repeat(parseInt(long, 10))
  if (text.includes("[empty-response]")) return ""

  const final = marker(text, /\[final:([^\]]+)\]/)
  if (final) return final

  return text || "stub response"
}

const { SessionPrompt } = await import("../src/session/prompt")
const sessionPrompt = SessionPrompt as any

const originalPrompt = sessionPrompt.prompt
const originalCancel = sessionPrompt.cancel
const originalSetExtraTools = sessionPrompt.setExtraTools
const originalClearExtraTools = sessionPrompt.clearExtraTools

// Avoid accidental LLM/network usage in tests. JobNotification.init also tries
// to auto-trigger SessionPrompt.loop; for tests we prefer notifications to remain queued.
sessionPrompt.loop = async () => {
  throw new Error("SessionPrompt.loop disabled in tests")
}

sessionPrompt.setExtraTools = (sessionID: string, tools: any[]) => {
  originalSetExtraTools(sessionID, tools)

  const toolMap: Record<string, any> = {}
  for (const t of tools ?? []) {
    if (!t?.id) continue
    toolMap[t.id] = t
  }

  if (toolMap["job_complete"] || toolMap["job_fail"] || toolMap["job_notify"]) {
    jobSessionTools[sessionID] = toolMap
  }
}

sessionPrompt.clearExtraTools = (sessionID: string) => {
  originalClearExtraTools(sessionID)
  delete jobSessionTools[sessionID]
  jobPromptState.delete(sessionID)
}

sessionPrompt.cancel = (sessionID: string) => {
  if (jobSessionTools[sessionID]) {
    jobPromptState.set(sessionID, "canceled")
  }
  return originalCancel(sessionID)
}

sessionPrompt.prompt = async (input: any) => {
  const sessionID = input?.sessionID
  const tools = sessionID ? jobSessionTools[sessionID] : undefined
  if (!tools || input?.noReply === true) {
    return originalPrompt(input)
  }

  jobPromptState.set(sessionID, "pending")

  const parts = Array.isArray(input.parts) ? input.parts : []
  const text = parts
    .filter((p: { type?: string; text?: unknown }) => p?.type === "text")
    .map((p: { text?: unknown }) => String(p.text ?? ""))
    .join("\n")

  const g = globalThis as any
  if (!g.__OPENCODE_TEST_SESSION_PROMPTS__) {
    g.__OPENCODE_TEST_SESSION_PROMPTS__ = {}
  }
  const promptLog = g.__OPENCODE_TEST_SESSION_PROMPTS__ as Record<string, string[] | undefined>
  const items = promptLog[sessionID] ?? []
  items.push(text)
  promptLog[sessionID] = items

  const ask = text.includes("[ask]")
  const ask2 = text.includes("[ask2]")
  const interactive = ask || ask2

  const waitMs = delayMs(text, interactive)
  const start = Date.now()
  while (Date.now() - start < waitMs) {
    if (jobPromptState.get(sessionID) === "canceled") {
      throw new Error("prompt canceled")
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  if (jobPromptState.get(sessionID) === "canceled") {
    throw new Error("prompt canceled")
  }

  if (text.includes("[force-error]")) {
    const failInfo = tools.job_fail
    if (failInfo) {
      const failTool = await failInfo.init()
      await failTool
        .execute(
          { error: "forced error for test" },
          {
            sessionID,
            messageID: "msg_stub",
            agent: input.agent,
            abort: new AbortController().signal,
            callID: "call_fail",
            metadata: () => {},
          },
        )
        .catch(() => {})
    }
    throw new Error("forced error for test")
  }

  if (interactive) {
    const notifyInfo = tools.job_notify
    if (notifyInfo) {
      const tool = await notifyInfo.init()
      const ctx = {
        sessionID,
        messageID: "msg_stub",
        agent: input.agent,
        abort: new AbortController().signal,
        callID: "call_notify_1",
        metadata: () => {},
      }
      await tool.execute({ output: { type: "question", text: ask2 ? "Need input 1" : "Need input" } }, ctx)

      if (ask2) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        await tool.execute({ output: { type: "question", text: "Need input 2" } }, { ...ctx, callID: "call_notify_2" })
      }
    }

    const now = Date.now()
    return {
      info: {
        id: input.messageID ?? "msg_stub",
        role: "assistant",
        sessionID,
        time: { created: now, completed: now },
        agent: input.agent,
        modelID: input.model?.modelID ?? "test-model",
        providerID: input.model?.providerID ?? "test-provider",
      },
      parts: [
        {
          id: "prt_stub",
          sessionID,
          messageID: input.messageID ?? "msg_stub",
          type: "text",
          text: "asking",
        },
      ],
    }
  }

  const textOut = responseText(text)
  const noComplete = text.includes("[no-complete]")

  const completeInfo = tools.job_complete
  if (completeInfo && !noComplete) {
    setTimeout(() => {
      if (jobPromptState.get(sessionID) === "canceled") return
      void completeInfo
        .init()
        .then((tool: any) =>
          tool.execute(
            { output: { type: "result", text: textOut || "Task completed" } },
            {
              sessionID,
              messageID: "msg_stub",
              agent: input.agent,
              abort: new AbortController().signal,
              callID: "call_complete",
              metadata: () => {},
            },
          ),
        )
        .catch(() => {})
    }, 10)
  }

  const now = Date.now()
  return {
    info: {
      id: input.messageID ?? "msg_stub",
      role: "assistant",
      sessionID,
      time: { created: now, completed: now },
      agent: input.agent,
      modelID: input.model?.modelID ?? "test-model",
      providerID: input.model?.providerID ?? "test-provider",
    },
    parts: [
      {
        id: "prt_stub",
        sessionID,
        messageID: input.messageID ?? "msg_stub",
        type: "text",
        text: textOut,
      },
    ],
  }
}
