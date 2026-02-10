import { Instance } from "@/project/instance"

export namespace WaitPolicy {
  export type Mode = "all" | "any"

  export type Policy = {
    sessionID: string
    messageID: string
    callID: string
    sources: string[]
    timeout: number
    mode: Mode
    since: number
    time: {
      created: number
      deadline?: number
    }
  }

  export type EvaluateResult = {
    ready: boolean
    timedOut: boolean
    respondedSources: string[]
    missingSources: string[]
  }

  type State = {
    policy: Policy
    timeoutTimer?: ReturnType<typeof setTimeout>
    noticed: Set<string>
    mono: {
      created: number
      deadline?: number
    }
  }

  const state = Instance.state(
    () => new Map<string, State>(),
    async (map) => {
      for (const item of map.values()) {
        if (item.timeoutTimer) clearTimeout(item.timeoutTimer)
      }
      map.clear()
    },
  )

  const waitersBySource = Instance.state(
    () => new Map<string, Set<string>>(),
    async (map) => {
      map.clear()
    },
  )

  function nowMono() {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now()
    }
    return Date.now()
  }

  function wildcard(sources: string[]) {
    return sources.length === 1 && sources[0] === "*"
  }

  function single(sources: string[]) {
    return sources.length === 1 && sources[0] !== "*"
  }

  export function normalizeMode(input: { sources: string[]; mode: Mode }): Mode {
    if (wildcard(input.sources)) return "any"
    if (single(input.sources)) return "all"
    return input.mode
  }

  let wakeFn: ((sessionID: string) => void) | undefined

  export function setWakeFn(fn: ((sessionID: string) => void) | undefined) {
    const prev = wakeFn
    wakeFn = fn
    return prev
  }

  export function get(sessionID: string): Policy | undefined {
    return state().get(sessionID)?.policy
  }

  export function isWaiting(sessionID: string): boolean {
    return state().has(sessionID)
  }

  export function clear(sessionID: string): void {
    const existing = state().get(sessionID)
    if (!existing) return
    if (existing.timeoutTimer) clearTimeout(existing.timeoutTimer)

    const policy = existing.policy
    if (!wildcard(policy.sources)) {
      const lookup = waitersBySource()
      for (const source of policy.sources) {
        const waiters = lookup.get(source)
        if (!waiters) continue
        waiters.delete(sessionID)
        if (waiters.size === 0) {
          lookup.delete(source)
        }
      }
    }

    state().delete(sessionID)
  }

  export function register(input: {
    sessionID: string
    messageID: string
    callID: string
    sources: string[]
    timeout: number
    mode: Mode
    since: number
  }): Policy {
    clear(input.sessionID)

    const now = Date.now()
    const createdMono = nowMono()
    const deadline = input.timeout > 0 ? now + input.timeout : undefined
    const deadlineMono = input.timeout > 0 ? createdMono + input.timeout : undefined
    const mode = normalizeMode({ sources: input.sources, mode: input.mode })

    const policy: Policy = {
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      sources: input.sources,
      timeout: input.timeout,
      mode,
      since: input.since,
      time: {
        created: now,
        deadline,
      },
    }

    const next: State = {
      policy,
      noticed: new Set(),
      mono: {
        created: createdMono,
        deadline: deadlineMono,
      },
    }

    if (deadline !== undefined) {
      const directory = Instance.directory
      next.timeoutTimer = setTimeout(() => {
        Instance.provide({
          directory,
          fn: () => {
            wakeFn?.(input.sessionID)
          },
        }).catch(() => {})
      }, input.timeout)
    }

    if (!wildcard(policy.sources)) {
      const lookup = waitersBySource()
      for (const source of policy.sources) {
        const waiters = lookup.get(source) ?? new Set<string>()
        waiters.add(input.sessionID)
        lookup.set(source, waiters)
      }
    }

    state().set(input.sessionID, next)
    return policy
  }

  function getMono(policy: Policy) {
    return state().get(policy.sessionID)?.mono
  }

  export function dependents(source: string): string[] {
    const waiters = waitersBySource().get(source)
    if (!waiters) return []
    return Array.from(waiters)
  }

  export function markNoticed(input: { waiter: string; callID: string; source: string }): boolean {
    const current = state().get(input.waiter)
    if (!current) return false
    if (current.policy.callID !== input.callID) return false
    if (current.noticed.has(input.source)) return false
    current.noticed.add(input.source)
    return true
  }

  export function noticed(input: { waiter: string; callID: string; source: string }) {
    const current = state().get(input.waiter)
    if (!current) return false
    if (current.policy.callID !== input.callID) return false
    return current.noticed.has(input.source)
  }

  export function evaluate(input: { policy: Policy; now?: number; respondedFromSources: Set<string> }): EvaluateResult {
    const wild = wildcard(input.policy.sources)

    const respondedSources = wild
      ? Array.from(input.respondedFromSources)
      : input.policy.sources.filter((s) => input.respondedFromSources.has(s))

    const missingSources = wild ? [] : input.policy.sources.filter((s) => !input.respondedFromSources.has(s))

    const ready = input.policy.mode === "any" ? respondedSources.length > 0 : missingSources.length === 0

    const deadline = input.policy.time.deadline
    const now = input.now ?? Date.now()

    let timedOut = false
    if (deadline !== undefined && !ready) {
      timedOut = now >= deadline

      const mono = getMono(input.policy)
      if (mono?.deadline !== undefined) {
        timedOut = timedOut || nowMono() >= mono.deadline
      }
    }

    return {
      ready: ready || timedOut,
      timedOut: timedOut && !ready,
      respondedSources,
      missingSources,
    }
  }
}
