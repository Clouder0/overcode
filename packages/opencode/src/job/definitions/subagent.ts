import z from "zod"
import { Agent } from "@/agent/agent"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { Log } from "@/util/log"
import { JobRegistry } from "../registry"
import { JobBridge } from "@/tool/job-bridge"

const log = Log.create({ service: "job.subagent" })

const OUTPUT_SCHEMA = z.object({
  type: z.enum(["progress", "result", "question", "error"]),
  text: z.string(),
})

export const SubagentJob = JobRegistry.define("subagent", {
  description: async () => {
    const agents = await Agent.list()
    const agentNames = agents
      .filter((a) => a.mode !== "primary")
      .map((a) => a.name)
      .join(", ")

    return `Launch one or more subagents to perform tasks autonomously in parallel.

Available agents: ${agentNames}

**Usage:**
- Start: job_subagent_start({ jobs: [{ title: "Task", agent: "explore", prompt: "..." }, ...] })
- Wait: job_wait({ job_ids: ["id1", "id2"], mode: "all" })

**Communication model:**
- Caller -> subagent job: job_subagent_send (optional, for follow-ups)
- job_emit: progress / intermediate results (pollable; caller reads via job_subagent_read/job_wait)
- job_notify: questions / urgent issues (push; triggers [Job Notification] in caller; avoid for one-shot final result)
- job_complete({ output: ... }): final one-shot result (no push; caller reads via job_wait/job_subagent_read)
- job_fail({ error: "..." }): terminal failure (no push; caller reads via job_wait/job_get)

**Bridge tools (available inside the subagent job only):**
- job_emit: progress / intermediate results (pollable)
- job_notify: questions / urgent issues (push; interactive)
- job_complete: finish and return final result
- job_fail: finish with error message`
  },

  params: z.object({
    agent: z.string().describe("Agent to use"),
    prompt: z.string().describe("Task for the agent"),
    session_id: z.string().optional().describe("Existing session to continue"),
  }),

  input: z.object({
    text: z.string(),
  }),

  output: OUTPUT_SCHEMA,

  async start(ctx) {
    // Validate agent exists and is not primary
    const agent = await Agent.get(ctx.params.agent)
    if (!agent) {
      await ctx.fail(`Unknown agent: ${ctx.params.agent}`)
      return
    }
    if (agent.mode === "primary") {
      await ctx.fail(`Cannot use primary agent as subagent: ${ctx.params.agent}`)
      return
    }

    // Validate session_id exists if provided
    if (ctx.params.session_id) {
      const existing = await Session.get(ctx.params.session_id).catch(() => null)
      if (!existing) {
        await ctx.fail(`Session not found: ${ctx.params.session_id}`)
        return
      }
    }

    const workerSessionID = ctx.params.session_id ?? (await Session.create({ parentID: ctx.sessionID })).id

    await ctx.setMetadata({ workerSessionID, agent: ctx.params.agent })

    let completed = false
    const queue: Array<{ text: string }> = []
    let resolver: ((input: { text: string } | null) => void) | null = null

    const receive = (): Promise<{ text: string } | null> => {
      return new Promise((resolve) => {
        const item = queue.shift()
        if (item) {
          resolve(item)
          return
        }
        resolver = resolve
      })
    }

    ctx.onInput((input) => {
      if (resolver) {
        resolver(input)
        resolver = null
        return
      }
      queue.push(input)
    })

    ctx.onSignal((signal) => {
      if (signal === "abort") {
        SessionPrompt.cancel(workerSessionID)
        completed = true
        if (resolver) {
          resolver(null)
          resolver = null
        }
      }
    })

    // Create bridge tools that allow the worker to communicate with the parent
    const stop = () => {
      completed = true
      if (resolver) {
        resolver(null)
        resolver = null
      }
    }

    const bridgeTools = JobBridge.createTools(
      {
        ...ctx,
        complete: async (output?: z.infer<typeof OUTPUT_SCHEMA>) => {
          stop()
          await ctx.complete(output)
        },
        fail: async (error: string) => {
          stop()
          await ctx.fail(error)
        },
      },
      OUTPUT_SCHEMA,
    )
    SessionPrompt.setExtraTools(workerSessionID, Object.values(bridgeTools))

    // Job context preamble to instruct the subagent about job lifecycle
    const jobPreamble = `[Job Context]
Job ID: ${ctx.jobID}

You are running as a background subagent job (callee). Your normal chat messages are NOT visible to the caller.

Communication is ONLY via these tools:
- job_emit: progress / intermediate results (pollable; caller reads via job_subagent_read or job_wait)
- job_notify: questions / urgent issues (push; injected into the caller session; caller may reply via job_subagent_send)

Single-return pattern:
- If the task needs one final answer, return it via job_complete({ output: { type: "result", text: "..." } }). The caller reads it via job_wait/job_subagent_read.
- Do not use job_notify just to return the final answer.

When finished, call job_complete (optionally with output) or job_fail({ error: "..." }).
If the caller asks you to finalize, call job_complete/job_fail immediately.
Note: job_complete/job_fail do NOT push a notification; call job_notify first if you need the caller's attention.

[Task]
`

    let prompt: string | null = jobPreamble + ctx.params.prompt

    try {
      while (prompt !== null && !completed) {
        try {
          const parts = await SessionPrompt.resolvePromptParts(prompt)

          await SessionPrompt.prompt({
            sessionID: workerSessionID,
            agent: ctx.params.agent,
            parts,
          })

          if (completed) break

          await ctx.emit({ type: "progress", text: "Completed step" })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log.error("subagent prompt failed", { error: message, workerSessionID })
          // If completed (aborted), don't notify error - just exit
          if (!completed) {
            await ctx.notify({ type: "error", text: message })
          }
        }

        if (completed) break

        const input = await receive()
        if (input === null) break
        prompt = input.text || null
      }

      // If job was aborted/completed externally, don't try to complete again
      if (!completed) {
        await ctx.complete({ type: "result", text: "Task completed" })
      }
    } finally {
      // Clean up bridge tools when job finishes
      SessionPrompt.clearExtraTools(workerSessionID)
    }
  },
})
