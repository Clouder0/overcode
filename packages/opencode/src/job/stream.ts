import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { Storage } from "@/storage/storage"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import { NamedError } from "@opencode-ai/util/error"
import { Config } from "@/config/config"
import z from "zod"

export namespace JobStream {
  const log = Log.create({ service: "job.stream" })
  const DEFAULT_MAX_FRAMES_PER_JOB = 65536

  export const InvalidJobIDError = NamedError.create(
    "JobStreamInvalidJobIDError",
    z.object({
      jobID: z.string(),
    }),
  )

  function assertSafeJobID(jobID: string) {
    // Prevent path traversal / invalid storage key usage.
    // We keep this intentionally loose: job IDs are generated internally, but
    // this module is also callable directly.
    if (jobID.includes("/") || jobID.includes("\\") || jobID.includes("..") || jobID.includes("\0")) {
      throw new InvalidJobIDError({ jobID })
    }

    const parsed = Identifier.schema("job").safeParse(jobID)
    if (!parsed.success) {
      throw new InvalidJobIDError({ jobID })
    }
  }

  // Helper to get configured max frames limit
  async function getMaxFrames(): Promise<number> {
    const cfg = await Config.get()
    return cfg.job?.maxFrames ?? DEFAULT_MAX_FRAMES_PER_JOB
  }

  export const FrameQuotaExceededError = NamedError.create(
    "JobStreamFrameQuotaExceededError",
    z.object({
      jobID: z.string(),
      limit: z.number(),
      current: z.number(),
    }),
  )
  export const Frame = z
    .object({
      id: Identifier.schema("job_frame"),
      jobID: Identifier.schema("job"),
      direction: z.enum(["in", "out"]),
      data: z.unknown(),
      notify: z.boolean(),
      time: z.object({
        created: z.number(),
      }),
    })
    .meta({
      ref: "JobStreamFrame",
    })

  export type Frame = z.infer<typeof Frame>

  export const Event = {
    Output: BusEvent.define(
      "job.output",
      z.object({
        jobID: z.string(),
        sessionID: z.string(),
        frame: Frame,
      }),
    ),
  }

  export async function append(input: {
    jobID: string
    sessionID: string
    direction: "in" | "out"
    data: unknown
    notify?: boolean
    skipQuotaCheck?: boolean
  }): Promise<Frame> {
    assertSafeJobID(input.jobID)

    // Serialize append operations per job to prevent TOCTOU race condition on quota check
    const lockKey = `job-stream:${input.jobID}`
    using _lock = await Lock.write(lockKey)

    if (!input.skipQuotaCheck) {
      const maxFrames = await getMaxFrames()
      const existingFrames = await Storage.list(["job_stream", input.jobID])
      if (existingFrames.length >= maxFrames) {
        throw new FrameQuotaExceededError({
          jobID: input.jobID,
          limit: maxFrames,
          current: existingFrames.length,
        })
      }
    }

    const frame: Frame = {
      id: Identifier.ascending("job_frame"),
      jobID: input.jobID,
      direction: input.direction,
      data: input.data,
      notify: input.notify ?? false,
      time: {
        created: Date.now(),
      },
    }

    await Storage.write(["job_stream", input.jobID, frame.id], frame)

    if (frame.direction === "out") {
      await Bus.publish(Event.Output, { jobID: input.jobID, sessionID: input.sessionID, frame }).catch((e) =>
        log.warn("failed to publish job stream output event", { jobID: input.jobID, frameID: frame.id, error: e }),
      )
    }

    return frame
  }

  export async function list(input: { jobID: string; after?: string; limit?: number }): Promise<Frame[]> {
    assertSafeJobID(input.jobID)

    // Keys are already sorted by Storage.list() - frame IDs use Identifier.ascending() for lexicographic ordering
    const keys = await Storage.list(["job_stream", input.jobID])

    // Filter keys by cursor BEFORE reading (optimization)
    let filteredKeys = keys
    if (input.after) {
      filteredKeys = keys.filter((key) => {
        const frameId = key[key.length - 1]!
        return frameId > input.after!
      })
    }

    // Apply limit to keys BEFORE reading (optimization)
    if (input.limit !== undefined) {
      filteredKeys = filteredKeys.slice(0, input.limit)
    }

    // Parallel reads instead of sequential
    const frames = await Promise.all(filteredKeys.map((key) => Storage.read<Frame>(key).catch(() => undefined)))

    return frames.filter((f): f is Frame => f !== undefined)
  }

  export async function latest(input: {
    jobID: string
    direction?: "in" | "out"
    notify?: boolean
  }): Promise<Frame | undefined> {
    assertSafeJobID(input.jobID)

    // Get all frame keys for this job
    const keys = await Storage.list(["job_stream", input.jobID])

    // Read frames in reverse order (most recent first) until we find a match
    for (let i = keys.length - 1; i >= 0; i--) {
      const frame = await Storage.read<Frame>(keys[i]).catch(() => undefined)
      if (!frame) continue

      // Apply filters
      if (input.direction !== undefined && frame.direction !== input.direction) continue
      if (input.notify !== undefined && frame.notify !== input.notify) continue

      return frame
    }

    return undefined
  }
}
