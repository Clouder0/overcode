import path from "path"
import fs from "fs/promises"
import { randomUUID } from "crypto"
import { Global } from "@/global"
import { Log } from "@/util/log"
import type { Config } from "@/config/config"

export namespace LLMConcurrencyMachine {
  const log = Log.create({ service: "llm.concurrency.global" })

  const ROOT = path.join(Global.Path.state, "llm-concurrency")
  const LEASES = path.join(ROOT, "leases")
  const DEFAULT_STALE_MS = 15 * 60 * 1000

  export type Rule = {
    pattern: string
    limit: number
    match: (key: string) => boolean
    all: boolean
  }

  export type Limits = {
    staleMs: number
    rules: Rule[]
  }

  export type Snapshot = {
    total: number
    counts: Record<string, number>
  }

  export type Lease = {
    release: () => Promise<void>
  }

  export function limits(cfg: Config.Info): Limits | undefined {
    const llm = cfg.experimental?.llmConcurrency
    if (!llm) return

    const global = llm.global
    if (!global?.limits) return

    const entries = Object.entries(global.limits)
    if (entries.length === 0) return

    const rules = entries.map(([pattern, limit]) => compile({ pattern, limit }))

    const staleMs = global.staleMs ?? DEFAULT_STALE_MS
    return {
      staleMs,
      rules,
    }
  }

  export function limitMap(limits: Limits) {
    return limits.rules.reduce(
      (acc, rule) => {
        acc[rule.pattern] = rule.limit
        return acc
      },
      {} as Record<string, number>,
    )
  }

  export function bucketKey(input: { providerID: string; modelName: string }) {
    return input.providerID + "/" + input.modelName
  }

  export async function enter(input: {
    limits: Limits | undefined
    providerID: string
    modelName: string
    sessionID: string
  }): Promise<Lease | undefined> {
    const limits = input.limits
    if (!limits) return

    const filepath = await createLease({
      providerID: input.providerID,
      modelName: input.modelName,
      sessionID: input.sessionID,
    }).catch((error) => {
      log.warn("failed to create lease", { error })
      return undefined
    })

    if (!filepath) return

    const beat = Math.floor(limits.staleMs * 0.8)

    const timer =
      beat > 0 && beat < limits.staleMs
        ? setInterval(() => {
            const now = new Date()
            fs.utimes(filepath, now, now).catch(() => {})
          }, beat)
        : undefined

    timer?.unref?.()

    return {
      release: async () => {
        if (timer) clearInterval(timer)
        await fs.unlink(filepath).catch(() => {})
      },
    }
  }

  export async function snapshot(limits: Limits): Promise<Snapshot> {
    const cutoff = Date.now() - limits.staleMs
    const rules = limits.rules

    const entries = await fs.readdir(LEASES).catch(() => [] as string[])

    const result: Snapshot = {
      total: 0,
      counts: {},
    }

    const anyRulesNeedKey = rules.some((rule) => !rule.all)
    for (const name of entries) {
      if (!name.startsWith("lease_")) continue
      if (!name.endsWith(".json")) continue

      const filepath = path.join(LEASES, name)
      const stat = await fs.stat(filepath).catch(() => undefined)
      if (!stat) continue
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(filepath).catch(() => {})
        continue
      }

      result.total += 1
      if (!anyRulesNeedKey) continue

      const data = await Bun.file(filepath)
        .json()
        .catch(() => undefined)
      if (!data || typeof data !== "object") continue

      const providerID = (data as { providerID?: unknown }).providerID
      const modelName =
        (data as { modelName?: unknown; modelID?: unknown }).modelName ??
        (data as { modelName?: unknown; modelID?: unknown }).modelID

      if (typeof providerID !== "string") continue
      if (typeof modelName !== "string") continue

      const key = bucketKey({ providerID, modelName })
      for (const rule of rules) {
        if (rule.all) continue
        if (!rule.match(key)) continue
        result.counts[rule.pattern] = (result.counts[rule.pattern] ?? 0) + 1
      }
    }

    for (const rule of rules) {
      if (!rule.all) continue
      result.counts[rule.pattern] = result.total
    }

    return result
  }

  export function request(limits: Limits, keys: string[]): Snapshot {
    const result: Snapshot = {
      total: keys.length,
      counts: {},
    }

    for (const rule of limits.rules) {
      if (!rule.all) continue
      result.counts[rule.pattern] = keys.length
    }

    const rules = limits.rules.filter((rule) => !rule.all)
    if (rules.length === 0) return result

    for (const key of keys) {
      for (const rule of rules) {
        if (!rule.match(key)) continue
        result.counts[rule.pattern] = (result.counts[rule.pattern] ?? 0) + 1
      }
    }

    return result
  }

  export function blocked(limits: Limits, current: Snapshot, request: Snapshot) {
    const blocks: string[] = []

    for (const rule of limits.rules) {
      const cur = current.counts[rule.pattern] ?? (rule.all ? current.total : 0)
      const req = request.counts[rule.pattern] ?? (rule.all ? request.total : 0)
      if (cur + req <= rule.limit) continue
      blocks.push(rule.pattern)
    }

    return blocks
  }

  function compile(input: { pattern: string; limit: number }): Rule {
    const pattern = input.pattern
    const limit = input.limit

    if (pattern === "*") {
      return {
        pattern,
        limit,
        all: true,
        match: (_key) => true,
      }
    }

    if (pattern.startsWith("re:")) {
      const source = pattern.slice("re:".length)
      const regex = (() => {
        try {
          return new RegExp(source)
        } catch (error) {
          throw new Error(`Invalid regex in llmConcurrency.global.limits: ${pattern}. ${String(error)}`)
        }
      })()

      return {
        pattern,
        limit,
        all: false,
        match: (key) => regex.test(key),
      }
    }

    const regex = glob(pattern)

    return {
      pattern,
      limit,
      all: false,
      match: (key) => regex.test(key),
    }
  }

  function glob(input: string) {
    const special = new Set(["\\", "^", "$", ".", "+", "(", ")", "|", "[", "]", "{", "}"])
    const parts: string[] = ["^"]

    for (const char of input) {
      if (char === "*") {
        parts.push(".*")
        continue
      }
      if (char === "?") {
        parts.push(".")
        continue
      }
      if (special.has(char)) {
        parts.push("\\" + char)
        continue
      }
      parts.push(char)
    }

    parts.push("$")
    return new RegExp(parts.join(""))
  }

  async function createLease(input: { providerID: string; modelName: string; sessionID: string }) {
    await fs.mkdir(LEASES, { recursive: true })

    const id = randomUUID()
    const filepath = path.join(LEASES, `lease_${process.pid}_${id}.json`)
    const body = {
      providerID: input.providerID,
      modelName: input.modelName,
      sessionID: input.sessionID,
      pid: process.pid,
      startedAt: Date.now(),
    }
    await fs.writeFile(filepath, JSON.stringify(body), { flag: "wx" })
    return filepath
  }
}
