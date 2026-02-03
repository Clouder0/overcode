import { BusEvent } from "@/bus/bus-event"
import path from "path"
import { $ } from "bun"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { Log } from "../util/log"
import { iife } from "@/util/iife"
import { Flag } from "../flag/flag"

declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_ECOSYSTEM_VERSION: string
}

export namespace Installation {
  const log = Log.create({ service: "installation" })

  export type Method = Awaited<ReturnType<typeof method>>

  export const Event = {
    Updated: BusEvent.define(
      "installation.updated",
      z.object({
        version: z.string(),
      }),
    ),
    UpdateAvailable: BusEvent.define(
      "installation.update-available",
      z.object({
        version: z.string(),
      }),
    ),
  }

  export const Info = z
    .object({
      version: z.string(),
      latest: z.string(),
    })
    .meta({
      ref: "InstallationInfo",
    })
  export type Info = z.infer<typeof Info>

  export async function info() {
    return {
      version: VERSION,
      latest: await latest(),
    }
  }

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }

  export async function method() {
    if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl"
    if (process.execPath.includes(path.join(".local", "bin"))) return "curl"
    const exec = process.execPath.toLowerCase()

    const checks = [
      {
        name: "npm" as const,
        command: () => $`npm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "yarn" as const,
        command: () => $`yarn global list`.throws(false).quiet().text(),
      },
      {
        name: "pnpm" as const,
        command: () => $`pnpm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "bun" as const,
        command: () => $`bun pm ls -g`.throws(false).quiet().text(),
      },
      {
        name: "brew" as const,
        command: () => $`brew list --formula overcode`.throws(false).quiet().text(),
      },
      {
        name: "scoop" as const,
        command: () => $`scoop list overcode`.throws(false).quiet().text(),
      },
      {
        name: "choco" as const,
        command: () => $`choco list --limit-output overcode`.throws(false).quiet().text(),
      },
    ]

    checks.sort((a, b) => {
      const aMatches = exec.includes(a.name)
      const bMatches = exec.includes(b.name)
      if (aMatches && !bMatches) return -1
      if (!aMatches && bMatches) return 1
      return 0
    })

    for (const check of checks) {
      const output = await check.command()
      const installedName =
        check.name === "brew" || check.name === "choco" || check.name === "scoop" ? "overcode" : "overcode-ai"
      if (output.includes(installedName)) {
        return check.name
      }
    }

    return "unknown"
  }

  export const UpgradeFailedError = NamedError.create(
    "UpgradeFailedError",
    z.object({
      stderr: z.string(),
    }),
  )

  async function getBrewFormula() {
    const coreFormula = await $`brew list --formula overcode`.throws(false).quiet().text()
    if (coreFormula.includes("overcode")) return "overcode"
    return "overcode"
  }

  export async function upgrade(method: Method, target: string) {
    const run = async (cmd: ReturnType<typeof $>) => {
      const result = await cmd.quiet().throws(false)
      if (result.exitCode !== 0) {
        const stderr =
          method === "choco" ? "not running from an elevated command shell" : result.stderr.toString("utf8")
        throw new UpgradeFailedError({
          stderr: stderr,
        })
      }
      log.info("upgraded", {
        method,
        target,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      })
      await $`${process.execPath} --version`.nothrow().quiet().text()
    }

    if (method === "curl") {
      const cmd = $`curl -fsSL https://opencode.ai/install | bash`.env({
        ...process.env,
        VERSION: target,
      })
      await run(cmd)
      return
    }

    if (method === "npm") {
      await run($`npm install -g overcode-ai@${target}`)
      return
    }

    if (method === "pnpm") {
      await run($`pnpm install -g overcode-ai@${target}`)
      return
    }

    if (method === "bun") {
      await run($`bun install -g overcode-ai@${target}`)
      return
    }

    if (method === "brew") {
      const formula = await getBrewFormula()
      const cmd = $`brew upgrade ${formula}`.env({
        HOMEBREW_NO_AUTO_UPDATE: "1",
        ...process.env,
      })
      await run(cmd)
      return
    }

    if (method === "choco") {
      await run($`echo Y | choco upgrade overcode --version=${target}`)
      return
    }

    if (method === "scoop") {
      await run($`scoop install overcode@${target}`)
      return
    }

    throw new Error(`Unknown method: ${method}`)
  }

  export const VERSION =
    typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : process.env.OPENCODE_VERSION || "local"
  export const CHANNEL =
    typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : process.env.OPENCODE_CHANNEL || "local"

  // The npm ecosystem (sdk/plugin) version this binary expects.
  //
  // Overcode's distribution version may not match upstream opencode's semver,
  // so we cannot safely pin helper deps (like @opencode-ai/plugin) using VERSION.
  export const ECOSYSTEM_VERSION =
    typeof OPENCODE_ECOSYSTEM_VERSION === "string"
      ? OPENCODE_ECOSYSTEM_VERSION
      : process.env.OPENCODE_ECOSYSTEM_VERSION || (VERSION.startsWith("1.") ? VERSION : "latest")
  export const USER_AGENT = `opencode/${CHANNEL}/${VERSION}/${Flag.OPENCODE_CLIENT}`

  export async function latest(installMethod?: Method) {
    const detectedMethod = installMethod || (await method())

    if (detectedMethod === "brew") {
      const formula = await getBrewFormula()
      if (formula === "overcode") {
        return fetch("https://formulae.brew.sh/api/formula/overcode.json")
          .then((res) => {
            if (!res.ok) throw new Error(res.statusText)
            return res.json()
          })
          .then((data: any) => data.versions.stable)
      }
    }

    if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
      const registry = await iife(async () => {
        const r = (await $`npm config get registry`.quiet().nothrow().text()).trim()
        const reg = r || "https://registry.npmjs.org"
        return reg.endsWith("/") ? reg.slice(0, -1) : reg
      })
      const channel = CHANNEL
      return fetch(`${registry}/overcode-ai/${channel}`)
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    if (detectedMethod === "choco") {
      return fetch(
        "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27opencode%27%20and%20IsLatestVersion&$select=Version",
        { headers: { Accept: "application/json;odata=verbose" } },
      )
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.d.results[0].Version)
    }

    if (detectedMethod === "scoop") {
      return fetch("https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/opencode.json", {
        headers: { Accept: "application/json" },
      })
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    return fetch("https://api.github.com/repos/anomalyco/opencode/releases/latest")
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText)
        return res.json()
      })
      .then((data: any) => data.tag_name.replace(/^v/, ""))
  }
}
