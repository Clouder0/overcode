import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { LSPClient } from "./client"
import path from "path"
import { pathToFileURL } from "url"
import { LSPServer } from "./server"
import z from "zod"
import { Config } from "../config/config"
import { spawn } from "child_process"
import { Instance } from "../project/instance"
import { Flag } from "@/flag/flag"
import { key as cacheKey } from "./key"
import * as Cache from "./cache"
import { SessionStatus } from "@/session/status"

export namespace LSP {
  const log = Log.create({ service: "lsp" })

  const DEFAULT_IDLE_MS = 600_000
  const DEFAULT_PROTECTED_RATIO = 0.8

  export const Event = {
    Updated: BusEvent.define("lsp.updated", z.object({})),
  }

  export const Range = z
    .object({
      start: z.object({
        line: z.number(),
        character: z.number(),
      }),
      end: z.object({
        line: z.number(),
        character: z.number(),
      }),
    })
    .meta({
      ref: "Range",
    })
  export type Range = z.infer<typeof Range>

  export const WorkspaceSymbol = z
    .object({
      name: z.string(),
      kind: z.number(),
      location: z.object({
        uri: z.string(),
        range: Range,
      }),
    })
    .meta({
      ref: "Symbol",
    })
  export type WorkspaceSymbol = z.infer<typeof WorkspaceSymbol>

  export const DocumentSymbol = z
    .object({
      name: z.string(),
      detail: z.string().optional(),
      kind: z.number(),
      range: Range,
      selectionRange: Range,
    })
    .meta({
      ref: "DocumentSymbol",
    })
  export type DocumentSymbol = z.infer<typeof DocumentSymbol>

  const filterExperimentalServers = (servers: Record<string, LSPServer.Info>) => {
    if (Flag.OPENCODE_EXPERIMENTAL_LSP_TY) {
      // If experimental flag is enabled, disable pyright
      if (servers["pyright"]) {
        log.info("LSP server pyright is disabled because OPENCODE_EXPERIMENTAL_LSP_TY is enabled")
        delete servers["pyright"]
      }
    } else {
      // If experimental flag is disabled, disable ty
      if (servers["ty"]) {
        delete servers["ty"]
      }
    }
  }

  const state = Instance.state(
    async () => {
      const cfg = await Config.get()
      const cacheCfg = cfg.experimental?.lsp
      const maxServers = cacheCfg?.maxServers ?? Number.POSITIVE_INFINITY
      const idleMs = cacheCfg?.idleMs ?? DEFAULT_IDLE_MS
      const protectedRatio = cacheCfg?.protectedRatio ?? DEFAULT_PROTECTED_RATIO
      const protectedMax = cacheCfg?.maxServers
        ? Math.max(1, Math.min(maxServers, Math.floor(maxServers * protectedRatio)))
        : Number.POSITIVE_INFINITY
      const cache = Cache.create<LSPClient.Info>({ max: maxServers, protectedMax })

      const servers: Record<string, LSPServer.Info> = {}

      const interval = Math.max(1000, Math.min(30_000, Math.floor(idleMs / 2)))

      if (cfg.lsp === false) {
        log.info("all LSPs are disabled")
        return {
          closing: false,
          trim: false,
          broken: new Set<string>(),
          servers,
          cache,
          idleMs,
          spawning: new Map<string, Promise<Cache.Entry<LSPClient.Info> | undefined>>(),
          timer: undefined as ReturnType<typeof setInterval> | undefined,
        }
      }

      for (const server of Object.values(LSPServer)) {
        servers[server.id] = server
      }

      filterExperimentalServers(servers)

      for (const [name, item] of Object.entries(cfg.lsp ?? {})) {
        const existing = servers[name]
        if (item.disabled) {
          log.info(`LSP server ${name} is disabled`)
          delete servers[name]
          continue
        }
        servers[name] = {
          ...existing,
          id: name,
          root: existing?.root ?? (async () => Instance.directory),
          extensions: item.extensions ?? existing?.extensions ?? [],
          spawn: async (root) => {
            return {
              process: spawn(item.command[0], item.command.slice(1), {
                cwd: root,
                env: {
                  ...process.env,
                  ...item.env,
                },
              }),
              initialization: item.initialization,
            }
          },
        }
      }

      log.info("enabled LSP servers", {
        serverIds: Object.values(servers)
          .map((server) => server.id)
          .join(", "),
      })

      const directory = Instance.directory
      const entry = {
        closing: false,
        trim: false,
        broken: new Set<string>(),
        servers,
        cache,
        idleMs,
        spawning: new Map<string, Promise<Cache.Entry<LSPClient.Info> | undefined>>(),
        timer: undefined as ReturnType<typeof setInterval> | undefined,
      }

      entry.timer = setInterval(() => {
        Instance.provide({
          directory,
          fn: () => prune(entry),
        }).catch(() => {})
      }, interval)
      entry.timer.unref()

      return entry
    },
    async (state) => {
      state.closing = true
      if (state.timer) {
        clearInterval(state.timer)
        state.timer = undefined
      }
      const entries = Cache.all(state.cache)
      await Promise.all(entries.map((entry) => entry.value.shutdown().catch(() => {})))
    },
  )

