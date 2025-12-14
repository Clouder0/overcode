import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Log } from "@/util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import type { JobRegistry } from "./registry"
import { JobStream } from "./stream"

export namespace JobContext {
  const log = Log.create({ service: "job.context" })

  export const InputNotDefinedError = NamedError.create(
    "JobContextInputNotDefinedError",
    z.object({ jobID: z.string() }),
  )

  export const OutputNotDefinedError = NamedError.create(
    "JobContextOutputNotDefinedError",
    z.object({ jobID: z.string() }),
  )

  export const InputAlreadyBoundError = NamedError.create(
    "JobContextInputAlreadyBoundError",
    z.object({ jobID: z.string() }),
  )

  export const SignalAlreadyBoundError = NamedError.create(
    "JobContextSignalAlreadyBoundError",
    z.object({ jobID: z.string() }),
  )

  export const OutputValidationError = NamedError.create(
    "JobContextOutputValidationError",
    z.object({
      jobID: z.string(),
      issues: z.custom<z.core.$ZodIssue[]>(),
    }),
  )

  export const MaxFramesExceededError = NamedError.create(
    "JobContextMaxFramesExceededError",
    z.object({
      jobID: z.string(),
      limit: z.number(),
    }),
  )

  export const Event = {
    Notify: BusEvent.define(
      "job.notify",
      z.object({
        jobID: z.string(),
        sessionID: z.string(),
        frame: JobStream.Frame,
      }),
    ),
  }

  export function create<TParams extends z.ZodType, TInput extends z.ZodType, TOutput extends z.ZodType>(input: {
    jobID: string
    sessionID: string
    params: z.infer<TParams>
    definition: JobRegistry.Definition<TParams, TInput, TOutput>
    onStatusChange: (status: "completed" | "error", error?: string) => void
    onMetadataChange?: (meta: Record<string, unknown>) => Promise<void>
  }): {
    context: JobRegistry.JobContext<TParams, TInput, TOutput>
    deliverInput: (input: z.infer<TInput>) => void
    deliverSignal: (signal: "abort") => void
  } {
    const jobID = input.jobID
    const sessionID = input.sessionID
    const definition = input.definition
    const onStatusChange = input.onStatusChange
    const onMetadataChange = input.onMetadataChange

    let inputCallback: ((data: z.infer<TInput>) => void) | undefined
    let signalCallback: ((signal: "abort") => void) | undefined
    let terminal = false

    function onInput(callback: (data: z.infer<TInput>) => void): () => void {
      if (!definition.input) {
        throw new InputNotDefinedError({ jobID })
      }
      if (inputCallback) {
        throw new InputAlreadyBoundError({ jobID })
      }
      inputCallback = callback
      return () => {
        inputCallback = undefined
      }
    }

    function onSignal(callback: (signal: "abort") => void): () => void {
      if (signalCallback) {
        throw new SignalAlreadyBoundError({ jobID })
      }
      signalCallback = callback
      return () => {
        signalCallback = undefined
      }
    }

    async function validateAndStoreOutput(output: z.infer<TOutput>, notify: boolean): Promise<void> {
      if (!definition.output) {
        throw new OutputNotDefinedError({ jobID })
      }

      const parsed = definition.output.safeParse(output)
      if (!parsed.success) {
        throw new OutputValidationError({ jobID, issues: parsed.error.issues })
      }

      let frame: JobStream.Frame
      try {
        frame = await JobStream.append({
          jobID,
          sessionID,
          direction: "out",
          data: parsed.data,
          notify,
        })
      } catch (e) {
        if (JobStream.FrameQuotaExceededError.isInstance(e)) {
          throw new MaxFramesExceededError({ jobID, limit: e.data.limit })
        }
        throw e
      }

      if (notify) {
        await Bus.publish(Event.Notify, { jobID, sessionID, frame }).catch((e) =>
          log.warn("failed to publish job notify event", { jobID, error: e }),
        )
      }
    }

    async function emit(output: z.infer<TOutput>): Promise<void> {
      if (terminal) {
        log.warn("emit called after terminal state", { jobID })
        return
      }
      await validateAndStoreOutput(output, false)
    }

    async function notify(output: z.infer<TOutput>): Promise<void> {
      if (terminal) {
        log.warn("notify called after terminal state", { jobID })
        return
      }
      await validateAndStoreOutput(output, true)
    }

    async function complete(output?: z.infer<TOutput>): Promise<void> {
      if (terminal) {
        return
      }

      if (output !== undefined) {
        if (!definition.output) {
          throw new OutputNotDefinedError({ jobID })
        }

        const parsed = definition.output.safeParse(output)
        if (!parsed.success) {
          throw new OutputValidationError({ jobID, issues: parsed.error.issues })
        }

        // complete(output) ignores maxFrames limit
        await JobStream.append({
          jobID,
          sessionID,
          direction: "out",
          data: parsed.data,
          notify: false,
          skipQuotaCheck: true,
        })
      }

      terminal = true
      onStatusChange("completed")
    }

    async function fail(error: string): Promise<void> {
      if (terminal) {
        return
      }
      terminal = true
      onStatusChange("error", error)
      log.info("job failed", { jobID, error })
    }

    async function setMetadata(meta: Record<string, unknown>): Promise<void> {
      if (onMetadataChange) {
        await onMetadataChange(meta)
      }
    }

    function deliverInput(data: z.infer<TInput>): void {
      if (inputCallback) {
        inputCallback(data)
      }
    }

    function deliverSignal(signal: "abort"): void {
      if (signalCallback) {
        signalCallback(signal)
      }
    }

    const context: JobRegistry.JobContext<TParams, TInput, TOutput> = {
      jobID,
      sessionID,
      params: input.params,
      onInput,
      onSignal,
      emit,
      notify,
      complete,
      fail,
      setMetadata,
    }

    return {
      context,
      deliverInput,
      deliverSignal,
    }
  }
}
