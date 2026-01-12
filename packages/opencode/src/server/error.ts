import { resolver } from "hono-openapi"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { Session } from "../session"
import { Storage } from "../storage/storage"

export const PartMismatchError = NamedError.create(
  "PartMismatchError",
  z.object({
    expected: z.object({
      sessionID: z.string(),
      messageID: z.string(),
      partID: z.string(),
    }),
    received: z.object({
      sessionID: z.string(),
      messageID: z.string(),
      partID: z.string(),
    }),
  }),
)

export const ERRORS = {
  400: {
    description: "Bad request",
    content: {
      "application/json": {
        schema: resolver(
          z
            .discriminatedUnion("name", [Storage.InvalidKeyError.Schema, PartMismatchError.Schema])
            .or(
              z
                .object({
                  data: z.any(),
                  errors: z.array(z.record(z.string(), z.any())),
                  success: z.literal(false),
                })
                .meta({
                  ref: "BadRequestError",
                }),
            )
            .meta({
              ref: "BadRequest",
            }),
        ),
      },
    },
  },

  404: {
    description: "Not found",
    content: {
      "application/json": {
        schema: resolver(Storage.NotFoundError.Schema),
      },
    },
  },

  409: {
    description: "Conflict",
    content: {
      "application/json": {
        schema: resolver(Session.BusyError.Schema),
      },
    },
  },

  500: {
    description: "Internal server error",
    content: {
      "application/json": {
        schema: resolver(NamedError.Unknown.Schema),
      },
    },
  },
} as const

export function errors(...codes: number[]) {
  const unique = new Set<number>([...codes, 500])
  return Object.fromEntries(Array.from(unique).map((code) => [code, ERRORS[code as keyof typeof ERRORS]]))
}