  async function prune(s: Awaited<ReturnType<typeof state>>) {
    if (s.closing) return
    if (Object.keys(SessionStatus.list()).length > 0) return

    const now = Date.now()
    const stale = Cache.all(s.cache).filter((entry) => now - entry.usedAtMs >= s.idleMs)
    const victims = stale.filter((entry) => !entry.closing && entry.busy === 0)
    if (victims.length === 0) return

    for (const entry of victims) {
      const map = entry.segment === "protected" ? s.cache.protected : s.cache.probationary
      map.delete(entry.key)
      entry.closing = true
      await entry.value.shutdown().catch(() => {})
    }

    Bus.publish(Event.Updated, {})
  }

  export async function init() {
    return state()
  }

  export const Status = z
    .object({
      id: z.string(),
      name: z.string(),
      root: z.string(),
      status: z.union([z.literal("connected"), z.literal("error")]),
    })
    .meta({
      ref: "LSPStatus",
    })
  export type Status = z.infer<typeof Status>

  export async function status() {
    return state().then((x) => {
      const result: Status[] = []
      for (const entry of Cache.all(x.cache)) {
        const client = entry.value
        result.push({
          id: client.serverID,
          name: x.servers[client.serverID].id,
          root: path.relative(Instance.directory, client.root),
          status: "connected",
        })
      }
      return result
    })
  }

  async function ensureCapacity(s: Awaited<ReturnType<typeof state>>, needed: number) {
    const max = s.cache.max
    while (Cache.size(s.cache) + s.spawning.size + needed > max) {
      const entry = Cache.evictOne(s.cache)
      if (!entry) break
      entry.closing = true
      await entry.value.shutdown().catch(() => {})
      Bus.publish(Event.Updated, {})
    }
  }

  type Lease = {
    entry: Cache.Entry<LSPClient.Info>
    [globalThis.Symbol.dispose]: () => void
  }

  function scheduleTrim(s: Awaited<ReturnType<typeof state>>) {
    if (s.closing) return
    if (s.trim) return
    s.trim = true
    queueMicrotask(() => {
      if (s.closing) {
        s.trim = false
        return
      }
      ensureCapacity(s, 0)
        .catch(() => {})
        .finally(() => {
          s.trim = false

          // If we couldn't evict due to in-flight operations, retry later.
          const max = s.cache.max
          if (Cache.size(s.cache) + s.spawning.size <= max) return
          setTimeout(() => scheduleTrim(s), 10).unref()
        })
    })
  }

  function pin(s: Awaited<ReturnType<typeof state>>, entry: Cache.Entry<LSPClient.Info>): Lease {
    entry.busy += 1
    return {
      entry,
      [globalThis.Symbol.dispose]: () => {
        entry.busy -= 1
        scheduleTrim(s)
      },
    }
  }

