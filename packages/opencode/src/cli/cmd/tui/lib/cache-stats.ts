export type CacheStats = {
  hitPercentage: number
  readTokens: number
  writeTokens: number
  inputTokens: number
}

export type CacheStatsMessage = {
  id?: string
  role?: string
  tokens?: {
    input?: number
    cache?: {
      read?: number
      write?: number
    }
  }
}

type CacheTotals = Omit<CacheStats, "hitPercentage">

type CacheCheckpoint = {
  index: number
  id: string
}

type CacheAssistant = {
  index: number
  id: string
  totals: CacheTotals
}

export type CacheStatsState = {
  stats: CacheStats
  len: number
  checkpoints: CacheCheckpoint[]
  lastAssistant?: CacheAssistant
}

function totalsFromMessage(msg: CacheStatsMessage): CacheTotals {
  if (msg.role !== "assistant") {
    return { inputTokens: 0, readTokens: 0, writeTokens: 0 }
  }

  const tokens = msg.tokens
  if (!tokens) {
    return { inputTokens: 0, readTokens: 0, writeTokens: 0 }
  }

  return {
    inputTokens: tokens.input ?? 0,
    readTokens: tokens.cache?.read ?? 0,
    writeTokens: tokens.cache?.write ?? 0,
  }
}

function statsFromTotals(totals: CacheTotals): CacheStats {
  const total = totals.inputTokens + totals.readTokens
  const hitPercentage = total > 0 ? Math.round((totals.readTokens / total) * 100) : 0

  return {
    hitPercentage,
    readTokens: totals.readTokens,
    writeTokens: totals.writeTokens,
    inputTokens: totals.inputTokens,
  }
}

function checkpointsForMessages(messages: CacheStatsMessage[]): CacheCheckpoint[] {
  const len = messages.length
  if (len === 0) return []

  const indexes = [0, Math.floor((len - 1) / 2), len - 1]
  const seen = new Set<number>()
  const result: CacheCheckpoint[] = []

  for (const index of indexes) {
    if (seen.has(index)) continue
    seen.add(index)
    const msg = messages[index]
    const id = msg?.id
    if (!id) return []
    result.push({ index, id })
  }

  return result
}

function checkpointsMatch(checkpoints: CacheCheckpoint[], messages: CacheStatsMessage[]) {
  if (checkpoints.length === 0) return false

  for (const checkpoint of checkpoints) {
    const msg = messages[checkpoint.index]
    const id = msg?.id
    if (!id) return false
    if (id !== checkpoint.id) return false
  }

  return true
}

function lastAssistant(messages: CacheStatsMessage[]): CacheAssistant | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const msg = messages[index]
    if (msg.role !== "assistant") continue
    const id = msg.id
    if (!id) continue
    return { index, id, totals: totalsFromMessage(msg) }
  }
}

function computeState(messages: CacheStatsMessage[]): CacheStatsState {
  const stats = computeCacheStats(messages)

  return {
    stats,
    len: messages.length,
    checkpoints: checkpointsForMessages(messages),
    lastAssistant: lastAssistant(messages),
  }
}

export function computeCacheStats(messages: CacheStatsMessage[]): CacheStats {
  let readTokens = 0
  let writeTokens = 0
  let inputTokens = 0

  for (const msg of messages) {
    const totals = totalsFromMessage(msg)
    inputTokens += totals.inputTokens
    readTokens += totals.readTokens
    writeTokens += totals.writeTokens
  }

  return statsFromTotals({ inputTokens, readTokens, writeTokens })
}

export function updateCacheStatsState(
  prev: CacheStatsState | undefined,
  messages: CacheStatsMessage[],
): CacheStatsState {
  if (!prev) return computeState(messages)
  if (messages.length === 0) return computeState(messages)
  if (messages.length < prev.len) return computeState(messages)
  if (!checkpointsMatch(prev.checkpoints, messages)) return computeState(messages)

  let inputTokens = prev.stats.inputTokens
  let readTokens = prev.stats.readTokens
  let writeTokens = prev.stats.writeTokens
  let updatedLastAssistant = prev.lastAssistant

  if (updatedLastAssistant) {
    const msg = messages[updatedLastAssistant.index]
    if (!msg || msg.id !== updatedLastAssistant.id) return computeState(messages)

    const nextTotals = totalsFromMessage(msg)
    inputTokens += nextTotals.inputTokens - updatedLastAssistant.totals.inputTokens
    readTokens += nextTotals.readTokens - updatedLastAssistant.totals.readTokens
    writeTokens += nextTotals.writeTokens - updatedLastAssistant.totals.writeTokens
    updatedLastAssistant = { ...updatedLastAssistant, totals: nextTotals }
  }

  if (messages.length > prev.len) {
    for (let index = prev.len; index < messages.length; index++) {
      const totals = totalsFromMessage(messages[index])
      inputTokens += totals.inputTokens
      readTokens += totals.readTokens
      writeTokens += totals.writeTokens
    }

    for (let index = messages.length - 1; index >= prev.len; index--) {
      const msg = messages[index]
      if (msg.role !== "assistant") continue
      const id = msg.id
      if (!id) continue
      updatedLastAssistant = { index, id, totals: totalsFromMessage(msg) }
      break
    }
  }

  return {
    stats: statsFromTotals({ inputTokens, readTokens, writeTokens }),
    len: messages.length,
    checkpoints: checkpointsForMessages(messages),
    lastAssistant: updatedLastAssistant,
  }
}
