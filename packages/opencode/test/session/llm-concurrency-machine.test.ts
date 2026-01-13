import path from "path"
import fs from "fs/promises"
import { expect, test } from "bun:test"
import { Global } from "../../src/global"
import { LLMConcurrencyMachine } from "../../src/session/llm-concurrency-machine"

function leaseDir() {
  return path.join(Global.Path.state, "llm-concurrency", "leases")
}

async function findLease(sessionID: string) {
  const dir = leaseDir()
  const entries = await fs.readdir(dir).catch(() => [] as string[])

  for (const name of entries) {
    if (!name.startsWith("lease_")) continue
    if (!name.endsWith(".json")) continue

    const filepath = path.join(dir, name)
    const data = await Bun.file(filepath)
      .json()
      .catch(() => undefined)

    if (!data || typeof data !== "object") continue

    const id = (data as { sessionID?: unknown }).sessionID
    if (id !== sessionID) continue

    return filepath
  }
}

async function waitFresh(file: string, staleMs: number, deadline: number): Promise<boolean> {
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat) return false

  const cutoff = Date.now() - staleMs
  if (stat.mtimeMs >= cutoff) return true

  if (Date.now() >= deadline) return false

  await Bun.sleep(25)
  return waitFresh(file, staleMs, deadline)
}

test("creates and releases global concurrency leases", async () => {
  const limits = LLMConcurrencyMachine.limits({
    experimental: {
      llmConcurrency: {
        global: {
          limits: {
            "*": 10,
          },
        },
      },
    },
  } as any)

  const sessionID = "ses_test_lease"

  const lease = await LLMConcurrencyMachine.enter({
    limits,
    providerID: "openai",
    modelName: "gpt-5",
    sessionID,
  })
  expect(lease).toBeDefined()

  const file = await findLease(sessionID)
  expect(file).toBeDefined()

  await lease?.release()

  const exists = await fs
    .stat(file!)
    .then(() => true)
    .catch(() => false)
  expect(exists).toBe(false)
})

test("snapshot prunes stale leases by mtime", async () => {
  const limits = LLMConcurrencyMachine.limits({
    experimental: {
      llmConcurrency: {
        global: {
          limits: {
            "*": 10,
          },
          staleMs: 1000,
        },
      },
    },
  } as any)

  if (!limits) {
    throw new Error("expected global limits")
  }

  const dir = leaseDir()
  await fs.mkdir(dir, { recursive: true })

  const name = `lease_manual_${process.pid}_${Date.now()}.json`
  const file = path.join(dir, name)

  await fs.writeFile(
    file,
    JSON.stringify({
      providerID: "openai",
      modelName: "gpt-5",
      sessionID: "ses_test_stale",
      pid: process.pid,
      startedAt: Date.now(),
    }),
    { flag: "wx" },
  )

  const now = new Date()
  const old = new Date(now.getTime() - 10_000)
  await fs.utimes(file, old, old)

  await LLMConcurrencyMachine.snapshot(limits)

  const exists = await fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
  expect(exists).toBe(false)
})

test("heartbeat refresh prevents false-stale pruning", async () => {
  const limits = LLMConcurrencyMachine.limits({
    experimental: {
      llmConcurrency: {
        global: {
          limits: {
            "*": 10,
            "openai/*": 10,
            "openai/gpt-5": 10,
          },
          staleMs: 1000,
        },
      },
    },
  } as any)

  if (!limits) {
    throw new Error("expected global limits")
  }

  const sessionID = "ses_test_heartbeat"

  const lease = await LLMConcurrencyMachine.enter({
    limits,
    providerID: "openai",
    modelName: "gpt-5",
    sessionID,
  })
  expect(lease).toBeDefined()

  try {
    const file = await findLease(sessionID)
    expect(file).toBeDefined()

    const now = new Date()
    const old = new Date(now.getTime() - 10_000)
    await fs.utimes(file!, old, old)

    const ok = await waitFresh(file!, limits.staleMs, Date.now() + limits.staleMs * 5)
    expect(ok).toBe(true)

    await LLMConcurrencyMachine.snapshot(limits)

    const exists = await fs
      .stat(file!)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  } finally {
    await lease?.release()
  }
})