  async function getLeases(file: string, use: Cache.Use): Promise<Lease[]> {
    const s = await state()
    if (s.closing) return []
    const extension = path.parse(file).ext || file
    const result: Lease[] = []

    async function schedule(server: LSPServer.Info, root: string, key: string) {
      const handle = await server
        .spawn(root)
        .then((value) => {
          if (!value) s.broken.add(key)
          return value
        })
        .catch((err) => {
          s.broken.add(key)
          log.error(`Failed to spawn LSP server ${server.id}`, { error: err })
          return undefined
        })

      if (!handle) return undefined
      if (s.closing) {
        handle.process.kill()
        return undefined
      }
      log.info("spawned lsp server", { serverID: server.id })

      const client = await LSPClient.create({
        serverID: server.id,
        server: handle,
        root,
      }).catch((err) => {
        s.broken.add(key)
        handle.process.kill()
        log.error(`Failed to initialize LSP client ${server.id}`, { error: err })
        return undefined
      })

      if (!client) {
        handle.process.kill()
        return undefined
      }

      if (s.closing) {
        await client.shutdown().catch(() => {})
        return undefined
      }

      const existing = Cache.get(s.cache, key)
      if (existing) {
        handle.process.kill()
        return existing
      }

      const entry: Cache.Entry<LSPClient.Info> = {
        key,
        value: client,
        segment: "probationary",
        hits: 0,
        busy: 0,
        closing: false,
        usedAtMs: Date.now(),
      }

      Cache.insert(s.cache, entry)
      return entry
    }

    for (const server of Object.values(s.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue

      const root = await server.root(file)
      if (!root) continue
      const key = cacheKey(server.id, root)
      if (s.broken.has(key)) continue

      const match = Cache.get(s.cache, key)
      if (match) {
        Cache.touch(s.cache, match, use, Date.now())
        result.push(pin(s, match))
        continue
      }

      const inflight = s.spawning.get(key)
      if (inflight) {
        const entry = await inflight
        if (!entry) continue
        Cache.touch(s.cache, entry, use, Date.now())
        result.push(pin(s, entry))
        continue
      }

      await ensureCapacity(s, 1)
      const task = schedule(server, root, key)
      s.spawning.set(key, task)

      task.finally(() => {
        if (s.spawning.get(key) === task) {
          s.spawning.delete(key)
        }
      })

      const entry = await task
      if (!entry) continue

      Cache.touch(s.cache, entry, use, Date.now())
      result.push(pin(s, entry))
      Bus.publish(Event.Updated, {})
    }

    return result
  }

  export async function hasClients(file: string) {
    const s = await state()
    const extension = path.parse(file).ext || file
    for (const server of Object.values(s.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue
      const root = await server.root(file)
      if (!root) continue
      if (s.broken.has(cacheKey(server.id, root))) continue
      return true
    }
    return false
  }

  export async function touchFile(input: string, waitForDiagnostics?: boolean) {
    log.info("touching file", { file: input })
    const use: Cache.Use = waitForDiagnostics ? "hard" : "soft"
    const leases = await getLeases(input, use)
    await Promise.all(
      leases.map(async (lease) => {
        using _ = lease
        const client = lease.entry.value
        const wait = waitForDiagnostics ? client.waitForDiagnostics({ path: input }) : Promise.resolve()
        await client.notify.open({ path: input })
        return wait
      }),
    ).catch((err) => {
      log.error("failed to touch file", { err, file: input })
    })
  }

  export async function diagnostics() {
    const s = await state()
    const results: Record<string, LSPClient.Diagnostic[]> = {}
    for (const entry of Cache.all(s.cache)) {
      for (const [path, diagnostics] of entry.value.diagnostics.entries()) {
        const arr = results[path] || []
        arr.push(...diagnostics)
        results[path] = arr
      }
    }
    return results
  }

  export async function hover(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) => {
      return client.connection
        .sendRequest("textDocument/hover", {
          textDocument: {
            uri: pathToFileURL(input.file).href,
          },
          position: {
            line: input.line,
            character: input.character,
          },
        })
        .catch(() => null)
    })
  }

