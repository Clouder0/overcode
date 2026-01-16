import { SessionMessage } from "@/session/message-routing"
import { SessionStatus } from "@/session/status"
import { WaitPolicy } from "@/session/wait-policy"

let inited = false

export namespace WaitNotice {
  function wildcard(sources: string[]) {
    return sources.length === 1 && sources[0] === "*"
  }

  function timeleft(input: { deadline?: number }) {
    if (input.deadline === undefined) return undefined
    return Math.max(0, input.deadline - Date.now())
  }

  function notice(input: { waiter: string; source: string; policy: WaitPolicy.Policy }) {
    const left = timeleft({ deadline: input.policy.time.deadline })
    const ms = left === undefined ? "unknown" : `${left}ms`

    return [
      "<system-reminder>",
      `Notice: session ${input.waiter} is waiting for a message from you.`,
      "",
      "Decision: decide whether to reply.",
      `- Reply (agent-visible): send_agent_message(to=\"${input.waiter}\", text=\"...\")`,
      "- If you need human input first: ask the human in normal assistant text, then reply later.",
      "- If you choose not to reply: do nothing.",
      "",
      `Time left until timeout: ${ms}`,
      "This notice is sent at most once for this wait.",
      "</system-reminder>",
    ].join("\n")
  }

  function aggregate(input: {
    source: string
    waits: Array<{ waiter: string; callID: string; policy: WaitPolicy.Policy }>
  }) {
    const lines = [
      "<system-reminder>",
      "Notice: one or more sessions are waiting for a message from you.",
      "",
      "Decision: decide whether to reply to any of them.",
      '- Reply: send_agent_message(to="ses_...", text="...")',
      "- Or ask the human first, then reply later.",
      "- Or do nothing.",
      "",
      "Waiting sessions:",
      ...input.waits.map((w) => {
        const left = timeleft({ deadline: w.policy.time.deadline })
        const ms = left === undefined ? "unknown" : `${left}ms`
        return `- ${w.waiter} (time left: ${ms})`
      }),
      "",
      "This notice is sent at most once per wait.",
      "</system-reminder>",
    ]

    return lines.join("\n")
  }

  async function maybeNotify(input: { waiter: string; source: string; policy: WaitPolicy.Policy }) {
    const current = WaitPolicy.get(input.waiter)
    if (!current) return
    if (current.callID !== input.policy.callID) return

    if (!input.policy.sources.includes(input.source)) return

    const respondedFromSources = SessionMessage.responded({
      to: input.waiter,
      sources: input.policy.sources,
      since: input.policy.since,
    })

    const result = WaitPolicy.evaluate({
      policy: input.policy,
      respondedFromSources,
    })

    if (result.ready || result.timedOut) return
    if (!result.missingSources.includes(input.source)) return

    const marked = WaitPolicy.markNoticed({
      waiter: input.waiter,
      callID: input.policy.callID,
      source: input.source,
    })
    if (!marked) return

    await SessionMessage.deliver({
      from: "Wait notice",
      to: input.source,
      text: notice({ waiter: input.waiter, source: input.source, policy: input.policy }),
      messageType: "notice",
    })
  }

  export function init() {
    if (inited) return
    inited = true

    SessionStatus.subscribe((event) => {
      const sessionID = event.sessionID
      const status = event.status

      if (status.type === "waiting") {
        const policy = WaitPolicy.get(sessionID)
        if (!policy) return
        if (wildcard(policy.sources)) return

        for (const source of policy.sources) {
          if (SessionStatus.get(source).type !== "idle") continue
          maybeNotify({ waiter: sessionID, source, policy }).catch(() => {})
        }

        return
      }

      if (status.type === "idle") {
        const waiters = WaitPolicy.dependents(sessionID)
        if (waiters.length === 0) return

        const waits: Array<{ waiter: string; callID: string; policy: WaitPolicy.Policy }> = []

        for (const waiter of waiters) {
          const policy = WaitPolicy.get(waiter)
          if (!policy) continue
          if (wildcard(policy.sources)) continue
          if (!policy.sources.includes(sessionID)) continue

          const st = SessionStatus.get(waiter)
          if (st.type !== "waiting") continue

          const respondedFromSources = SessionMessage.responded({
            to: waiter,
            sources: policy.sources,
            since: policy.since,
          })

          const result = WaitPolicy.evaluate({
            policy,
            respondedFromSources,
          })

          if (result.ready || result.timedOut) continue
          if (!result.missingSources.includes(sessionID)) continue

          const marked = WaitPolicy.markNoticed({
            waiter,
            callID: policy.callID,
            source: sessionID,
          })
          if (!marked) continue

          waits.push({ waiter, callID: policy.callID, policy })
        }

        if (waits.length === 0) return

        const text =
          waits.length === 1
            ? notice({ waiter: waits[0]!.waiter, source: sessionID, policy: waits[0]!.policy })
            : aggregate({ source: sessionID, waits })

        SessionMessage.deliver({
          from: "Wait notice",
          to: sessionID,
          text,
          messageType: "notice",
        }).catch(() => {})
      }
    })
  }
}
