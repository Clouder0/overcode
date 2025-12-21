import z from "zod"
import type { JobRegistry } from "@/job/registry"
import { Tool } from "./tool"

export namespace JobBridge {
  export function createTools(
    context: JobRegistry.JobContext<z.ZodType, z.ZodType, z.ZodType>,
    outputSchema: z.ZodType = z.unknown(),
  ): Record<string, Tool.Info> {
    return {
      job_emit: Tool.define("job_emit", {
        description:
          "Send output to the caller (pollable frame, no push). Use this for progress or non-urgent intermediate results; the caller reads via job_*_read or job_wait.",
        parameters: z.object({
          output: outputSchema.describe("Output data to emit"),
        }),
        async execute(params) {
          await context.emit(params.output)
          return {
            title: "Output emitted",
            metadata: {},
            output: "Output sent successfully",
          }
        },
      }),

      job_notify: Tool.define("job_notify", {
        description:
          "Notify the caller immediately (push). Use this for questions or urgent issues; it will be injected into the caller session as a job notification. Do not use it for a one-shot final result—use job_complete.",
        parameters: z.object({
          output: outputSchema.describe("Output data to notify"),
        }),
        async execute(params) {
          await context.notify(params.output)
          // Include the notification content in metadata for inline display on callee side
          const text = typeof params.output === "string" ? params.output : JSON.stringify(params.output)
          return {
            title: "Notification sent",
            metadata: {
              notificationText: text,
              notificationTime: Date.now(),
            },
            output: "Notification sent successfully",
          }
        },
      }),

      job_complete: Tool.define("job_complete", {
        description:
          "Mark the job as complete and optionally return a final result (no push). The caller captures the output via job_wait or job_*_read.",
        parameters: z.object({
          output: outputSchema.optional().describe("Optional final output data"),
        }),
        async execute(params) {
          await context.complete(params.output)
          return {
            title: "Job completed",
            metadata: {},
            output: "Job marked as complete",
          }
        },
      }),

      job_fail: Tool.define("job_fail", {
        description:
          "Mark the job as failed (no push). The caller captures the error via job_wait/job_get. Use job_notify first if you need immediate attention.",
        parameters: z.object({
          error: z.string().describe("Error message explaining why the job failed"),
        }),
        async execute(params) {
          await context.fail(params.error)
          return {
            title: "Job failed",
            metadata: {},
            output: `Job marked as failed: ${params.error}`,
          }
        },
      }),
    }
  }
}
