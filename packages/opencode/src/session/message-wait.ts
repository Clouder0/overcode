import { Log } from "@/util/log"
import { MessageParser } from "./message-parser"

export namespace MessageWait {
  const log = Log.create({ service: "message-wait" })

  // Callback to check pending messages - set by message-routing to avoid circular dependency
  let peekPendingFn: ((sessionID: string) => Array<{ from: string; text: string }>) | undefined

  export function setPeekPendingFn(fn: (sessionID: string) => Array<{ from: string; text: string }>) {
    peekPendingFn = fn
  }

  interface WaitState {
    sessionID: string
    sources: string[]
    timeout: number
    mode: "all" | "any"
    received: Map<string, string>
    timer?: Timer
    onResolve?: (messages: Map<string, string>) => void
    onTimeout?: () => void
  }

  export interface WaitResult {
    responses: Array<{
      from: string
      text: string
      timedOut: boolean
    }>
    allReceived: boolean
  }

  const waitStates = new Map<string, WaitState>()

  export function wait(input: {
    sessionID: string
    sources: string[]
    timeout: number
    mode: "all" | "any"
  }): Promise<WaitResult> {
    return new Promise((resolve) => {
      const state: WaitState = {
        sessionID: input.sessionID,
        sources: input.sources,
        timeout: input.timeout,
        mode: input.mode,
        received: new Map(),
      }

      const finish = (timedOut: boolean) => {
        if (state.timer) clearTimeout(state.timer)
        waitStates.delete(input.sessionID)

        const responses: WaitResult["responses"] = []
        for (const source of input.sources) {
          const text = state.received.get(source)
          if (text !== undefined) {
            responses.push({ from: source, text, timedOut: false })
          } else if (timedOut) {
            responses.push({
              from: source,
              text: MessageParser.formatTimeoutMessage(input.timeout),
              timedOut: true,
            })
          }
        }

        resolve({
          responses,
          allReceived: state.received.size >= input.sources.length,
        })
      }

      state.onResolve = () => finish(false)
      state.onTimeout = () => finish(true)

      // Cancel any existing wait for this session (clears old timer)
      cancel(input.sessionID)

      // CRITICAL: Register in waitStates FIRST before checking pending messages
      // This prevents a race condition where:
      // 1. We check pending - empty
      // 2. Message arrives, onMessage() called but waitStates doesn't have us yet
      // 3. Message goes to pending queue, wait never sees it
      // 4. We add to waitStates - too late, wait is stuck
      waitStates.set(input.sessionID, state)
      log.info("wait registered", { sessionID: input.sessionID, sources: input.sources })

      // Now check if any messages from sources are already in the pending queue
      // This handles the case where subagent responded before parent started waiting
      if (peekPendingFn) {
        const pendingMessages = peekPendingFn(input.sessionID)
        for (const msg of pendingMessages) {
          if (input.sources.includes(msg.from)) {
            state.received.set(msg.from, msg.text)
            log.info("found pending message from source", { sessionID: input.sessionID, from: msg.from })
          }
        }
      } else {
        log.warn("peekPendingFn not set - cannot check for already-pending messages", {
          sessionID: input.sessionID,
        })
      }

      // Check if we can resolve immediately based on already-received messages
      // (either from pending queue or from onMessage calls that happened after we registered)
      const shouldResolveImmediately =
        (input.mode === "any" && state.received.size > 0) ||
        (input.mode === "all" && state.received.size >= input.sources.length)

      if (shouldResolveImmediately) {
        log.info("wait resolved immediately", { sessionID: input.sessionID, received: state.received.size })
        finish(false)
        return
      }

      // Set up timeout timer only if we're actually waiting
      if (input.timeout > 0) {
        state.timer = setTimeout(() => {
          handleTimeout(input.sessionID)
        }, input.timeout)
      }

      log.info("wait started", { sessionID: input.sessionID, sources: input.sources, timeout: input.timeout })
    })
  }

  export function registerSingle(
    sessionID: string,
    source: string,
    timeout: number,
    onResolve?: (messages: Map<string, string>) => void,
    onTimeout?: () => void,
  ): void {
    registerMulti(sessionID, [source], timeout, "all", onResolve, onTimeout)
  }

  export function registerMulti(
    sessionID: string,
    sources: string[],
    timeout: number,
    mode: "all" | "any",
    onResolve?: (messages: Map<string, string>) => void,
    onTimeout?: () => void,
  ): void {
    cancel(sessionID)

    const state: WaitState = {
      sessionID,
      sources,
      timeout,
      mode,
      received: new Map(),
      onResolve,
      onTimeout,
    }

    if (timeout > 0) {
      state.timer = setTimeout(() => {
        handleTimeout(sessionID)
      }, timeout)
    }

    waitStates.set(sessionID, state)
    log.info("registered wait", { sessionID, sources, timeout, mode })
  }

  export function isWaiting(sessionID: string): boolean {
    return waitStates.has(sessionID)
  }

  export function getWaitState(sessionID: string): WaitState | undefined {
    return waitStates.get(sessionID)
  }

  export function onMessage(sessionID: string, from: string, text: string): boolean {
    const state = waitStates.get(sessionID)
    if (!state) return false

    if (!state.sources.includes(from)) return false

    state.received.set(from, text)
    log.info("received message for wait", {
      sessionID,
      from,
      received: state.received.size,
      expected: state.sources.length,
    })

    if (state.mode === "any") {
      resolveState(sessionID)
      return true
    }

    if (state.mode === "all" && state.received.size >= state.sources.length) {
      resolveState(sessionID)
      return true
    }

    return false
  }

  function resolveState(sessionID: string): void {
    const state = waitStates.get(sessionID)
    if (!state) return

    if (state.timer) clearTimeout(state.timer)

    const messages = state.received
    waitStates.delete(sessionID)

    log.info("wait resolved", { sessionID })
    state.onResolve?.(messages)
  }

  function handleTimeout(sessionID: string): void {
    const state = waitStates.get(sessionID)
    if (!state) return

    log.info("wait timeout", { sessionID, timeout: state.timeout })

    // Don't deliver timeout messages here - they will be returned in WaitResult
    // and delivered by the caller (prompt.ts) to avoid duplicate deliveries

    waitStates.delete(sessionID)
    state.onTimeout?.()
  }

  export function cancel(sessionID: string): void {
    const state = waitStates.get(sessionID)
    if (!state) return

    if (state.timer) clearTimeout(state.timer)
    waitStates.delete(sessionID)
    log.info("wait cancelled", { sessionID })
  }

  export function getMissingSources(sessionID: string): string[] {
    const state = waitStates.get(sessionID)
    if (!state) return []

    return state.sources.filter((s) => !state.received.has(s))
  }
}
