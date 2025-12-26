import { describe, expect, test } from "bun:test"
import { computeCacheStats, updateCacheStatsState } from "../../src/cli/cmd/tui/lib/cache-stats"

describe("computeCacheStats", () => {
  test("returns 0% for empty input", () => {
    const stats = computeCacheStats([])
    expect(stats.hitPercentage).toBe(0)
    expect(stats.readTokens).toBe(0)
    expect(stats.writeTokens).toBe(0)
    expect(stats.inputTokens).toBe(0)
  })

  test("ignores non-assistant messages", () => {
    const stats = computeCacheStats([
      {
        id: "msg_user",
        role: "user",
        tokens: {
          input: 999,
          cache: { read: 999, write: 999 },
        },
      },
    ])

    expect(stats.hitPercentage).toBe(0)
    expect(stats.readTokens).toBe(0)
    expect(stats.writeTokens).toBe(0)
    expect(stats.inputTokens).toBe(0)
  })

  test("computes hit% as cached_read / (cached_read + input)", () => {
    const stats = computeCacheStats([
      {
        id: "msg_assistant",
        role: "assistant",
        tokens: {
          input: 100,
          cache: { read: 900, write: 1234 },
        },
      },
    ])

    expect(stats.inputTokens).toBe(100)
    expect(stats.readTokens).toBe(900)
    expect(stats.writeTokens).toBe(1234)
    expect(stats.hitPercentage).toBe(90)
  })

  test("aggregates across assistant messages", () => {
    const stats = computeCacheStats([
      {
        id: "a",
        role: "assistant",
        tokens: {
          input: 100,
          cache: { read: 0, write: 10 },
        },
      },
      {
        id: "b",
        role: "assistant",
        tokens: {
          input: 0,
          cache: { read: 100, write: 0 },
        },
      },
    ])

    expect(stats.inputTokens).toBe(100)
    expect(stats.readTokens).toBe(100)
    expect(stats.writeTokens).toBe(10)
    expect(stats.hitPercentage).toBe(50)
  })
})

describe("updateCacheStatsState", () => {
  test("fast-path handles append-only updates", () => {
    const a = {
      id: "a",
      role: "assistant",
      tokens: { input: 10, cache: { read: 90, write: 0 } },
    }

    const prev = updateCacheStatsState(undefined, [a])

    const b = {
      id: "b",
      role: "assistant",
      tokens: { input: 10, cache: { read: 0, write: 0 } },
    }

    const next = updateCacheStatsState(prev, [a, b])

    expect(next.stats.inputTokens).toBe(20)
    expect(next.stats.readTokens).toBe(90)
    expect(next.stats.hitPercentage).toBe(82)
  })

  test("fast-path updates the last assistant contribution", () => {
    const a0 = {
      id: "a",
      role: "assistant",
      tokens: { input: 0, cache: { read: 0, write: 0 } },
    }

    const prev = updateCacheStatsState(undefined, [a0])

    const a1 = {
      id: "a",
      role: "assistant",
      tokens: { input: 100, cache: { read: 900, write: 0 } },
    }

    const next = updateCacheStatsState(prev, [a1])

    expect(next.stats.inputTokens).toBe(100)
    expect(next.stats.readTokens).toBe(900)
    expect(next.stats.hitPercentage).toBe(90)
  })

  test("fast-path handles last assistant delta with append-only", () => {
    const a0 = {
      id: "a",
      role: "assistant",
      tokens: { input: 0, cache: { read: 0, write: 0 } },
    }

    const prev = updateCacheStatsState(undefined, [a0])

    const a1 = {
      id: "a",
      role: "assistant",
      tokens: { input: 100, cache: { read: 900, write: 0 } },
    }

    const u = {
      id: "u",
      role: "user",
      tokens: { input: 999, cache: { read: 999, write: 999 } },
    }

    const next = updateCacheStatsState(prev, [a1, u])

    expect(next.stats.inputTokens).toBe(100)
    expect(next.stats.readTokens).toBe(900)
    expect(next.stats.hitPercentage).toBe(90)
  })

  test("falls back when message prefix mismatches", () => {
    const prev = updateCacheStatsState(undefined, [
      {
        id: "a",
        role: "assistant",
        tokens: { input: 1, cache: { read: 1, write: 0 } },
      },
    ])

    const nextMessages = [
      {
        id: "b",
        role: "assistant",
        tokens: { input: 2, cache: { read: 0, write: 0 } },
      },
    ]

    const next = updateCacheStatsState(prev, nextMessages)

    expect(next.stats).toEqual(computeCacheStats(nextMessages))
  })
})
