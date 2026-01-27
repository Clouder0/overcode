import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Log } from "@/util/log"
import { Once } from "@/util/once"

export namespace Warn {
  const log = Log.create({ service: "config" })

  function msg() {
    return 'Ignoring deprecated config field "name" in agent/mode configuration. Agent ids are derived from filenames/keys.'
  }

  export function name(input: { source: string; path?: string; id?: string; value?: unknown }) {
    log.warn("ignored deprecated config field", {
      source: input.source,
      path: input.path,
      id: input.id,
      value: input.value,
      field: "name",
    })

    Once.run("warn.config.name", () => {
      const message = msg()
      Bus.publish(TuiEvent.ToastShow, {
        title: "Deprecated config",
        message: message + ' Remove "name" to silence this warning.',
        variant: "warning",
        duration: 8000,
      }).catch(() => {})

      Bun.stderr.write("Warning: " + message + "\n")
    })
  }
}
