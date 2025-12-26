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

  let wakeFn: ((sessionID: string) => void) | undefined

  export function setWakeFn(fn: (sessionID: string) => void) {
    wakeFn = fn
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
    const deadline = input.timeout > 0 ? now + input.timeout : undefined

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
    }

    if (deadline !== undefined) {
      next.timeoutTimer = setTimeout(() => {
        wakeFn?.(input.sessionID)
      }, input.timeout)
    }

    state().set(input.sessionID, next)
    return policy
  }

  export function evaluate(input: { policy: Policy; now?: number; pendingFromSources: Set<string> }): EvaluateResult {
    const now = input.now ?? Date.now()

    const respondedSources = input.policy.sources.filter((s) => input.pendingFromSources.has(s))
    const missingSources = input.policy.sources.filter((s) => !input.pendingFromSources.has(s))

    const ready = input.policy.mode === "any" ? respondedSources.length > 0 : missingSources.length === 0

    const timedOut = input.policy.time.deadline !== undefined && now >= input.policy.time.deadline && !ready

    return {
      ready: ready || timedOut,
      timedOut: timedOut && !ready,
      respondedSources,
      missingSources,
    }
  }
}
