import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createMemo, createSignal, createResource, onMount, Show } from "solid-js"
import { Locale } from "@/util/locale"
import { Filesystem } from "@/util/filesystem"
import path from "path"
import { useKeybind } from "../context/keybind"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { DialogSessionRename } from "./dialog-session-rename"
import { useKV } from "../context/kv"
import { createDebouncedSignal } from "../util/signal"
import { DialogAlert } from "../ui/dialog-alert"
import "opentui-spinner/solid"

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const keybind = useKeybind()
  const { theme } = useTheme()
  const sdk = useSDK()
  const kv = useKV()

  const [toDelete, setToDelete] = createSignal<string>()
  const [search, setSearch] = createDebouncedSignal("", 150)

  const [searchResults] = createResource(search, async (query) => {
    if (!query) return undefined
    const result = await sdk.client.session.list({
      search: query,
      limit: 30,
      scope: "auto",
    })
    return result.data ?? []
  })

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

  const sessions = createMemo(() => searchResults() ?? sync.data.session)

  const currentWorktree = createMemo(() => {
    // Prefer the git worktree root when available. This lets us distinguish
    // sessions from a different checkout vs sessions started in a subdirectory.
    return sync.data.path.worktree || sync.data.path.directory || sdk.directory || ""
  })

  const options = createMemo(() => {
    const today = new Date().toDateString()
    return sessions()
      .filter((x) => x.parentID === undefined)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .map((x) => {
        const date = new Date(x.time.updated)
        let category = date.toDateString()
        if (category === today) {
          category = "Today"
        }
        const isDeleting = toDelete() === x.id
        const status = sync.data.session_status?.[x.id]
        const isWorking = status?.type === "busy"
        const root = currentWorktree()
        const foreign = !!root && !Filesystem.contains(root, x.directory)
        const footer = foreign
          ? `${Locale.time(x.time.updated)} · ${path.basename(x.directory)}`
          : Locale.time(x.time.updated)

        return {
          title: isDeleting ? `Press ${keybind.print("session_delete")} again to confirm` : x.title,
          bg: isDeleting ? theme.error : undefined,
          value: x.id,
          category,
          footer,
          gutter: isWorking ? (
            <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
              <spinner frames={spinnerFrames} interval={80} color={theme.primary} />
            </Show>
          ) : undefined,
        }
      })
  })

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title="Sessions"
      options={options()}
      skipFilter={true}
      current={currentSessionID()}
      onFilter={setSearch}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={(option) => {
        void (async () => {
          const selected = sessions().find((x) => x.id === option.value)
          if (!selected) {
            route.navigate({
              type: "session",
              sessionID: option.value,
            })
            dialog.clear()
            return
          }

          const root = currentWorktree()
          // If this session belongs to the current git worktree (or we can't tell),
          // keep existing semantics: open it in its owning directory.
          if (!root || Filesystem.contains(root, selected.directory)) {
            route.navigate({
              type: "session",
              sessionID: selected.id,
            })
            dialog.clear()
            return
          }

          // Foreign checkout (linked worktree): move the session into the current directory
          // to avoid running tools/prompts in the other checkout.
          const statuses = await sdk.client.session.status().catch(() => undefined)
          const status = statuses?.data?.[selected.id]
          if (status && status.type !== "idle") {
            await DialogAlert.show(dialog, "Session is busy", "Wait for it to become idle before continuing it here.")
            return
          }

          const moved = await sdk.client.session.handoff({ sessionID: selected.id }).catch(() => undefined)
          const movedID = moved?.data?.id
          if (!movedID) {
            await DialogAlert.show(dialog, "Failed to continue", "Could not continue the selected session here.")
            return
          }
          route.navigate({
            type: "session",
            sessionID: movedID,
          })
          dialog.clear()
        })()
      }}
      keybind={[
        {
          keybind: keybind.all.session_delete?.[0],
          title: "delete",
          onTrigger: async (option) => {
            if (toDelete() === option.value) {
              sdk.client.session.delete({
                sessionID: option.value,
              })
              setToDelete(undefined)
              return
            }
            setToDelete(option.value)
          },
        },
        {
          keybind: keybind.all.session_rename?.[0],
          title: "rename",
          onTrigger: async (option) => {
            dialog.replace(() => <DialogSessionRename session={option.value} />)
          },
        },
      ]}
    />
  )
}
