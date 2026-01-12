#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const dir = new URL("..", import.meta.url).pathname
process.chdir(dir)

const opencode = path.resolve(dir, "../../opencode")
const openapi = path.resolve(dir, "../openapi.json")

type OpencodePackage = {
  version?: string
}

const pkg = (await Bun.file(path.join(opencode, "package.json")).json()) as OpencodePackage
const version = process.env.OPENCODE_VERSION || pkg.version || "local"
const channel = process.env.OPENCODE_CHANNEL || "local"

const spec = await $`bun dev generate`
  .cwd(opencode)
  .env({ OPENCODE_VERSION: version, OPENCODE_CHANNEL: channel })
  .text()
await Bun.write(openapi, spec)

await createClient({
  input: "../openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

await $`bun prettier --write src`
await $`rm -rf dist`
await $`bun tsc`
