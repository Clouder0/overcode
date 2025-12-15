import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Storage } from "@/storage/storage"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { Lock } from "@/util/lock"
import { fn } from "@/util/fn"
import z from "zod"
import { JobStream } from "./stream"
import { JobRegistry } from "./registry"
import { JobContext } from "./context"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { NamedError } from "@opencode-ai/util/error"
import { Config } from "@/config/config"
import { JobInfo, JobStatus } from "./schema"

// Import job definitions to register them
import "./definitions"

export namespace Job {
  const log = Log.create({ service: "job" })

  // Default values for job limits
  const DEFAULT_MAX_CONCURRENT_SUBAGENT_JOBS = 10
  const DEFAULT_MAX_JOBS_PER_SESSION = 256

  // Helper to get configured limits
  async function getLimits() {
    const cfg = await Config.get()
    return {
      maxConcurrent: cfg.job?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SUBAGENT_JOBS,
      maxPerSession: cfg.job?.maxPerSession ?? DEFAULT_MAX_JOBS_PER_SESSION,
    }
  }

  export const InvalidIDError = NamedError.create("JobInvalidIDError", z.object({ jobID: z.string() }))

  function assertSafeJobID(jobID: string) {
    // Prevent path traversal / invalid storage key usage.
    // We intentionally keep this loose (no strict length/format limits) to avoid
    // coupling to a specific ID generator, while still blocking dangerous input.
    if (jobID.includes("/") || jobID.includes("\\") || jobID.includes("..") || jobID.includes("\0")) {
      throw new InvalidIDError({ jobID })
    }
  }

  export const NotFoundError = NamedError.create("JobNotFoundError", z.object({ jobID: z.string() }))

  export const UnknownAgentError = NamedError.create("JobUnknownAgentError", z.object({ agentName: z.string() }))

  export const ConcurrencyLimitError = NamedError.create(
    "JobConcurrencyLimitError",
    z.object({
      parentSessionID: z.string(),
      limit: z.number(),
      current: z.number(),
    }),
  )

  export const QuotaExceededError = NamedError.create(
    "JobQuotaExceededError",
    z.object({
      parentSessionID: z.string(),
      limit: z.number(),
      current: z.number(),
    }),
  )

  export const DefinitionNotFoundError = NamedError.create("JobDefinitionNotFoundError", z.object({ type: z.string() }))

  export const InputNotDefinedError = NamedError.create("JobInputNotDefinedError", z.object({ jobID: z.string() }))

  export const InputValidationError = NamedError.create(
    "JobInputValidationError",
    z.object({ jobID: z.string(), issues: z.custom<z.core.$ZodIssue[]>() }),
  )

  export const ParamsValidationError = NamedError.create(
    "JobParamsValidationError",
    z.object({ definition: z.string(), issues: z.custom<z.core.$ZodIssue[]>() }),
  )

  export const MissingParentSessionError = NamedError.create(
    "JobMissingParentSessionError",
    z.object({ jobID: z.string() }),
  )

  export const ParentSessionNotFoundError = NamedError.create(
    "JobParentSessionNotFoundError",
    z.object({ parentSessionID: z.string() }),
  )

  export const PrimaryAgentNotAllowedError = NamedError.create(
    "JobPrimaryAgentNotAllowedError",
    z.object({ agentName: z.string() }),
  )

  // Re-export schemas from schema.ts to avoid circular dependencies
  export const Status = JobStatus
  export type Status = z.infer<typeof Status>

  export const Info = JobInfo
  export type Info = z.infer<typeof Info>

  export const TerminalStateError = NamedError.create(
    "JobTerminalStateError",
    z.object({ jobID: z.string(), status: Status }),
  )

  export function isTerminal(status: Status): boolean {
    return status === "completed" || status === "error" || status === "canceled"
  }

  export const Event = {
    Created: BusEvent.define(
      "job.created",
      z.object({
        info: Info,
      }),
    ),
    Updated: BusEvent.define(
      "job.updated",
      z.object({
        info: Info,
      }),
    ),
    Deleted: BusEvent.define(
      "job.deleted",
      z.object({
        id: Identifier.schema("job"),
      }),
    ),
  }

