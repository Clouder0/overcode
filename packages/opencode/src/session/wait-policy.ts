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

  function nowMono() {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now()
    }
    return Date.now()
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
    state().delete(sessionID)
  }

  export function register(input: {
    sessionID: string
    messageID: string
    callID: string
    sources: string[]
    timeout: number
    mode: Mode
  }): Policy {
    clear(input.sessionID)

    const now = Date.now()
    const createdMono = nowMono()
    const deadline = input.timeout > 0 ? now + input.timeout : undefined
    const deadlineMono = input.timeout > 0 ? createdMono + input.timeout : undefined

    const policy: Policy = {
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      sources: input.sources,
      timeout: input.timeout,
      mode: input.mode,
      time: {
        created: now,
        deadline,
      },
    }

    const next: State = {
      policy,
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

    state().set(input.sessionID, next)
    return policy
  }

  function getMono(policy: Policy) {
    return state().get(policy.sessionID)?.mono
  }

  export function evaluate(input: { policy: Policy; now?: number; pendingFromSources: Set<string> }): EvaluateResult {
    const respondedSources = input.policy.sources.filter((s) => input.pendingFromSources.has(s))
    const missingSources = input.policy.sources.filter((s) => !input.pendingFromSources.has(s))

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
