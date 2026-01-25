export type Use = "soft" | "hard"

export type Segment = "probationary" | "protected"

export type Entry<T> = {
  key: string
  value: T
  segment: Segment
  hits: number
  busy: number
  closing: boolean
  usedAtMs: number
}

export type Cache<T> = {
  max: number
  protectedMax: number
  probationary: Map<string, Entry<T>>
  protected: Map<string, Entry<T>>
}

export function create<T>(input: { max: number; protectedMax: number }): Cache<T> {
  return {
    max: input.max,
    protectedMax: input.protectedMax,
    probationary: new Map(),
    protected: new Map(),
  }
}

export function size<T>(cache: Cache<T>) {
  return cache.probationary.size + cache.protected.size
}

export function get<T>(cache: Cache<T>, key: string) {
  return cache.protected.get(key) ?? cache.probationary.get(key)
}

export function all<T>(cache: Cache<T>) {
  // Stable order: protected first (hotter), then probationary.
  return [...cache.protected.values(), ...cache.probationary.values()]
}

function move<T>(map: Map<string, Entry<T>>, entry: Entry<T>) {
  map.delete(entry.key)
  map.set(entry.key, entry)
}

function rebalance<T>(cache: Cache<T>) {
  while (cache.protected.size > cache.protectedMax) {
    const oldest = cache.protected.keys().next().value
    if (!oldest) break
    const entry = cache.protected.get(oldest)
    cache.protected.delete(oldest)
    if (!entry) continue
    entry.segment = "probationary"
    cache.probationary.set(entry.key, entry)
  }
}

export function insert<T>(cache: Cache<T>, entry: Entry<T>) {
  entry.segment = "probationary"
  cache.probationary.set(entry.key, entry)
}

export function touch<T>(cache: Cache<T>, entry: Entry<T>, use: Use, nowMs: number) {
  entry.hits += 1
  entry.usedAtMs = nowMs

  if (entry.segment === "protected") {
    move(cache.protected, entry)
    return
  }

  if (use === "hard" || entry.hits > 1) {
    cache.probationary.delete(entry.key)
    entry.segment = "protected"
    cache.protected.set(entry.key, entry)
    rebalance(cache)
    return
  }

  move(cache.probationary, entry)
}

function evictFrom<T>(map: Map<string, Entry<T>>) {
  for (const key of map.keys()) {
    const entry = map.get(key)
    if (!entry) {
      map.delete(key)
      continue
    }
    if (entry.closing || entry.busy > 0) continue
    map.delete(key)
    return entry
  }
}

export function evictOne<T>(cache: Cache<T>) {
  const entry = evictFrom(cache.probationary)
  if (entry) return entry
  return evictFrom(cache.protected)
}