  type RuntimeJob = {
    abort?: AbortController
    active: boolean
    removed?: boolean
    context?: {
      deliverInput: (input: unknown) => void
      deliverSignal: (signal: "abort") => void
    }
  }

  const state = Instance.state(
    () => new Map<string, RuntimeJob>(),
    async (jobs) => {
      for (const job of jobs.values()) {
        job.abort?.abort()
      }
      jobs.clear()
    },
  )

  async function write(info: Info) {
    await Storage.write(["job", info.projectID, info.id], info)
  }

  // Internal helper to get a single job by ID (for internal use)
  async function getJobInternal(jobID: string): Promise<Info> {
    assertSafeJobID(jobID)
    const projectID = Instance.project.id
    try {
      return await Storage.read<Info>(["job", projectID, jobID])
    } catch (error) {
      if (Storage.NotFoundError.isInstance(error)) {
        throw new NotFoundError({ jobID })
      }
      throw error
    }
  }

  async function update(jobID: string, fn: (draft: Info) => void): Promise<Info> {
    const project = Instance.project
    try {
      const info = await Storage.update<Info>(["job", project.id, jobID], (draft) => {
        fn(draft as Info)
        ;(draft as Info).time.updated = Date.now()
      })
      await Bus.publish(Event.Updated, { info }).catch((e) =>
        log.warn("failed to publish job update event", { jobID, error: e }),
      )
      return info
    } catch (error) {
      if (Storage.NotFoundError.isInstance(error)) {
        throw new NotFoundError({ jobID })
      }
      throw error
    }
  }

  export const get = fn(
    z.object({ jobIDs: z.array(z.string()) }),
    async (
      input,
    ): Promise<{
      jobs: Array<{
        id: string
        found: boolean
        type?: string
        title?: string
        status?: Status
        error?: string
        metadata?: Record<string, unknown>
        time?: { created: number; started?: number; completed?: number }
        lookup_error?: string
      }>
    }> => {
      const project = Instance.project
      const results = []

      for (const jobID of input.jobIDs) {
        try {
          assertSafeJobID(jobID)
          const info = await Storage.read<Info>(["job", project.id, jobID])
          results.push({
            id: jobID,
            found: true,
            type: info.type,
            title: info.title,
            status: info.status,
            error: info.error,
            metadata: info.metadata,
            time: info.time,
          })
        } catch (error) {
          if (Storage.NotFoundError.isInstance(error)) {
            results.push({ id: jobID, found: false, lookup_error: "Job not found" })
          } else if (InvalidIDError.isInstance(error)) {
            results.push({ id: jobID, found: false, lookup_error: "Invalid job ID" })
          } else {
            results.push({ id: jobID, found: false, lookup_error: "Access denied" })
          }
        }
      }

      return { jobs: results }
    },
  )

  export const list = fn(
    z
      .object({
        type: z.string().optional(),
        parentSessionID: z.string().optional(),
        status: Status.optional(),
        limit: z.number().optional(),
      })
      .optional(),
    async (input): Promise<Info[]> => {
      const project = Instance.project
      const items = await Storage.list(["job", project.id])

      const result: Info[] = []
      const limit = input?.limit

      for (const key of items) {
        try {
          const info = await Storage.read<Info>(key)
          if (input?.type && info.type !== input.type) continue
          if (input?.parentSessionID && info.parentSessionID !== input.parentSessionID) continue
          if (input?.status && info.status !== input.status) continue
          result.push(info)
        } catch (error) {
          if (!Storage.NotFoundError.isInstance(error)) {
            log.warn("failed to read job", { key, error })
          }
        }
      }

      result.sort((a, b) => b.time.created - a.time.created)

      if (limit !== undefined) {
        return result.slice(0, limit)
      }
      return result
    },
  )

