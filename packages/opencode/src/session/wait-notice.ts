import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Session } from "@/session"
import { SessionMessage } from "@/session/message-routing"
import { SessionStatus } from "@/session/status"
import { SessionStatusResolver } from "@/session/status-resolver"
import { WaitPolicy } from "@/session/wait-policy"

let inited = false

export namespace WaitNotice {
  type WaitCandidate = {
    waiter: string
    callID: string
    policy: WaitPolicy.Policy
    directory: string
  }

  const inflight = Instance.state(
    () => new Set<string>(),
    async (set) => {
      set.clear()
    },
  )

  const sourceInflight = Instance.state(
    () => new Set<string>(),
    async (set) => {
      set.clear()
    },
  )

  function noticeKey(input: { waiter: string; callID: string; source: string }) {
    return [input.waiter, input.callID, input.source].join(":")
  }

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

  async function waitersForSource(source: string) {
    const directories = new Set<string>()
    for await (const session of Session.list()) {
      directories.add(session.directory)
    }

    const waiters = new Set<string>()
    for (const directory of directories) {
      const ids = await Instance.provide({
        directory,
        init: InstanceBootstrap,
        fn: async () => {
          return WaitPolicy.dependents(source)
        },
      }).catch(() => [] as string[])

      for (const waiter of ids) {
        waiters.add(waiter)
      }
    }

    return Array.from(waiters)
  }

  async function collectWait(input: { waiter: string; source: string }): Promise<WaitCandidate | undefined> {
    const waiter = await Session.get(input.waiter).catch(() => undefined)
    if (!waiter) return

    return Instance.provide({
      directory: waiter.directory,
      init: InstanceBootstrap,
      fn: async () => {
        const policy = WaitPolicy.get(input.waiter)
        if (!policy) return
        if (wildcard(policy.sources)) return
        if (policy.mode !== "all") return
        if (!policy.sources.includes(input.source)) return

        const status = SessionStatus.get(input.waiter)
        if (status.type !== "waiting") return

        if (
          WaitPolicy.noticed({
            waiter: input.waiter,
            callID: policy.callID,
            source: input.source,
          })
        ) {
          return
        }

        const respondedFromSources = SessionMessage.respondedRecoverable({
          to: input.waiter,
          sources: policy.sources,
          since: policy.since,
        })

        const result = WaitPolicy.evaluate({
          policy,
          respondedFromSources,
        })

        if (result.ready || result.timedOut) return
        if (!result.missingSources.includes(input.source)) return

        return {
          waiter: input.waiter,
          callID: policy.callID,
          policy,
          directory: waiter.directory,
        }
      },
    }).catch(() => undefined)
  }

  async function notifySource(source: string) {
    const queue = sourceInflight()
    if (queue.has(source)) return
    queue.add(source)

    const keys: string[] = []

    try {
      const waiters = await waitersForSource(source)
      if (waiters.length === 0) return

      const waits = await Promise.all(waiters.map((waiter) => collectWait({ waiter, source })))
      const pending = waits.filter((wait): wait is WaitCandidate => Boolean(wait))
      if (pending.length === 0) return

      const locks = inflight()
      const ready: WaitCandidate[] = []
      for (const wait of pending) {
        const key = noticeKey({ waiter: wait.waiter, callID: wait.callID, source })
        if (locks.has(key)) continue
        locks.add(key)
        keys.push(key)
        ready.push(wait)
      }

      if (ready.length === 0) return

      const text =
        ready.length === 1
          ? notice({ waiter: ready[0]!.waiter, source, policy: ready[0]!.policy })
          : aggregate({ source, waits: ready })

      const target = await Session.get(source).catch(() => undefined)
      if (!target) return

      await Instance.provide({
        directory: target.directory,
        init: InstanceBootstrap,
        fn: () =>
          SessionMessage.deliver({
            from: "Wait notice",
            to: source,
            text,
            messageType: "notice",
          }),
      })

      await Promise.allSettled(
        ready.map((wait) =>
          Instance.provide({
            directory: wait.directory,
            init: InstanceBootstrap,
            fn: async () => {
              WaitPolicy.markNoticed({
                waiter: wait.waiter,
                callID: wait.callID,
                source,
              })
            },
          }),
        ),
      )
    } finally {
      const locks = inflight()
      for (const key of keys) {
        locks.delete(key)
      }
      queue.delete(source)
    }
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
        if (policy.mode !== "all") return

        for (const source of policy.sources) {
          SessionStatusResolver.get(source)
            .then((resolved) => {
              if (resolved?.type !== "idle") return
              return notifySource(source)
            })
            .catch(() => {})
        }

        return
      }

      if (status.type === "idle") {
        notifySource(sessionID).catch(() => {})
      }
    })
  }
}
