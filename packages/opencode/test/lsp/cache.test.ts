import { expect, test } from "bun:test"
import * as Cache from "../../src/lsp/cache"

function entry(key: string) {
  return {
    key,
    value: key,
    segment: "probationary" as const,
    hits: 0,
    busy: 0,
    closing: false,
    usedAtMs: 0,
  }
}

test("SLRU promotes probationary entry on hard use", () => {
  const cache = Cache.create<string>({ max: 4, protectedMax: 2 })
  const e = entry("a")
  Cache.insert(cache, e)
  Cache.touch(cache, e, "hard", 1)
  expect(cache.protected.has("a")).toBe(true)
  expect(cache.probationary.has("a")).toBe(false)
})

test("SLRU promotes probationary entry on second use", () => {
  const cache = Cache.create<string>({ max: 4, protectedMax: 2 })
  const e = entry("a")
  Cache.insert(cache, e)
  Cache.touch(cache, e, "soft", 1)
  expect(cache.probationary.has("a")).toBe(true)
  Cache.touch(cache, e, "soft", 2)
  expect(cache.protected.has("a")).toBe(true)
})

test("SLRU evicts from probationary before protected", () => {
  const cache = Cache.create<string>({ max: 2, protectedMax: 1 })
  const a = entry("a")
  const b = entry("b")
  Cache.insert(cache, a)
  Cache.touch(cache, a, "hard", 1)
  Cache.insert(cache, b)
  Cache.touch(cache, b, "soft", 2)

  const evicted = Cache.evictOne(cache)
  expect(evicted?.key).toBe("b")
  expect(cache.protected.has("a")).toBe(true)
})

test("SLRU demotes protected LRU when protected over capacity", () => {
  const cache = Cache.create<string>({ max: 4, protectedMax: 1 })
  const a = entry("a")
  const b = entry("b")
  Cache.insert(cache, a)
  Cache.touch(cache, a, "hard", 1)
  Cache.insert(cache, b)
  Cache.touch(cache, b, "hard", 2)

  expect(cache.protected.size).toBe(1)
  expect(cache.protected.has("b")).toBe(true)
  expect(cache.probationary.has("a")).toBe(true)
})

test("SLRU eviction skips busy entries", () => {
  const cache = Cache.create<string>({ max: 4, protectedMax: 2 })
  const a = entry("a")
  const b = entry("b")
  Cache.insert(cache, a)
  Cache.insert(cache, b)
  a.busy = 1

  const evicted = Cache.evictOne(cache)
  expect(evicted?.key).toBe("b")
  expect(cache.probationary.has("a")).toBe(true)
})