  export const cancel = fn(
    z.object({ jobIDs: z.array(z.string()) }),
    async (
      input,
    ): Promise<{
      jobs: Array<{
        id: string
        success: boolean
        status: Status
        error?: string
      }>
    }> => {
      const results = []

      for (const jobID of input.jobIDs) {
        try {
          assertSafeJobID(jobID)
          using _jobLock = await Lock.write(`job-op:${jobID}`)

          const jobs = state()
          const runtime = jobs.get(jobID)

          // If there is an active run, signal abort and let the per-run executor
          // handle status transitions and logging.
          if (runtime?.active && runtime.abort) {
            runtime.abort.abort()
          } else {
            let workerSessionID: string | undefined

            await update(jobID, (draft) => {
              workerSessionID = draft.metadata?.workerSessionID as string | undefined
              if (draft.status === "pending" || draft.status === "running") {
                draft.status = "canceled"
                draft.time.completed = draft.time.completed ?? Date.now()
              }
            })

            // Best-effort cancellation if there is no runtime entry but we still
            // have a worker session.
            if (!runtime && workerSessionID) {
              SessionPrompt.cancel(workerSessionID)
            }
          }

          // Get current status after cancel attempt
          const { jobs: jobResults } = await get({ jobIDs: [jobID] })
          const job = jobResults[0]
          results.push({
            id: jobID,
            success: true,
            status: job?.found ? job.status! : "canceled",
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error"
          results.push({
            id: jobID,
            success: false,
            status: "error" as Status,
            error: message,
          })
        }
      }

      return { jobs: results }
    },
  )

  export const remove = fn(z.string(), async (jobID): Promise<void> => {
    assertSafeJobID(jobID)
    using _jobLock = await Lock.write(`job-op:${jobID}`)

    const project = Instance.project
    const jobs = state()

    // Mark job as removed to prevent any further stream/status writes.
    const runtime = jobs.get(jobID) ?? { active: false }
    runtime.removed = true
    jobs.set(jobID, runtime)

    // Read job info BEFORE removing from storage to get workerSessionID
    let workerSessionID: string | undefined
    try {
      const info = await Storage.read<Info>(["job", project.id, jobID])
      workerSessionID = info.metadata?.workerSessionID as string | undefined
    } catch {
      // Job may already be deleted, continue with cleanup
    }

    // Abort the job if it's currently running
    if (runtime.active && runtime.abort) {
      runtime.abort.abort()
    }

    // Best-effort job file removal
    await Storage.remove(["job", project.id, jobID]).catch((e) => {
      if (!Storage.NotFoundError.isInstance(e)) {
        log.warn("failed to remove job file", { jobID, error: e })
      }
    })

    // Best-effort worker session cleanup
    if (workerSessionID) {
      await Session.remove(workerSessionID).catch((e) => {
        log.warn("failed to remove worker session", { jobID, workerSessionID, error: e })
      })
    }

    // Best-effort stream cleanup with parallel removal.
    // Take the same per-job stream lock used by JobStream.append to avoid
    // leaving behind frames created concurrently with removal.
    try {
      using _streamLock = await Lock.write(`job-stream:${jobID}`)
      const streamKeys = await Storage.list(["job_stream", jobID])
      await Promise.all(
        streamKeys.map((key) =>
          Storage.remove(key).catch((e) => {
            log.warn("failed to remove job stream frame", { jobID, key, error: e })
          }),
        ),
      )
    } catch (e) {
      log.warn("failed to list job stream for cleanup", { jobID, error: e })
    }

    await Bus.publish(Event.Deleted, { id: jobID }).catch((e) =>
      log.warn("failed to publish job deleted event", { jobID, error: e }),
    )

    // If there is no active executor, clear runtime tombstone.
    if (!runtime.active) {
      jobs.delete(jobID)
    }
  })

  // ============================================================================
  // Generic Job API
  // ============================================================================

  export const CreateInput = z.object({
    definition: z.string(),
    sessionID: Identifier.schema("session"),
    title: z.string(),
    params: z.unknown(),
  })

  export type CreateInput = z.infer<typeof CreateInput>

  async function executeJob(input: {
    jobID: string
    sessionID: string
    definition: JobRegistry.Definition
    params: unknown
  }): Promise<void> {
    const jobs = state()
    const runtime = jobs.get(input.jobID)
    if (!runtime) return

    const { context, deliverInput, deliverSignal } = JobContext.create({
      jobID: input.jobID,
      sessionID: input.sessionID,
      params: input.params,
      definition: input.definition,
      onStatusChange: async (status, error) => {
        if (state().get(input.jobID)?.removed) return
        const now = Date.now()
        await update(input.jobID, (draft) => {
          draft.status = status
          draft.time.completed = now
          if (status === "error" && error) {
            draft.error = error
          }
        }).catch((e) => log.error("failed to update job status", { jobID: input.jobID, error: e }))
      },
      onMetadataChange: async (meta) => {
        if (state().get(input.jobID)?.removed) return
        await update(input.jobID, (draft) => {
          draft.metadata = { ...(draft.metadata ?? {}), ...meta }
        }).catch((e) => log.error("failed to update job metadata", { jobID: input.jobID, error: e }))
      },
    })

    // Store context callbacks in runtime for send() to use
    runtime.context = { deliverInput, deliverSignal }

    // Subscribe to abort signal
    const controller = runtime.abort
    if (controller) {
      const abortHandler = () => deliverSignal("abort")
      controller.signal.addEventListener("abort", abortHandler)
    }

    try {
      await input.definition.start(context)

      // If the job was aborted but didn't call complete/fail, set status to canceled
      if (runtime.abort?.signal.aborted) {
        const { jobs: jobResults } = await get({ jobIDs: [input.jobID] }).catch(() => ({ jobs: [] }))
        const currentJob = jobResults[0]
        if (currentJob?.found && currentJob.status && !isTerminal(currentJob.status)) {
          await update(input.jobID, (draft) => {
            draft.status = "canceled"
            draft.time.completed = Date.now()
          }).catch((err) => log.error("failed to update job status on abort", { jobID: input.jobID, error: err }))
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (state().get(input.jobID)?.removed) return
      const now = Date.now()
      await update(input.jobID, (draft) => {
        draft.status = "error"
        draft.time.completed = now
        draft.error = msg
      }).catch((err) => log.error("failed to update job status on error", { jobID: input.jobID, error: err }))
    } finally {
      const rt = state().get(input.jobID)
      if (rt) {
        rt.active = false
        rt.abort = undefined
        rt.context = undefined
        jobs.delete(input.jobID)
      }
      // Try to start the next pending job in this session
      startNextPendingJob(input.sessionID).catch((e) =>
        log.warn("failed to start next pending job", { sessionID: input.sessionID, error: e }),
      )
    }
  }

  /**
   * Start the next pending job in a session if there's available capacity.
   * If a pending job's definition is not found, marks it as error and tries the next one.
   */
  async function startNextPendingJob(sessionID: string): Promise<void> {
    // Use a write lock to prevent race conditions when multiple jobs complete simultaneously
    const lockKey = `job-start-pending:${sessionID}`
    using _lock = await Lock.write(lockKey)

    const limits = await getLimits()

    // Loop to handle cases where a pending job's definition is not found
    while (true) {
      // Get all jobs in the session
      const sessionJobs = await list({ parentSessionID: sessionID })

      // Count currently running jobs
      const runningCount = sessionJobs.filter((j) => j.status === "running").length

      // If we're at capacity, don't start anything
      if (runningCount >= limits.maxConcurrent) return

      // Find the oldest pending job
      const pendingJobs = sessionJobs.filter((j) => j.status === "pending")
      if (pendingJobs.length === 0) return

      // Sort by creation time (oldest first)
      pendingJobs.sort((a, b) => a.time.created - b.time.created)
      const nextJob = pendingJobs[0]

      // Get the definition
      const definition = JobRegistry.get(nextJob.type)
      if (!definition) {
        log.warn("definition not found for pending job", { jobID: nextJob.id, type: nextJob.type })
        // Mark as error and try next pending job
        await update(nextJob.id, (draft) => {
          draft.status = "error"
          draft.time.completed = Date.now()
          draft.error = `Job definition "${nextJob.type}" not found`
        }).catch((e) => log.error("failed to mark job as error", { jobID: nextJob.id, error: e }))
        continue
      }

      // Update job status to running
      const now = Date.now()
      await update(nextJob.id, (draft) => {
        draft.status = "running"
        draft.time.started = now
      })

      // Set up runtime and execute
      const jobs = state()
      const runtime: RuntimeJob = {
        active: true,
        abort: new AbortController(),
      }
      jobs.set(nextJob.id, runtime)

      executeJob({
        jobID: nextJob.id,
        sessionID: nextJob.parentSessionID,
        definition,
        params: nextJob.params,
      }).catch((e) => log.error("pending job execution failed", { jobID: nextJob.id, error: e }))

      // Started a job, exit the loop
      return
    }
  }

  export const create = fn(CreateInput, async (input): Promise<Info> => {
    // 1. Get definition from JobRegistry
    const definition = JobRegistry.get(input.definition)
    if (!definition) {
      throw new DefinitionNotFoundError({ type: input.definition })
    }

    // 2. Validate params against definition.params schema
    const parsed = definition.params.safeParse(input.params)
    if (!parsed.success) {
      throw new ParamsValidationError({ definition: input.definition, issues: parsed.error.issues })
    }

    // 3. Check parent session exists
    try {
      await Session.get(input.sessionID)
    } catch (error) {
      if (Storage.NotFoundError.isInstance(error)) {
        throw new ParentSessionNotFoundError({ parentSessionID: input.sessionID })
      }
      throw error
    }

    // Use a write lock to serialize the check-and-create operation per session.
    // Lock is per-session (not per-definition) to prevent quota bypass when creating different job types concurrently.
    const lockKey = `job-create:${input.sessionID}`
    using _lock = await Lock.write(lockKey)

    const limits = await getLimits()

    // 4. Check quota (maxPerSession) - count ALL jobs in session regardless of type
    const allSessionJobs = await list({
      parentSessionID: input.sessionID,
    })
    if (allSessionJobs.length >= limits.maxPerSession) {
      throw new QuotaExceededError({
        parentSessionID: input.sessionID,
        limit: limits.maxPerSession,
        current: allSessionJobs.length,
      })
    }

    // 5. Check concurrency (maxConcurrent) - if over, set status to "pending"
    const runningCount = allSessionJobs.filter((j) => j.status === "running").length
    const shouldPend = runningCount >= limits.maxConcurrent

    // 6. Create job record with status "running" or "pending"
    const now = Date.now()
    const info: Info = {
      id: Identifier.descending("job"),
      projectID: Instance.project.id,
      type: input.definition,
      title: input.title,
      parentSessionID: input.sessionID,
      status: shouldPend ? "pending" : "running",
      params: parsed.data,
      time: {
        created: now,
        updated: now,
        started: shouldPend ? undefined : now,
      },
    }

    await write(info)
    await Bus.publish(Event.Created, { info }).catch((e) =>
      log.warn("failed to publish job created event", { jobID: info.id, error: e }),
    )

    // 7. If running, start the job execution using definition.start(context)
    if (!shouldPend) {
      const jobs = state()
      const runtime: RuntimeJob = {
        active: true,
        abort: new AbortController(),
      }
      jobs.set(info.id, runtime)

      executeJob({
        jobID: info.id,
        sessionID: input.sessionID,
        definition,
        params: parsed.data,
      }).catch((e) => log.error("generic job execution failed", { jobID: info.id, error: e }))
    }

    // 8. Return job info
    return info
  })

  export const CreateBatchInput = z.object({
    definition: z.string(),
    sessionID: Identifier.schema("session"),
    jobs: z.array(
      z.object({
        title: z.string(),
        params: z.unknown(),
      }),
    ),
  })

  export type CreateBatchInput = z.infer<typeof CreateBatchInput>

  export const createBatch = fn(
    CreateBatchInput,
    async (
      input,
    ): Promise<{
      jobs: Array<{
        id?: string
        title: string
        status?: Status
        error?: string
      }>
    }> => {
      const definition = JobRegistry.get(input.definition)
      if (!definition) {
        return {
          jobs: input.jobs.map((j) => ({
            title: j.title,
            error: `Definition not found: ${input.definition}`,
          })),
        }
      }

      // Verify session exists
      try {
        await Session.get(input.sessionID)
      } catch {
        return {
          jobs: input.jobs.map((j) => ({
            title: j.title,
            error: "Session not found",
          })),
        }
      }

      const results = []

      for (const job of input.jobs) {
        try {
          // Validate params
          const parsed = definition.params.safeParse(job.params)
          if (!parsed.success) {
            results.push({
              title: job.title,
              error: `Invalid params: ${parsed.error.message}`,
            })
            continue
          }

          // Create job WITHOUT concurrency limit check
          const now = Date.now()
          const info: Info = {
            id: Identifier.descending("job"),
            projectID: Instance.project.id,
            type: input.definition,
            title: job.title,
            parentSessionID: input.sessionID,
            status: "running", // Always start running, no pending
            params: parsed.data,
            time: {
              created: now,
              updated: now,
              started: now,
            },
          }

          await write(info)
          await Bus.publish(Event.Created, { info })

          // Start execution
          const jobs = state()
          const runtime: RuntimeJob = {
            active: true,
            abort: new AbortController(),
          }
          jobs.set(info.id, runtime)

          executeJob({
            jobID: info.id,
            sessionID: input.sessionID,
            definition,
            params: parsed.data,
          }).catch((e) => log.error("batch job execution failed", { jobID: info.id, error: e }))

          // Get current status (might have completed already)
          const current = await Storage.read<Info>(["job", Instance.project.id, info.id]).catch(() => info)

          results.push({
            id: info.id,
            title: job.title,
            status: current.status,
          })
        } catch (error) {
          results.push({
            title: job.title,
            error: error instanceof Error ? error.message : "Unknown error",
          })
        }
      }

      return { jobs: results }
    },
  )

  export const SendInput = z.object({
    jobID: z.string(),
    input: z.unknown(),
  })

  export type SendInput = z.infer<typeof SendInput>

  export const send = fn(SendInput, async (input): Promise<void> => {
    assertSafeJobID(input.jobID)

    // 1. Get job info
    const info = await getJobInternal(input.jobID)

    // 2. Get definition from registry by job.type
    const definition = JobRegistry.get(info.type)
    if (!definition) {
      throw new DefinitionNotFoundError({ type: info.type })
    }

    // 3. Throw if definition has no input schema
    if (!definition.input) {
      throw new InputNotDefinedError({ jobID: input.jobID })
    }

    // 4. Validate input against definition.input schema
    const parsed = definition.input.safeParse(input.input)
    if (!parsed.success) {
      throw new InputValidationError({ jobID: input.jobID, issues: parsed.error.issues })
    }

    // 5. Throw if job is terminal or pending (pending jobs have no runtime to receive input)
    if (isTerminal(info.status) || info.status === "pending") {
      throw new TerminalStateError({ jobID: input.jobID, status: info.status })
    }

    // 6. Store input frame via JobStream.append
    await JobStream.append({
      jobID: input.jobID,
      sessionID: info.parentSessionID,
      direction: "in",
      data: parsed.data,
    })

    // 7. Deliver input to running job context (via runtime state)
    const runtime = state().get(input.jobID)
    if (runtime?.context) {
      runtime.context.deliverInput(parsed.data)
    }
  })

  export const SendBatchInput = z.object({
    inputs: z.array(
      z.object({
        jobID: z.string(),
        input: z.unknown(),
      }),
    ),
  })

  export type SendBatchInput = z.infer<typeof SendBatchInput>

  export const sendBatch = fn(
    SendBatchInput,
    async (
      input,
    ): Promise<{
      jobs: Array<{
        job_id: string
        success: boolean
        error?: string
      }>
    }> => {
      const results = []

      for (const item of input.inputs) {
        try {
          // Use existing send logic
          await send({ jobID: item.jobID, input: item.input })
          results.push({ job_id: item.jobID, success: true })
        } catch (error) {
          results.push({
            job_id: item.jobID,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          })
        }
      }

      return { jobs: results }
    },
  )

  export const ReadInput = z.object({
    jobIDs: z.array(z.string()),
    limit: z.number().optional(),
  })

  export type ReadInput = z.infer<typeof ReadInput>

  /**
   * Read output frames from jobs.
   * Returns only output frames (direction: "out").
   */
  export const read = fn(
    ReadInput,
    async (
      input,
    ): Promise<{
      jobs: Array<{
        id: string
        found: boolean
        status?: Status
        frames?: JobStream.Frame[]
        error?: string
      }>
    }> => {
      const results = []

      for (const jobID of input.jobIDs) {
        try {
          assertSafeJobID(jobID)
          const { jobs } = await get({ jobIDs: [jobID] })
          const jobInfo = jobs[0]

          if (!jobInfo?.found) {
            results.push({ id: jobID, found: false, error: jobInfo?.lookup_error })
            continue
          }

          const frames = await JobStream.list({
            jobID,
            limit: input.limit,
          })

          // Return most recent frames (output direction only)
          const outputFrames = frames.filter((f) => f.direction === "out")

          results.push({
            id: jobID,
            found: true,
            status: jobInfo.status,
            frames: outputFrames,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error"
          results.push({ id: jobID, found: false, error: message })
        }
      }

      return { jobs: results }
    },
  )

  export const WaitInput = z.object({
    jobIDs: z.array(z.string()),
    mode: z.enum(["all", "any"]).default("all"),
    timeout: z.number().optional().describe("Timeout in milliseconds. Defaults to 300000 (5 minutes)"),
  })

  export type WaitInput = z.infer<typeof WaitInput>

  export const WaitResult = z.object({
    completed: z.array(
      z.object({
        id: z.string(),
        status: Status,
        output: z.string().optional(),
        error: z.string().optional(),
      }),
    ),
    pending: z.array(
      z.object({
        id: z.string(),
        status: Status,
      }),
    ),
    errors: z.array(
      z.object({
        id: z.string(),
        error: z.string(),
      }),
    ),
  })

  export type WaitResult = z.infer<typeof WaitResult>

  // Keep WaitOutput for backward compatibility type reference
  export const WaitOutput = WaitResult
  export type WaitOutput = WaitResult

  export const wait = fn(WaitInput, async (input): Promise<WaitResult> => {
    const timeout = input.timeout ?? 5 * 60 * 1000
    const completed: Array<{ id: string; status: Status; output?: string; error?: string }> = []
    const pending: Array<{ id: string; status: Status }> = []
    const errors: Array<{ id: string; error: string }> = []

    // Validate all job IDs first
    const validJobIDs: string[] = []
    for (const jobID of input.jobIDs) {
      try {
        assertSafeJobID(jobID)
        const { jobs } = await get({ jobIDs: [jobID] })
        const jobInfo = jobs[0]
        if (!jobInfo?.found) {
          errors.push({ id: jobID, error: jobInfo?.lookup_error ?? "Job not found" })
        } else if (isTerminal(jobInfo.status!)) {
          // Already terminal
          const frames = await JobStream.list({ jobID })
          const lastOutput = frames.filter((f) => f.direction === "out").pop()
          completed.push({
            id: jobID,
            status: jobInfo.status!,
            output: lastOutput
              ? typeof lastOutput.data === "string"
                ? lastOutput.data
                : JSON.stringify(lastOutput.data)
              : undefined,
            error: jobInfo.error,
          })
        } else {
          validJobIDs.push(jobID)
        }
      } catch (e) {
        errors.push({ id: jobID, error: e instanceof Error ? e.message : "Unknown error" })
      }
    }

    // If mode is "any" and we already have completed jobs, return immediately
    if (input.mode === "any" && completed.length > 0) {
      for (const jobID of validJobIDs) {
        const { jobs } = await get({ jobIDs: [jobID] })
        const jobInfo = jobs[0]
        if (jobInfo?.found) {
          pending.push({ id: jobID, status: jobInfo.status! })
        }
      }
      return { completed, pending, errors }
    }

    // No valid jobs to wait for
    if (validJobIDs.length === 0) {
      return { completed, pending, errors }
    }

    // Wait for jobs using event subscription
    return new Promise((resolve) => {
      const jobStates = new Map<string, Status>()
      for (const id of validJobIDs) {
        jobStates.set(id, "running")
      }

      let timeoutId: Timer | undefined

      const cleanup = () => {
        unsub()
        if (timeoutId) clearTimeout(timeoutId)
      }

      const checkCompletion = async () => {
        const allTerminal = [...jobStates.values()].every((s) => isTerminal(s))
        const anyTerminal = [...jobStates.values()].some((s) => isTerminal(s))

        const shouldResolve = input.mode === "all" ? allTerminal : anyTerminal

        if (shouldResolve) {
          cleanup()

          // Build final results
          for (const [jobID, status] of jobStates) {
            if (isTerminal(status)) {
              const { jobs } = await get({ jobIDs: [jobID] })
              const frames = await JobStream.list({ jobID })
              const lastOutput = frames.filter((f) => f.direction === "out").pop()
              completed.push({
                id: jobID,
                status,
                output: lastOutput
                  ? typeof lastOutput.data === "string"
                    ? lastOutput.data
                    : JSON.stringify(lastOutput.data)
                  : undefined,
                error: jobs[0]?.error,
              })
            } else {
              pending.push({ id: jobID, status })
            }
          }

          resolve({ completed, pending, errors })
        }
      }

      const unsub = Bus.subscribe(Event.Updated, async (event) => {
        const info = event.properties.info
        if (jobStates.has(info.id)) {
          jobStates.set(info.id, info.status)
          await checkCompletion()
        }
      })

      // Timeout handler
      timeoutId = setTimeout(async () => {
        cleanup()

        for (const [jobID, status] of jobStates) {
          if (isTerminal(status)) {
            const { jobs } = await get({ jobIDs: [jobID] })
            const frames = await JobStream.list({ jobID })
            const lastOutput = frames.filter((f) => f.direction === "out").pop()
            completed.push({
              id: jobID,
              status,
              output: lastOutput
                ? typeof lastOutput.data === "string"
                  ? lastOutput.data
                  : JSON.stringify(lastOutput.data)
                : undefined,
              error: jobs[0]?.error,
            })
          } else {
            pending.push({ id: jobID, status })
          }
        }

        resolve({ completed, pending, errors })
      }, timeout)
    })
  })

  /**
   * Recovers orphaned jobs that were left in "running" or "pending" status
   * after an application crash or unexpected restart.
   *
   * @returns The number of jobs that were recovered
   */
  export async function recoverOrphanedJobs(): Promise<number> {
    const runningJobs = await list({ status: "running" })
    const pendingJobs = await list({ status: "pending" })
    const allOrphaned = [...runningJobs, ...pendingJobs]

    let recovered = 0
    for (const job of allOrphaned) {
      // Check if job is actually running in memory
      const runtime = state().get(job.id)
      if (!runtime?.active) {
        try {
          // This is an orphaned job - mark as error
          const now = Date.now()
          await update(job.id, (draft) => {
            draft.status = "error"
            draft.time.completed = now
            draft.error = "Job interrupted by application restart"
            draft.metadata = {
              ...draft.metadata,
              recoveredAt: now,
            }
          })
          log.info("recovered orphaned job", { jobID: job.id, previousStatus: job.status })
          recovered++
        } catch (error) {
          log.warn("failed to recover orphaned job", { jobID: job.id, error })
        }
      }
    }
    return recovered
  }
}
