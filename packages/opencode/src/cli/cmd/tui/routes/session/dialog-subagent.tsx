import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createMemo } from "solid-js"

export function DialogSubagent(props: { sessionID: string }) {
  const route = useRoute()
  const sync = useSync()

  const session = createMemo(() => sync.session.get(props.sessionID))
  const status = createMemo(() => {
    const s = sync.data.session_status?.[props.sessionID]
    if (s?.type === "busy" || s?.type === "retry") return "working"
    if ((s as any)?.type === "waiting") return "waiting"
    return "idle"
  })

  const title = createMemo(() => {
    const s = session()
    const statusIcon = status() === "working" ? "🔄" : status() === "waiting" ? "⏳" : "✓"
    if (!s) return `${statusIcon} Subagent Session`
    return `${statusIcon} ${s.title || "Subagent Session"}`
  })

  return (
    <DialogSelect
      title={title()}
      options={[
        {
          title: "Open session",
          value: "subagent.view",
          description: "View the subagent's full session",
          onSelect: (dialog) => {
            route.navigate({
              type: "session",
              sessionID: props.sessionID,
            })
            dialog.clear()
          },
        },
        {
          title: "Back to parent",
          value: "subagent.parent",
          description: "Return to the caller session",
          disabled: !session()?.parentID,
          onSelect: (dialog) => {
            const parentID = session()?.parentID
            if (parentID) {
              route.navigate({
                type: "session",
                sessionID: parentID,
              })
            }
            dialog.clear()
          },
        },
      ]}
    />
  )
}
