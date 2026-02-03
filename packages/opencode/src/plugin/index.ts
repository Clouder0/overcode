import type { Hooks, PluginInput, Plugin as PluginInstance } from "@opencode-ai/plugin"

type HookName = keyof Hooks
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { BunProc } from "../bun"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { CodexAuthPlugin } from "./codex"
import { Session } from "../session"
import { NamedError } from "@opencode-ai/util/error"
import { CopilotAuthPlugin } from "./copilot"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  const BUILTIN = ["opencode-anthropic-auth@0.0.13", "@gitlab/opencode-gitlab-auth@1.3.2"]

  // Built-in plugins that are directly imported (not installed from npm)
  const INTERNAL_PLUGINS: PluginInstance[] = [CodexAuthPlugin, CopilotAuthPlugin]

  const state = Instance.state(async () => {
    // Lazy import to avoid circular dependency during module initialization:
    // plugin -> server -> routes/session -> SessionCPD -> session -> prompt -> plugin
    const mod = await import("../server/server")

    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      // @ts-ignore - fetch type incompatibility
      fetch: async (...args) => mod.Server.App().fetch(...args),
    })
    const config = await Config.get()
    const hooks: Hooks[] = []
    const input: PluginInput = {
      client,
      project: Instance.project,
      worktree: Instance.worktree,
      directory: Instance.directory,
      serverUrl: mod.Server.url(),
      $: Bun.$,
    }

    for (const plugin of INTERNAL_PLUGINS) {
      log.info("loading internal plugin", { name: plugin.name })
      const init = await plugin(input)
      hooks.push(init)
    }

    const plugins = [...(config.plugin ?? [])]
    if (!Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS) {
      plugins.push(...BUILTIN)
    }

    for (let plugin of plugins) {
      // ignore old codex plugin since it is supported first party now
      if (plugin.includes("opencode-openai-codex-auth") || plugin.includes("opencode-copilot-auth")) continue
      log.info("loading plugin", { path: plugin })
      if (!plugin.startsWith("file://")) {
        const lastAtIndex = plugin.lastIndexOf("@")
        const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
        const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"
        const builtin = BUILTIN.some((x) => x.startsWith(pkg + "@"))
        plugin = await BunProc.install(pkg, version).catch((err) => {
          if (!builtin) throw err

          const message = err instanceof Error ? err.message : String(err)
          log.error("failed to install builtin plugin", {
            pkg,
            version,
            error: message,
          })
          Bus.publish(Session.Event.Error, {
            error: new NamedError.Unknown({
              message: `Failed to install built-in plugin ${pkg}@${version}: ${message}`,
            }).toObject(),
          })

          return ""
        })
        if (!plugin) continue
      }
      const mod = await import(plugin).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        log.error("failed to import plugin", { path: plugin, error: message })
        Bus.publish(Session.Event.Error, {
          error: new NamedError.Unknown({
            message: `Failed to load plugin ${plugin}: ${message}`,
          }).toObject(),
        })
        return undefined
      })
      if (!mod) continue
      // Prevent duplicate initialization when plugins export the same function
      // as both a named export and default export (e.g., `export const X` and `export default X`).
      // Object.entries(mod) would return both entries pointing to the same function reference.
      const seen = new Set<PluginInstance>()
      for (const [_name, fn] of Object.entries(mod)) {
        if (typeof fn !== "function") continue
        const pluginFn = fn as PluginInstance
        if (seen.has(pluginFn)) continue
        seen.add(pluginFn)
        const init = await pluginFn(input).catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          log.error("failed to initialize plugin", { path: plugin, error: message })
          Bus.publish(Session.Event.Error, {
            error: new NamedError.Unknown({
              message: `Failed to initialize plugin ${plugin}: ${message}`,
            }).toObject(),
          })
          return undefined
        })
        if (!init) continue
        hooks.push(init)
      }
    }

    return {
      hooks,
      input,
    }
  })

  export async function trigger<Name extends HookName, Input, Output>(
    name: Name,
    input: Input,
    output: Output,
  ): Promise<Output> {
    for (const hook of await state().then((x) => x.hooks)) {
      const fn = hook[name]
      if (!fn) continue
      // Hook typing is intentionally loose; plugin hook signatures vary.
      await (fn as unknown as (input: Input, output: Output) => Promise<void>)(input, output)
    }
    return output
  }

  export async function list() {
    return state().then((x) => x.hooks)
  }

  export async function init() {
    const hooks = await state().then((x) => x.hooks)
    const config = await Config.get()
    for (const hook of hooks) {
      await hook.config?.(config)
    }
    Bus.subscribeAll(async (input) => {
      const hooks = await state().then((x) => x.hooks)
      for (const hook of hooks) {
        hook["event"]?.({
          event: input,
        })
      }
    })
  }
}
