#!/usr/bin/env bun

import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"

type Flags = {
  sessionID: string
  storage: string
  apply: boolean
  limit: number
}

type Diagnostic = {
  severity?: number
}

function usage() {
  return [
    "trim-session-diagnostics: shrink persisted LSP diagnostics for one session",
    "",
    "This rewrites JSON under your opencode storage directory.",
    "Stop opencode first and back up ~/.local/share/opencode/storage before applying.",
    "",
    "Usage:",
    "  bun scripts/trim-session-diagnostics.ts <sessionID> [--apply] [--limit 20] [--storage <path>]",
    "",
    "Examples:",
    "  bun scripts/trim-session-diagnostics.ts ses_... --dry-run",
    "  bun scripts/trim-session-diagnostics.ts ses_... --apply",
  ].join("\n")
}

function resolveStorage(input: string | undefined) {
  if (input && input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2))
  }
  return input || path.join(os.homedir(), ".local", "share", "opencode", "storage")
}

function parseFlags(argv: string[]): Flags | undefined {
  let sessionID: string | undefined
  let storage: string | undefined
  let limit = 20
  let apply = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === "--apply") {
      apply = true
      continue
    }

    if (arg === "--dry-run") {
      continue
    }

    if (arg.startsWith("--storage=")) {
      storage = arg.slice("--storage=".length)
      continue
    }

    if (arg === "--storage") {
      storage = argv[i + 1]
      i++
      continue
    }

    if (arg.startsWith("--limit=")) {
      const value = arg.slice("--limit=".length)
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n) && n > 0) limit = n
      continue
    }

    if (arg === "--limit") {
      const value = argv[i + 1]
      i++
      const n = Number.parseInt(value || "", 10)
      if (Number.isFinite(n) && n > 0) limit = n
      continue
    }

    if (arg.startsWith("-")) {
      continue
    }

    if (!sessionID) {
      sessionID = arg
    }
  }

  if (!sessionID) return

  return {
    sessionID,
    storage: resolveStorage(storage),
    apply,
    limit,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

async function dirExists(dir: string) {
  return fs
    .stat(dir)
    .then((x) => x.isDirectory())
    .catch(() => false)
}

function selectDiagnostics(list: Diagnostic[], limit: number) {
  const errors = list.filter((d) => (d.severity ?? 1) === 1)
  const warnings = list.filter((d) => d.severity === 2)
  return [...errors, ...warnings].slice(0, limit)
}

function trimDiagnosticsMap(input: unknown, limit: number) {
  if (!isRecord(input)) {
    return {
      diagnostics: {},
      changed: false,
    }
  }

  const next: Record<string, Diagnostic[]> = {}
  let changed = false

  for (const [file, list] of Object.entries(input)) {
    if (!Array.isArray(list)) continue

    const selected = selectDiagnostics(list as Diagnostic[], limit)

    const same = (() => {
      if (selected.length !== list.length) return false
      for (let i = 0; i < selected.length; i++) {
        if (selected[i] !== list[i]) return false
      }
      return true
    })()

    if (!same) {
      changed = true
    }

    if (selected.length === 0) {
      continue
    }

    next[file] = selected
  }

  return {
    diagnostics: next,
    changed,
  }
}

async function listMessageIDs(storage: string, sessionID: string) {
  const dir = path.join(storage, "message", sessionID)
  const glob = new Bun.Glob("*.json")
  const ids: string[] = []

  if (!(await dirExists(dir))) return ids

  for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) {
    if (!file.endsWith(".json")) continue
    ids.push(file.slice(0, -5))
  }

  return ids
}

async function processPartFile(input: { filePath: string; apply: boolean; limit: number }) {
  const file = Bun.file(input.filePath)
  const beforeSize = await file
    .stat()
    .then((x) => x.size)
    .catch(() => 0)

  const part = await file.json().catch(() => undefined)
  if (!part || typeof part !== "object") {
    return { changed: false, beforeSize, afterSize: beforeSize }
  }

  const obj = part as any
  if (obj.type !== "tool") {
    return { changed: false, beforeSize, afterSize: beforeSize }
  }

  if (obj.tool !== "write" && obj.tool !== "edit") {
    return { changed: false, beforeSize, afterSize: beforeSize }
  }

  const state = obj.state
  if (!state || typeof state !== "object") {
    return { changed: false, beforeSize, afterSize: beforeSize }
  }

  const meta = state.metadata
  if (!meta || typeof meta !== "object") {
    return { changed: false, beforeSize, afterSize: beforeSize }
  }

  const existing = meta.diagnostics
  const trimmed = trimDiagnosticsMap(existing, input.limit)
  if (!trimmed.changed) {
    return { changed: false, beforeSize, afterSize: beforeSize }
  }

  meta.diagnostics = trimmed.diagnostics
  state.metadata = meta
  obj.state = state

  const json = JSON.stringify(obj, null, 2)
  const afterSize = Buffer.byteLength(json)

  if (!input.apply) {
    return { changed: true, beforeSize, afterSize }
  }

  await Bun.write(input.filePath, json)
  return { changed: true, beforeSize, afterSize }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  if (!flags) {
    console.error(usage())
    process.exit(1)
  }

  const dryRun = !flags.apply

  const messageIDs = await listMessageIDs(flags.storage, flags.sessionID).catch(() => [])
  if (messageIDs.length === 0) {
    console.error(`No messages found for session ${flags.sessionID} under ${flags.storage}`)
    process.exit(1)
  }

  let changedFiles = 0
  let beforeBytes = 0
  let afterBytes = 0

  for (const messageID of messageIDs) {
    const partsDir = path.join(flags.storage, "part", messageID)
    const partGlob = new Bun.Glob("*.json")

    const partsDirExists = await dirExists(partsDir)
    if (!partsDirExists) continue

    for await (const partFile of partGlob.scan({ cwd: partsDir, onlyFiles: true, absolute: true })) {
      const result = await processPartFile({
        filePath: partFile,
        apply: flags.apply,
        limit: flags.limit,
      })
      if (!result.changed) continue

      changedFiles++
      beforeBytes += result.beforeSize
      afterBytes += result.afterSize
    }
  }

  const verb = dryRun ? "Would update" : "Updated"
  const beforeMiB = beforeBytes / 1024 / 1024
  const afterMiB = afterBytes / 1024 / 1024

  console.log(`${verb} ${changedFiles} part file(s).`)
  console.log(`Estimated size of changed files: ${beforeMiB.toFixed(1)} MiB -> ${afterMiB.toFixed(1)} MiB`)
  console.log(`Bytes: ${beforeBytes.toLocaleString()} -> ${afterBytes.toLocaleString()}`)
  if (dryRun) {
    console.log("Re-run with --apply to write changes.")
  }
}

await main()