  enum SymbolKind {
    File = 1,
    Module = 2,
    Namespace = 3,
    Package = 4,
    Class = 5,
    Method = 6,
    Property = 7,
    Field = 8,
    Constructor = 9,
    Enum = 10,
    Interface = 11,
    Function = 12,
    Variable = 13,
    Constant = 14,
    String = 15,
    Number = 16,
    Boolean = 17,
    Array = 18,
    Object = 19,
    Key = 20,
    Null = 21,
    EnumMember = 22,
    Struct = 23,
    Event = 24,
    Operator = 25,
    TypeParameter = 26,
  }

  const kinds = [
    SymbolKind.Class,
    SymbolKind.Function,
    SymbolKind.Method,
    SymbolKind.Interface,
    SymbolKind.Variable,
    SymbolKind.Constant,
    SymbolKind.Struct,
    SymbolKind.Enum,
  ]

  export async function workspaceSymbol(query: string) {
    return runAll((client) =>
      client.connection
        .sendRequest("workspace/symbol", {
          query,
        })
        .then((result: any) => result.filter((x: LSP.WorkspaceSymbol) => kinds.includes(x.kind)))
        .then((result: any) => result.slice(0, 10))
        .catch(() => []),
    ).then((result) => result.flat() as LSP.WorkspaceSymbol[])
  }

  export async function documentSymbol(uri: string) {
    const file = new URL(uri).pathname
    return run(file, (client) =>
      client.connection
        .sendRequest("textDocument/documentSymbol", {
          textDocument: {
            uri,
          },
        })
        .catch(() => []),
    )
      .then((result) => result.flat() as (LSP.DocumentSymbol | LSP.WorkspaceSymbol)[])
      .then((result) => result.filter(Boolean))
  }

  export async function definition(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/definition", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => null),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function references(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/references", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
          context: { includeDeclaration: true },
        })
        .catch(() => []),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function implementation(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/implementation", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => null),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function prepareCallHierarchy(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => []),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function incomingCalls(input: { file: string; line: number; character: number }) {
    return run(input.file, async (client) => {
      const items = (await client.connection
        .sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => [])) as any[]
      if (!items?.length) return []
      return client.connection.sendRequest("callHierarchy/incomingCalls", { item: items[0] }).catch(() => [])
    }).then((result) => result.flat().filter(Boolean))
  }

  export async function outgoingCalls(input: { file: string; line: number; character: number }) {
    return run(input.file, async (client) => {
      const items = (await client.connection
        .sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => [])) as any[]
      if (!items?.length) return []
      return client.connection.sendRequest("callHierarchy/outgoingCalls", { item: items[0] }).catch(() => [])
    }).then((result) => result.flat().filter(Boolean))
  }

  async function runAll<T>(input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
    const s = await state()
    if (s.closing) return []
    const leases = Cache.all(s.cache).map((entry) => {
      Cache.touch(s.cache, entry, "hard", Date.now())
      return pin(s, entry)
    })
    const tasks = leases.map(async (lease) => {
      using _ = lease
      return input(lease.entry.value)
    })
    return Promise.all(tasks)
  }

  async function run<T>(file: string, input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
    const leases = await getLeases(file, "hard")
    const tasks = leases.map(async (lease) => {
      using _ = lease
      return input(lease.entry.value)
    })
    return Promise.all(tasks)
  }

  export namespace Diagnostic {
    export function pretty(diagnostic: LSPClient.Diagnostic) {
      const severityMap = {
        1: "ERROR",
        2: "WARN",
        3: "INFO",
        4: "HINT",
      }

      const severity = severityMap[diagnostic.severity || 1]
      const line = diagnostic.range.start.line + 1
      const col = diagnostic.range.start.character + 1

      return `${severity} [${line}:${col}] ${diagnostic.message}`
    }
  }
}
