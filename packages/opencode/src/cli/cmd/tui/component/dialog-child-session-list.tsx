import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useTheme } from "@tui/context/theme"
import { createMemo, onMount } from "solid-js"
import { buildChildSessionPickerOptions } from "../lib/child-session-picker"
import "opentui-spinner/solid"

export function DialogChildSessionList(props: { sessionID: string }) {
  const dialog = useDialog()
  const sync = useSync()
  const route = useRoute()
  const { theme } = useTheme()

  onMount(() => {
    dialog.setSize("large")
  })

  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

  const options = createMemo(() => {
    const sessions = sync.data.session.map((s) => ({
      id: s.id,
      title: s.title,
      parentID: s.parentID,
      time: { updated: s.time.updated },
    }))

    const baseOptions = buildChildSessionPickerOptions({
      currentSessionID: props.sessionID,
      sessions,
      permissionsBySession: sync.data.permission,
    }).options

    // Enhance options with status indicators
    return baseOptions.map((opt) => {
      const status = sync.data.session_status?.[opt.value]
      const isWorking = status?.type === "busy" || status?.type === "retry"
      const session = sync.data.session.find((s) => s.id === opt.value)
      const isSubagent = session?.parentID !== undefined

      return {
        ...opt,
        title: isSubagent ? `${isWorking ? "◐" : "✓"} ${opt.title}` : opt.title,
        gutter: isWorking ? (
          <spinner frames={spinnerFrames} interval={80} color={theme.warning} />
        ) : isSubagent ? (
          <text fg={theme.success}>●</text>
        ) : undefined,
      }
    })
  })

  return (
    <DialogSelect
      title="Subagent Sessions"
      options={options()}
      current={props.sessionID}
      onSelect={(option) => {
        route.navigate({
          type: "session",
          sessionID: option.value,
        })
        dialog.clear()
      }}
    />
  )
}
