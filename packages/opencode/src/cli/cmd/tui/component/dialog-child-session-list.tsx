import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { createMemo, onMount } from "solid-js"
import { buildChildSessionPickerOptions } from "../lib/child-session-picker"

export function DialogChildSessionList(props: { sessionID: string }) {
  const dialog = useDialog()
  const sync = useSync()
  const route = useRoute()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo(() => {
    const current = sync.session.get(props.sessionID)
    const rootID = current?.parentID ?? current?.id ?? props.sessionID

    const sessions = sync.data.session.map((s) => ({
      id: s.id,
      title: s.title,
      parentID: s.parentID,
      time: { updated: s.time.updated },
    }))

    const jobs = (sync.data.job[rootID] ?? []).map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      metadata: j.metadata,
      time: {
        created: j.time.created,
        updated: j.time.updated,
        started: j.time.started,
        completed: j.time.completed,
      },
    }))

    return buildChildSessionPickerOptions({
      currentSessionID: props.sessionID,
      sessions,
      jobs,
      permissionsBySession: sync.data.permission,
    }).options
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
