import { resolver } from "hono-openapi"
import z from "zod"
import { Storage } from "../storage/storage"

export const ERRORS = {
  400: {
    description: "Bad request",
    content: {
      "application/json": {
        schema: resolver(
          z
            .discriminatedUnion("name", [Storage.InvalidKeyError.Schema, Storage.NotFoundError.Schema])
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
} as const

export function errors(...codes: number[]) {
  return Object.fromEntries(codes.map((code) => [code, ERRORS[code as keyof typeof ERRORS]]))
}
