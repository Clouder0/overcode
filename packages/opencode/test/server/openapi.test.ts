import path from "node:path"
import { describe, expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"

const projectRoot = path.join(__dirname, "../..")

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

function pathParams(input: string) {
  const matches = input.match(/\{([^}]+)\}/g) ?? []
  return matches.map((m) => m.slice(1, -1))
}

describe("openapi generation", () => {
  test("does not leak path parameters across operations", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const spec = await Server.openapi()
        if (!isRecord(spec)) {
          throw new Error("OpenAPI spec is not an object")
        }

        const paths = spec["paths"]
        if (!isRecord(paths)) {
          throw new Error("OpenAPI spec missing paths")
        }

        const problems: string[] = []

        for (const [route, item] of Object.entries(paths)) {
          if (!isRecord(item)) continue

          const expected = new Set(pathParams(route))

          for (const [method, op] of Object.entries(item)) {
            if (!["get", "post", "put", "patch", "delete"].includes(method)) continue
            if (!isRecord(op)) continue

            const params = op["parameters"]
            const actual = new Set<string>()
            if (Array.isArray(params)) {
              for (const p of params) {
                if (!isRecord(p)) continue
                if (p["in"] !== "path") continue
                const name = p["name"]
                if (typeof name !== "string") continue
                actual.add(name)
              }
            }

            for (const name of actual) {
              if (expected.has(name)) continue
              problems.push(`extra path param ${method.toUpperCase()} ${route}: ${name}`)
            }

            for (const name of expected) {
              if (actual.has(name)) continue
              problems.push(`missing path param ${method.toUpperCase()} ${route}: ${name}`)
            }
          }
        }

        expect(problems).toEqual([])
      },
    })
  })

  test("keeps /path query params stable", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const spec = await Server.openapi()
        if (!isRecord(spec)) {
          throw new Error("OpenAPI spec is not an object")
        }

        const paths = spec["paths"]
        if (!isRecord(paths)) {
          throw new Error("OpenAPI spec missing paths")
        }

        const item = paths["/path"]
        if (!isRecord(item)) {
          throw new Error("OpenAPI spec missing /path")
        }

        const op = item["get"]
        if (!isRecord(op)) {
          throw new Error("OpenAPI spec missing GET /path")
        }

        const params = op["parameters"]
        const queries = new Map<string, boolean>()
        if (Array.isArray(params)) {
          for (const p of params) {
            if (!isRecord(p)) continue
            if (p["in"] !== "query") continue
            const name = p["name"]
            if (typeof name !== "string") continue
            queries.set(name, p["required"] === true)
          }
        }

        expect(queries.get("directory")).toBe(false)
        expect(queries.has("provider")).toBe(false)
        expect(queries.has("model")).toBe(false)
      },
    })
  })
})
