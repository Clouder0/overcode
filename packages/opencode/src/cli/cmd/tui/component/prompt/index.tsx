import { BoxRenderable, TextareaRenderable, MouseEvent, PasteEvent, t, dim, fg } from "@opentui/core"
import { createEffect, createMemo, type JSX, onMount, createSignal, onCleanup, Show, Switch, Match } from "solid-js"
import "opentui-spinner/solid"
import { useLocal } from "@tui/context/local"
import { useTheme } from "@tui/context/theme"
import { EmptyBorder } from "@tui/component/border"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { Identifier } from "@/id/id"
import { createStore, produce } from "solid-js/store"
import { useKeybind } from "@tui/context/keybind"
import { usePromptHistory, type PromptInfo } from "./history"
import { usePromptQueue } from "./queue"
import { usePromptStash } from "./stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useCommandDialog } from "../dialog-command"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Editor } from "@tui/util/editor"
import { useExit } from "../../context/exit"
import { Clipboard } from "../../util/clipboard"
import type { FilePart } from "@opencode-ai/sdk/v2"
import { TuiEvent } from "../../event"
import { iife } from "@/util/iife"
import { Locale } from "@/util/locale"
import { createColors, createFrames } from "../../ui/spinner.ts"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogAlert } from "../../ui/dialog-alert"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { useTextareaKeybindings } from "../textarea-keybindings"
import { getBufferEndOffset as bufferEndOffset } from "../../lib/buffer-offset"
import { locateTokensByOffset } from "../../lib/prompt-token-offset"
import { cols, maxLineCols } from "../../lib/cols"
import { truncateEnd, truncateMiddle } from "../../lib/cols"
import { expandPromptPastes } from "../../lib/prompt-paste"
import { twice } from "../../lib/twice"

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef) => void
  hint?: JSX.Element
  showPlaceholder?: boolean
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const PLACEHOLDERS = ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"]

function DialogPasteEditor(props: { value: string; onSave: (value: string) => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  let textarea: TextareaRenderable

  const height = createMemo(() => {
    const h = dimensions().height
    return Math.max(6, Math.min(20, h - 16))
  })

  onMount(() => {
    dialog.setSize("large")
    setTimeout(() => {
      textarea.focus()
    }, 1)
    textarea.gotoBufferEnd()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>Edit pasted text</text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <textarea
        height={height()}
        ref={(val: TextareaRenderable) => {
          textarea = val
        }}
        initialValue={props.value}
        backgroundColor={theme.backgroundPanel}
        focusedBackgroundColor={theme.backgroundPanel}
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.text}
        onKeyDown={(e) => {
          if (e.ctrl && e.name === "s") {
            props.onSave(textarea.plainText)
            dialog.clear()
            e.preventDefault()
            return
          }
        }}
      />
      <box paddingBottom={1} flexDirection="row" gap={1}>
        <text fg={theme.text}>
          ctrl+s <span style={{ fg: theme.textMuted }}>save</span>
        </text>
        <text fg={theme.text}>
          esc <span style={{ fg: theme.textMuted }}>cancel</span>
        </text>
      </box>
    </box>
  )
}

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  let autocomplete: AutocompleteRef

  const keybind = useKeybind()
  const local = useLocal()
  const sdk = useSDK()
  const route = useRoute()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })

  const [waitNow, setWaitNow] = createSignal(Date.now())
  createEffect(() => {
    if ((status() as any).type !== "waiting") return
    const timer = setInterval(() => setWaitNow(Date.now()), 250)
    onCleanup(() => clearInterval(timer))
  })

  const waitText = createMemo(() => {
    const s = status() as any
    if (s.type !== "waiting") return ""

    const sources = Array.isArray(s.sources) ? (s.sources as string[]) : ([] as string[])
    const mode = typeof s.mode === "string" ? s.mode : "?"
    const timeoutMs = typeof s.timeout === "number" ? s.timeout : undefined
    const timeout = timeoutMs === undefined ? "?" : `${Math.round(timeoutMs / 1000)}s`
    const since = typeof s.since === "number" ? s.since : undefined

    const deadline = s.time?.deadline as number | undefined
    const leftMs = deadline === undefined ? undefined : Math.max(0, deadline - waitNow())
    const left = leftMs === undefined ? undefined : `${Math.ceil(leftMs / 1000)}s left`

    const sourceName = (id: string) => {
      if (!id.startsWith("ses_")) return id
      const shortId = id.slice(-4)
      const session = sync.session.get(id)
      if (session?.title?.startsWith("Subagent - ")) return `${session.title.slice(11)}#${shortId}`
      if (session?.title) return `${session.title}#${shortId}`
      return `session#${shortId}`
    }

    const targets = (() => {
      if (sources.length === 1 && sources[0] === "*") return "any session"
      if (sources.length === 0) return "no sessions"

      const names = sources.map(sourceName)
      const shown = names.slice(0, 2)
      const more = names.length > 2 ? ` +${names.length - 2}` : ""
      return `${shown.join(", ")}${more}`
    })()

    const sincePart = since === undefined ? "" : `, since ${since}`
    const leftPart = left === undefined ? "" : ` · ${left}`
    return `Waiting (${mode}, ${timeout}${sincePart}) on ${targets}${leftPart}`
  })
  // For subagent sessions, get the locked agent name from the session
  const session = createMemo(() => (props.sessionID ? sync.session.get(props.sessionID) : undefined))
  const lockedAgentName = createMemo(() => (session() as any)?.agentName as string | undefined)
  const displayAgentName = createMemo(() => lockedAgentName() ?? local.agent.current().name)

  // Get the effective agent for subagent sessions
  const effectiveAgent = createMemo(() => {
    const agentName = lockedAgentName()
    if (agentName) {
      const agents = sync.data.agent
      const found = agents.find((a) => a.name === agentName)
      if (found) return found
    }
    return local.agent.current()
  })

  // Get the effective model - for subagent sessions with configured model, use that
  const effectiveModel = createMemo(() => {
    const agent = effectiveAgent()
    const isSubagent = !!lockedAgentName()

    // If this is a subagent session and the agent has a configured model, use it
    if (isSubagent && agent?.model) {
      return {
        providerID: agent.model.providerID,
        modelID: agent.model.modelID,
      }
    }

    // Otherwise use the user's selected model
    return local.model.current()
  })

  // For display: get parsed model info
  const effectiveModelParsed = createMemo(() => {
    const agent = effectiveAgent()
    const isSubagent = !!lockedAgentName()

    if (isSubagent && agent?.model) {
      return {
        model: agent.model.modelID,
        provider: agent.model.providerID,
      }
    }

    return local.model.parsed()
  })

  const history = usePromptHistory()
  const stash = usePromptStash()
  const queue = usePromptQueue()

  function statusCode(error: unknown) {
    if (!error || typeof error !== "object") return

    const direct = (error as { status?: unknown }).status
    if (typeof direct === "number") return direct

    const response = (error as { response?: unknown }).response
    if (!response || typeof response !== "object") return
    const nested = (response as { status?: unknown }).status
    if (typeof nested === "number") return nested
  }

  function responseStatus(result: unknown) {
    if (!result || typeof result !== "object") return
    const response = (result as { response?: unknown }).response
    if (!response || typeof response !== "object") return
    const status = (response as { status?: unknown }).status
    if (typeof status === "number") return status
  }

  const command = useCommandDialog()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const tall = createMemo(() => dimensions().height > 40)
  const wide = createMemo(() => dimensions().width > 120)
  const { theme, syntax } = useTheme()
  const kv = useKV()

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  const textareaKeybindings = useTextareaKeybindings()

  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  const pasteSelectedStyleId = syntax().getStyleId("extmark.paste.selected")!
  let promptPartTypeId = 0
  let pasteFocusTypeId = 0
  let pasteFocusOverlayId: number | undefined

  sdk.event.on(TuiEvent.PromptAppend.type, (evt) => {
    input.insertText(evt.properties.text)
    setTimeout(() => {
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m) => m.role === "user")
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    partByExtmarkId: Map<number, PromptInfo["parts"][number]>
    recentRemovedExtmarkIds: number[]
    interrupt: number
    placeholder: number
    suspend: boolean
    pasteFocus: { extmarkId: number; side: "left" | "right" } | null
  }>({
    placeholder: Math.floor(Math.random() * PLACEHOLDERS.length),
    suspend: false,
    pasteFocus: null,
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    partByExtmarkId: new Map(),
    recentRemovedExtmarkIds: [],
    interrupt: 0,
  })

  // Avoid abort/prompt races: when users interrupt and immediately submit, a late abort can
  // cancel the newly started prompt loop. Track abort in-flight and await it in submit().
  const [aborting, setAborting] = createSignal<
    | {
        sessionID: string
        promise: Promise<void>
      }
    | undefined
  >(undefined)

  const exitWindow = 1000
  const [armed, setArmed] = createSignal(0)
  const arm = (now: number) => {
    setArmed(now)
    setTimeout(() => {
      if (armed() !== now) return
      setArmed(0)
    }, exitWindow)
  }

  // Initialize agent/model/variant from last user message when session changes.
  // Keep this scoped to primary sessions so viewing a subagent transcript doesn't
  // mutate the global model/variant selection.
  let syncedSessionID: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastUserMessage()

    if (sessionID !== syncedSessionID) {
      if (!sessionID || !msg) return

      const session = sync.session.get(sessionID)
      if (!session || session.sessionType === "subagent") return

      syncedSessionID = sessionID

      // Only set agent if it's a primary agent (not a subagent)
      const isPrimaryAgent = local.agent.list().some((x) => x.name === msg.agent)
      if (msg.agent && isPrimaryAgent) {
        local.agent.set(msg.agent)
      }
      if (msg.model) local.model.set(msg.model)
      if (msg.variant) local.model.variant.set(msg.variant)
    }
  })

  command.register(() => {
    return [
      {
        title: "Clear prompt",
        value: "prompt.clear",
        category: "Prompt",
        hidden: true,
        onSelect: (dialog) => {
          input.extmarks.clear()
          input.clear()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        value: "prompt.submit",
        hidden: true,
        keybind: "input_submit",
        category: "Prompt",
        onSelect: (dialog) => {
          if (!input.focused) return
          submit()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        value: "prompt.paste",
        hidden: true,
        keybind: "input_paste",
        category: "Prompt",
        onSelect: async () => {
          const content = await Clipboard.read()
          if (content?.mime.startsWith("image/")) {
            await pasteImage({
              filename: "clipboard",
              mime: content.mime,
              content: content.data,
            })
          }
        },
      },
      {
        title: "Expand all pastes",
        value: "prompt.paste.expandAll",
        category: "Prompt",
        onSelect: (dialog) => {
          expandAllPastes()
          dialog.clear()
        },
      },
      {
        title: "Toggle paste default collapse",
        value: "prompt.paste.defaultCollapse",
        category: "Prompt",
        onSelect: (dialog) => {
          const next = !kv.get("paste_collapse_default", true)
          kv.set("paste_collapse_default", next)
          toast.show({
            message: `Default paste collapse: ${next ? "on" : "off"}`,
            variant: "info",
          })
          dialog.clear()
        },
      },

      {
        title: "Interrupt session",
        value: "session.interrupt",
        keybind: "session_interrupt",
        disabled: status().type === "idle",
        category: "Session",
        onSelect: (dialog) => {
          if (autocomplete.visible) return
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            const promise = sdk.client.session
              .abort({
                sessionID: props.sessionID,
              })
              .then(() => undefined)
              .catch(() => undefined)
            setAborting({ sessionID: props.sessionID, promise })
            void promise.finally(() => {
              const current = aborting()
              if (!current) return
              if (current.promise !== promise) return
              setAborting(undefined)
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        keybind: "editor_open",
        value: "prompt.editor",
        slash: {
          name: "editor",
        },
        onSelect: async (dialog, trigger) => {
          dialog.clear()

          const text = textWithExpandedPastes()

          const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

          const value = trigger === "prompt" ? "" : text
          const content = await Editor.open({ value, renderer })
          if (content === undefined) return

          input.setText(content)

          // Update positions for nonTextParts based on their location in new content.
          // IMPORTANT: extmark offsets are visual offsets (wcwidth-ish), not JS string indices.
          const endOffset = getBufferEndOffset()

          const items: { token: string; hint: number; part: PromptInfo["parts"][number] }[] = []

          for (const part of nonTextParts) {
            if (part.type === "file" && part.source?.text) {
              items.push({ part, token: part.source.text.value, hint: part.source.text.start })
              continue
            }

            if (part.type === "agent" && part.source) {
              items.push({ part, token: part.source.value, hint: part.source.start })
            }
          }

          const result = locateTokensByOffset({
            items,
            getTextRange: input.getTextRange.bind(input),
            endOffset,
            widthMethod: renderer.widthMethod,
          })

          const positions = new Map<PromptInfo["parts"][number], { start: number; end: number }>()
          for (const match of result.matches) {
            positions.set(match.item.part, { start: match.start, end: match.end })
          }

          let removed = 0
          const updatedNonTextParts = nonTextParts.flatMap((part) => {
            if (part.type === "file" && part.source?.text) {
              const hit = positions.get(part)
              if (!hit) {
                removed++
                return []
              }

              return [
                {
                  ...part,
                  source: {
                    ...part.source,
                    text: {
                      ...part.source.text,
                      start: hit.start,
                      end: hit.end,
                    },
                  },
                },
              ]
            }

            if (part.type === "agent" && part.source) {
              const hit = positions.get(part)
              if (!hit) {
                removed++
                return []
              }

              return [
                {
                  ...part,
                  source: {
                    ...part.source,
                    start: hit.start,
                    end: hit.end,
                  },
                },
              ]
            }

            return [part]
          })

          if (removed > 0) {
            toast.show({
              message: `Removed ${removed} reference(s) that were deleted in editor`,
              variant: "info",
            })
          }

          setStore("prompt", {
            input: content,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          input.gotoBufferEnd()
        },
      },
    ]
  })

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      submit()
    },
  }

  createEffect(() => {
    if (props.visible !== false) input?.focus()
    if (props.visible === false) input?.blur()
  })

  function clearPasteFocusOverlays() {
    pasteFocusOverlayId = undefined
    if (pasteFocusTypeId === 0) return

    const overlays = input.extmarks.getAll().filter((m) => m.typeId === pasteFocusTypeId)
    if (!overlays.length) return

    for (const overlay of overlays) {
      input.extmarks.delete(overlay.id)
    }
  }

  createEffect(() => {
    const focus = store.pasteFocus
    if (!focus) {
      input.showCursor = true
      clearPasteFocusOverlays()
      return
    }

    input.showCursor = false
    if (input.focused) {
      renderer.setCursorPosition(0, 0, false)
    }

    const extmark = input.extmarks.get(focus.extmarkId)
    if (!extmark || !extmark.virtual) {
      clearPasteFocus()
      return
    }

    if (pasteFocusTypeId === 0) return

    clearPasteFocusOverlays()

    if (extmark.end <= extmark.start) return

    pasteFocusOverlayId = input.extmarks.create({
      start: extmark.start,
      end: extmark.end,
      virtual: false,
      priority: 255,
      styleId: pasteSelectedStyleId,
      typeId: pasteFocusTypeId,
    })
  })
  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())
    setStore("partByExtmarkId", new Map())
    setStore("recentRemovedExtmarkIds", [])

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let styleId: number | undefined
      let virtual = true

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        styleId = fileStyleId
        virtual = true
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        styleId = agentStyleId
        virtual = true
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        const expanded = part.source.expanded ?? false
        styleId = expanded ? undefined : pasteStyleId
        virtual = !expanded
      }

      if (end <= start) return

      const extmarkId = input.extmarks.create({
        start,
        end,
        virtual,
        styleId,
        typeId: promptPartTypeId,
      })
      setStore("extmarkToPartIndex", (map: Map<number, number>) => {
        const newMap = new Map(map)
        newMap.set(extmarkId, partIndex)
        return newMap
      })
      setStore("partByExtmarkId", (map: Map<number, PromptInfo["parts"][number]>) => {
        const newMap = new Map(map)
        newMap.set(extmarkId, part)
        return newMap
      })
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks
      .getAll()
      .filter((extmark) => extmark.typeId === promptPartTypeId)
      .sort((a, b) => a.start - b.start)

    setStore(
      produce((draft) => {
        const previousMap = draft.extmarkToPartIndex
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []
        const cache = new Map(draft.partByExtmarkId)

        for (const extmark of allExtmarks) {
          const token = input.getTextRange(extmark.start, extmark.end)

          const existingIndex = draft.extmarkToPartIndex.get(extmark.id)
          const existingPart = existingIndex === undefined ? undefined : draft.prompt.parts[existingIndex]
          const cachedPart = cache.get(extmark.id)
          const part = existingPart ?? cachedPart

          if (!part) continue

          if (part.type === "agent" && part.source) {
            part.source.start = extmark.start
            part.source.end = extmark.end
            part.source.value = token
          } else if (part.type === "file" && part.source?.text) {
            part.source.text.start = extmark.start
            part.source.text.end = extmark.end
            part.source.text.value = token
          } else if (part.type === "text" && part.source?.text) {
            part.source.text.start = extmark.start
            part.source.text.end = extmark.end
            part.source.text.value = token
            part.source.expanded = !extmark.virtual
          }

          cache.set(extmark.id, part)
          newMap.set(extmark.id, newParts.length)
          newParts.push(part)
        }

        const removed: number[] = []
        for (const id of previousMap.keys()) {
          if (newMap.has(id)) continue
          removed.push(id)
        }

        const maxRemoved = 50
        const seen = new Set<number>()
        const nextRemoved: number[] = []
        for (const id of removed.concat(draft.recentRemovedExtmarkIds)) {
          if (newMap.has(id)) continue
          if (seen.has(id)) continue
          seen.add(id)
          nextRemoved.push(id)
          if (nextRemoved.length >= maxRemoved) break
        }

        const nextCache = new Map<number, PromptInfo["parts"][number]>()
        for (const id of newMap.keys()) {
          const part = cache.get(id)
          if (part) nextCache.set(id, part)
        }

        for (const id of nextRemoved) {
          const part = cache.get(id)
          if (part) nextCache.set(id, part)
        }

        draft.extmarkToPartIndex = newMap
        draft.recentRemovedExtmarkIds = nextRemoved
        draft.partByExtmarkId = nextCache
        draft.prompt.parts = newParts
      }),
    )
  }

  command.register(() => [
    {
      title: "Stash prompt",
      value: "prompt.stash",
      category: "Prompt",
      disabled: !store.prompt.input,
      onSelect: (dialog) => {
        if (!store.prompt.input) return
        stash.push({
          input: store.prompt.input,
          parts: store.prompt.parts,
        })
        input.extmarks.clear()
        input.clear()
        setStore("prompt", { input: "", parts: [] })
        setStore("extmarkToPartIndex", new Map())
        setStore("partByExtmarkId", new Map())
        setStore("recentRemovedExtmarkIds", [])
        dialog.clear()
      },
    },
    {
      title: "Stash pop",
      value: "prompt.stash.pop",
      category: "Prompt",
      disabled: stash.list().length === 0,
      onSelect: (dialog) => {
        const entry = stash.pop()
        if (entry) {
          input.setText(entry.input)
          setStore("prompt", { input: entry.input, parts: entry.parts })
          restoreExtmarksFromParts(entry.parts)
          input.gotoBufferEnd()
        }
        dialog.clear()
      },
    },
    {
      title: "Stash list",
      value: "prompt.stash.list",
      category: "Prompt",
      disabled: stash.list().length === 0,
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogStash
            onSelect={(entry) => {
              input.setText(entry.input)
              setStore("prompt", { input: entry.input, parts: entry.parts })
              restoreExtmarksFromParts(entry.parts)
              input.gotoBufferEnd()
            }}
          />
        ))
      },
    },
  ])

  async function submit() {
    if (props.disabled) return
    if (autocomplete?.visible) return
    if (!store.prompt.input) return
    const trimmed = store.prompt.input.trim()
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      exit()
      return
    }
    // Use effective model for subagent sessions
    const selectedModel = effectiveModel()
    if (!selectedModel) {
      promptModelWarning()
      return
    }
    const sessionID = props.sessionID
      ? props.sessionID
      : await (async () => {
          const response = await sdk.client.session.create({})
          const newSession = response.data!
          // Add session to store immediately so UI doesn't show loading state
          // The session.created event via SSE may arrive later
          sync.session.add(newSession)
          return newSession.id
        })()

    const inflight = aborting()
    if (inflight && inflight.sessionID === sessionID) {
      await inflight.promise
    }
    let inputText = textWithExpandedPastes()

    // Filter out text parts (pasted content) since they're now expanded inline
    const nonTextParts = store.prompt.parts.filter((part) => part.type !== "text")

    // Capture mode before it gets reset
    const currentMode = store.mode
    const variant = local.model.variant.current()

    // Use effective agent name for subagent sessions
    const agentName = displayAgentName()

    if (store.mode === "shell") {
      void sdk.client.session
        .shell(
          {
            sessionID,
            agent: agentName,
            model: {
              providerID: selectedModel.providerID,
              modelID: selectedModel.modelID,
            },
            command: inputText,
          },
          {
            throwOnError: false,
          },
        )
        .then((result) => {
          if (!result.error) return
          const name = result.error instanceof Error ? result.error.name : undefined
          if (name === "AbortError") return

          const status = responseStatus(result)
          if (status === 409) {
            stash.push({
              input: inputText,
              parts: nonTextParts,
            })
            toast.show({
              variant: "warning",
              message: "Session is busy; shell command stashed",
              duration: 2500,
            })
            return
          }

          stash.push({
            input: inputText,
            parts: nonTextParts,
          })
          toast.show({
            variant: "error",
            message: "Failed to run shell command; stashed for later",
            duration: 3500,
          })
        })
        .catch((error) => {
          const name = error instanceof Error ? error.name : undefined
          if (name === "AbortError") return
          stash.push({
            input: inputText,
            parts: nonTextParts,
          })
          toast.show({
            variant: "error",
            message: "Failed to run shell command; stashed for later",
            duration: 3500,
          })
        })
      setStore("mode", "normal")
    } else if (
      inputText.startsWith("/") &&
      iife(() => {
        const firstLine = inputText.split("\n")[0]
        const command = firstLine.split(" ")[0].slice(1)
        return sync.data.command.some((x) => x.name === command)
      })
    ) {
      // Parse command from first line, preserve multi-line content in arguments
      const firstLineEnd = inputText.indexOf("\n")
      const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
      const [command, ...firstLineArgs] = firstLine.split(" ")
      const restOfInput = firstLineEnd === -1 ? "" : inputText.slice(firstLineEnd + 1)
      const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")

      const messageID = Identifier.ascending("message")
      void sdk.client.session
        .command(
          {
            sessionID,
            command: command.slice(1),
            arguments: args,
            agent: agentName,
            model: `${selectedModel.providerID}/${selectedModel.modelID}`,
            messageID,
            variant,
          },
          {
            throwOnError: false,
          },
        )
        .then((result) => {
          if (!result.error) return
          const name = result.error instanceof Error ? result.error.name : undefined
          if (name === "AbortError") return

          stash.push({
            input: inputText,
            parts: nonTextParts,
          })

          const status = responseStatus(result)
          if (status === 409) {
            toast.show({
              variant: "warning",
              message: "Session is busy; command stashed",
              duration: 2500,
            })
            return
          }

          toast.show({
            variant: "error",
            message: "Failed to run command; stashed for later",
            duration: 3500,
          })
        })
        .catch((error) => {
          const name = error instanceof Error ? error.name : undefined
          if (name === "AbortError") return
          stash.push({
            input: inputText,
            parts: nonTextParts,
          })
          toast.show({
            variant: "error",
            message: "Failed to run command; stashed for later",
            duration: 3500,
          })
        })
    } else if (
      inputText.startsWith("/") &&
      iife(() => {
        const name = inputText.trim().split(/\s+/)[0]
        return command.slashes().some((s) => s.display === name || s.aliases?.includes(name))
      })
    ) {
      const name = inputText.trim().split(/\s+/)[0]
      const slash = command.slashes().find((s) => s.display === name || s.aliases?.includes(name))
      slash?.onSelect()
    } else {
      const payload = {
        sessionID,
        agent: agentName,
        model: {
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
        },
        variant,
        text: inputText,
        parts: nonTextParts,
      }

      const messageID = Identifier.ascending("message")
      void sdk.client.session
        .prompt(
          {
            sessionID,
            messageID,
            agent: agentName,
            model: payload.model,
            variant,
            parts: [
              {
                id: Identifier.ascending("part"),
                type: "text",
                text: inputText,
              },
              ...nonTextParts.map((x) => ({
                id: Identifier.ascending("part"),
                ...x,
              })),
            ],
          },
          {
            throwOnError: false,
          },
        )
        .then((result) => {
          if (!result.error) return
          const name = result.error instanceof Error ? result.error.name : undefined
          if (name === "AbortError") return

          const status = responseStatus(result)
          if (status === 409) {
            queue.enqueue(payload)
            return
          }

          stash.push({
            input: inputText,
            parts: nonTextParts,
          })
          toast.show({
            variant: "error",
            message: "Failed to send message; stashed for later",
            duration: 3500,
          })
        })
        .catch((error) => {
          const name = error instanceof Error ? error.name : undefined
          if (name === "AbortError") return

          const status = statusCode(error)
          if (status === 409) {
            queue.enqueue(payload)
            return
          }

          stash.push({
            input: inputText,
            parts: nonTextParts,
          })
          toast.show({
            variant: "error",
            message: "Failed to send message; stashed for later",
            duration: 3500,
          })
        })
    }
    history.append({
      ...store.prompt,
      mode: currentMode,
    })
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    setStore("partByExtmarkId", new Map())
    setStore("recentRemovedExtmarkIds", [])
    props.onSubmit?.()

    // Navigate to the new session immediately
    if (!props.sessionID)
      route.navigate({
        type: "session",
        sessionID,
      })
    input.clear()
  }
  const exit = useExit()

  function pasteText(text: string, virtualText: string) {
    const extmarkStart = input.visualCursor.offset

    input.insertText(virtualText)
    const extmarkEnd = input.visualCursor.offset
    input.insertText(" ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            expanded: false,
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  function pasteSummary(text: string) {
    const lines = (text.match(/\n/g)?.length ?? 0) + 1
    if (lines === 1) return "[Pasted ~1 line]"
    return `[Pasted ~${lines} lines]`
  }

  function isPasteSummaryToken(text: string) {
    return /^\[Pasted ~\d+ lines?\]$/.test(text)
  }

  function textWithExpandedPastes() {
    if (promptPartTypeId === 0) return store.prompt.input

    const result = expandPromptPastes({
      parts: store.prompt.parts,
      extmarkToPartIndex: store.extmarkToPartIndex,
      extmarks: input.extmarks.getAll(),
      promptPartTypeId,
      endOffset: getBufferEndOffset(),
      getTextRange: input.getTextRange.bind(input),
      offsetToPosition: input.editBuffer.offsetToPosition.bind(input.editBuffer),
      getTextRangeByCoords: input.editBuffer.getTextRangeByCoords.bind(input.editBuffer),
    })

    if (result.missing > 0) {
      toast.show({
        message: `Couldn't expand ${result.missing} pasted item(s); submitting placeholders as-is`,
        variant: "warning",
      })
    }

    return result.text
  }

  function getBufferEndOffset() {
    return bufferEndOffset(input.editBuffer)
  }

  function getPasteAtOffset(offset: number) {
    const marks = input.extmarks.getAtOffset(offset)
    for (const m of marks) {
      if (m.typeId !== promptPartTypeId) continue
      const partIndex = store.extmarkToPartIndex.get(m.id)
      if (partIndex === undefined) continue
      const part = store.prompt.parts[partIndex]
      if (!part || part.type !== "text" || !part.source?.text) continue
      return { extmark: m, partIndex, part }
    }
  }

  function getPasteByExtmarkId(extmarkId: number) {
    const extmark = input.extmarks.get(extmarkId)
    if (!extmark) return

    const partIndex = store.extmarkToPartIndex.get(extmarkId)
    if (partIndex === undefined) return

    const part = store.prompt.parts[partIndex]
    if (!part || part.type !== "text" || !part.source?.text) return

    return { extmark, partIndex, part }
  }

  function clearPasteFocus() {
    if (!store.pasteFocus) return
    setStore("pasteFocus", null)
  }

  function getPasteAtCursor() {
    if (!input) return
    if (promptPartTypeId === 0) return
    const offset = input.visualCursor.offset

    for (const i of [0, 1, 2, 3]) {
      const o = offset - i
      if (o < 0) break
      const hit = getPasteAtOffset(o)
      if (hit) return hit
    }
  }

  function updatePaste(hit: ReturnType<typeof getPasteAtCursor>, next: { text: string; expanded: boolean }) {
    if (!hit) return

    const part = store.prompt.parts[hit.partIndex]
    if (!part || part.type !== "text" || !part.source?.text) return

    setStore(
      produce((draft) => {
        const part = draft.prompt.parts[hit.partIndex]
        if (!part || part.type !== "text") return
        part.text = next.text
      }),
    )

    const updated = store.prompt.parts[hit.partIndex]
    if (!updated || updated.type !== "text" || !updated.source?.text) return

    setStore("partByExtmarkId", (map: Map<number, PromptInfo["parts"][number]>) => {
      const newMap = new Map(map)
      newMap.set(hit.extmark.id, updated)
      return newMap
    })

    const extmark = input.extmarks.get(hit.extmark.id)
    if (!extmark) return

    if (!extmark.virtual) {
      setStore("suspend", true)
      try {
        const startPos = input.editBuffer.offsetToPosition(extmark.start)
        const endPos = input.editBuffer.offsetToPosition(extmark.end)
        if (!startPos || !endPos) return

        input.deleteRange(startPos.row, startPos.col, endPos.row, endPos.col)
        input.cursorOffset = extmark.start
        input.insertText(next.text)
        const newEnd = input.visualCursor.offset

        const extmarkId = input.extmarks.create({
          start: extmark.start,
          end: newEnd,
          virtual: false,
          typeId: promptPartTypeId,
        })

        const value = input.plainText
        setStore(
          produce((draft) => {
            draft.prompt.input = value

            const part = draft.prompt.parts[hit.partIndex]
            if (!part || part.type !== "text" || !part.source?.text) return

            part.text = next.text
            part.source.expanded = true
            part.source.text.start = extmark.start
            part.source.text.end = newEnd
            part.source.text.value = input.getTextRange(extmark.start, newEnd)

            draft.extmarkToPartIndex.delete(hit.extmark.id)
            draft.extmarkToPartIndex.set(extmarkId, hit.partIndex)

            draft.partByExtmarkId.delete(hit.extmark.id)
            draft.partByExtmarkId.set(extmarkId, part)
          }),
        )

        autocomplete?.onInput(value)
        syncExtmarksWithPromptParts()

        input.cursorOffset = newEnd
        input.getLayoutNode().markDirty()
        renderer.requestRender()
      } finally {
        setStore("suspend", false)
      }
      return
    }

    const token = updated.source.text.value
    if (!token || !isPasteSummaryToken(token)) return

    const nextToken = pasteSummary(next.text.trimEnd())
    if (nextToken === token) return

    setStore("suspend", true)
    try {
      const startPos = input.editBuffer.offsetToPosition(extmark.start)
      const endPos = input.editBuffer.offsetToPosition(extmark.end)
      if (!startPos || !endPos) return

      input.deleteRange(startPos.row, startPos.col, endPos.row, endPos.col)
      input.cursorOffset = extmark.start
      input.insertText(nextToken)
      const newEnd = input.visualCursor.offset

      const extmarkId = input.extmarks.create({
        start: extmark.start,
        end: newEnd,
        virtual: true,
        styleId: pasteStyleId,
        typeId: promptPartTypeId,
      })

      const value = input.plainText
      setStore(
        produce((draft) => {
          draft.prompt.input = value

          const part = draft.prompt.parts[hit.partIndex]
          if (!part || part.type !== "text" || !part.source?.text) return

          part.text = next.text
          part.source.expanded = false
          part.source.text.start = extmark.start
          part.source.text.end = newEnd
          part.source.text.value = nextToken

          draft.extmarkToPartIndex.delete(hit.extmark.id)
          draft.extmarkToPartIndex.set(extmarkId, hit.partIndex)

          draft.partByExtmarkId.delete(hit.extmark.id)
          draft.partByExtmarkId.set(extmarkId, part)
        }),
      )

      autocomplete?.onInput(value)
      syncExtmarksWithPromptParts()

      input.cursorOffset = newEnd
      input.getLayoutNode().markDirty()
      renderer.requestRender()
    } finally {
      setStore("suspend", false)
    }
  }

  function deletePasteChip(extmarkId: number) {
    const hit = getPasteByExtmarkId(extmarkId)
    if (!hit) return

    let start = hit.extmark.start
    let end = hit.extmark.end
    const token = hit.part.source?.text?.value
    const cursor = input.cursorOffset

    if (hit.extmark.virtual && token) {
      const current = input.getTextRange(start, end)
      if (current !== token) {
        const len = end - start
        const findNear = (around: number) => {
          const window = Math.max(200, len * 4)
          const from = Math.max(0, around - window)
          const to = around + window
          for (let pos = from; pos <= to; pos++) {
            if (input.getTextRange(pos, pos + len) !== token) continue
            return { start: pos, end: pos + len }
          }
        }

        const found = findNear(cursor) ?? findNear(start) ?? findNear(end)
        if (!found) {
          toast.show({
            message: "Paste marker moved; can't safely delete it here",
            variant: "warning",
          })
          return
        }

        start = found.start
        end = found.end
      }
    }

    let deleteEnd = end
    if (input.getTextRange(end, end + 1) === " ") deleteEnd = end + 1

    setStore("suspend", true)
    try {
      const startPos = input.editBuffer.offsetToPosition(start)
      const endPos = input.editBuffer.offsetToPosition(deleteEnd)
      if (!startPos || !endPos) return

      input.deleteRange(startPos.row, startPos.col, endPos.row, endPos.col)

      const value = input.plainText
      setStore("prompt", "input", value)
      autocomplete?.onInput(value)
      syncExtmarksWithPromptParts()

      input.cursorOffset = start
      input.getLayoutNode().markDirty()
      renderer.requestRender()
    } finally {
      setStore("suspend", false)
    }
  }

  function expandPasteChip(extmarkId: number, options?: { quiet?: boolean }) {
    const hit = getPasteByExtmarkId(extmarkId)
    if (!hit || !hit.extmark.virtual) return false
    if (!isPasteSummaryToken(hit.part.source?.text?.value ?? "")) return false

    let start = hit.extmark.start
    let end = hit.extmark.end
    const token = hit.part.source?.text?.value
    const cursor = input.cursorOffset

    if (token) {
      const current = input.getTextRange(start, end)
      if (current !== token) {
        const len = end - start
        const findNear = (around: number) => {
          const window = Math.max(200, len * 4)
          const from = Math.max(0, around - window)
          const to = around + window
          for (let pos = from; pos <= to; pos++) {
            if (input.getTextRange(pos, pos + len) !== token) continue
            return { start: pos, end: pos + len }
          }
        }

        const found = findNear(cursor) ?? findNear(start) ?? findNear(end)
        if (!found) {
          if (!options?.quiet) {
            toast.show({
              message: "Paste marker moved; can't safely expand it here",
              variant: "warning",
            })
          }
          return false
        }

        start = found.start
        end = found.end
      }
    }

    setStore("suspend", true)
    try {
      const startPos = input.editBuffer.offsetToPosition(start)
      const endPos = input.editBuffer.offsetToPosition(end)
      if (!startPos || !endPos) return false

      input.deleteRange(startPos.row, startPos.col, endPos.row, endPos.col)

      input.cursorOffset = start
      input.insertText(hit.part.text)

      let next = input.cursorOffset
      if (input.getTextRange(next, next + 1) === " ") next++
      input.cursorOffset = next

      const value = input.plainText
      setStore("prompt", "input", value)
      autocomplete?.onInput(value)
      syncExtmarksWithPromptParts()

      input.getLayoutNode().markDirty()
      renderer.requestRender()
    } finally {
      setStore("suspend", false)
    }
    return true
  }

  function expandAllPastes() {
    clearPasteFocus()

    const marks = input.extmarks
      .getAll()
      .filter((m) => m.typeId === promptPartTypeId && m.virtual)
      .sort((a, b) => b.start - a.start)

    let expanded = 0
    for (const mark of marks) {
      if (expandPasteChip(mark.id, { quiet: true })) expanded++
    }

    if (expanded === 0) {
      toast.show({ message: "No pasted text to expand", variant: "info" })
      return
    }

    toast.show({ message: `Expanded ${expanded} pasted item(s)`, variant: "info" })
  }

  async function showPasteEditor(value: string) {
    return new Promise<string | null>((resolve) => {
      let done = false
      const finish = (v: string | null) => {
        if (done) return
        done = true
        resolve(v)
      }

      dialog.replace(
        () => <DialogPasteEditor value={value} onSave={(v) => finish(v)} />,
        () => finish(null),
      )
    })
  }

  async function editPasteAtCursor() {
    const focused = store.pasteFocus ? getPasteByExtmarkId(store.pasteFocus.extmarkId) : undefined
    const hit = focused ?? getPasteAtCursor()
    if (!hit) {
      toast.show({ message: "No pasted text under cursor", variant: "info" })
      return
    }

    const expanded = !hit.extmark.virtual
    const value = expanded ? input.getTextRange(hit.extmark.start, hit.extmark.end) : hit.part.text

    clearPasteFocus()
    const content = await showPasteEditor(value)
    if (content === null) return

    updatePaste(hit, { text: content, expanded })
  }

  async function pasteImage(file: { filename?: string; content: string; mime: string }) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const count = store.prompt.parts.filter((x) => x.type === "file").length
    const virtualText = `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  const highlight = createMemo(() => {
    if (keybind.leader) return theme.border
    if (store.mode === "shell") return theme.primary
    return local.agent.color(displayAgentName())
  })

  const showVariant = createMemo(() => {
    const variants = local.model.variant.list()
    if (variants.length === 0) return false
    const current = local.model.variant.current()
    return !!current
  })

  const [span, setSpan] = createSignal(0)
  const [topWidth, setTopWidth] = createSignal(0)
  const [footWidth, setFootWidth] = createSignal(0)

  const meta = createMemo(() => {
    const name = store.mode === "shell" ? "Shell" : Locale.titlecase(displayAgentName())
    const lock = lockedAgentName() ? " 🔒" : ""
    if (store.mode !== "normal") {
      return {
        name,
        lock,
        model: "",
        provider: "",
        variant: "",
      }
    }

    const variant = showVariant() ? local.model.variant.current() : ""
    return {
      name,
      lock,
      model: effectiveModelParsed().model,
      provider: effectiveModelParsed().provider,
      variant,
    }
  })

  function fitMeta(max: number) {
    const m = meta()
    if (max <= 0) {
      return {
        head: "",
        model: "",
        provider: "",
        variant: "",
      }
    }

    const headRaw = m.name + m.lock
    const headW = cols(renderer.widthMethod, headRaw)
    if (headW >= max) {
      return {
        head: truncateEnd({ method: renderer.widthMethod, text: headRaw, max }),
        model: "",
        provider: "",
        variant: "",
      }
    }

    if (store.mode !== "normal") {
      return {
        head: headRaw,
        model: "",
        provider: "",
        variant: "",
      }
    }

    const space = " "
    const spaceW = cols(renderer.widthMethod, space)
    const avail = max - headW - spaceW
    if (avail <= 0) {
      return {
        head: truncateEnd({ method: renderer.widthMethod, text: headRaw, max }),
        model: "",
        provider: "",
        variant: "",
      }
    }

    // Prefer showing at least a few columns of the model id; drop extras first.
    const minModel = 4
    const provider = m.provider ? space + m.provider : ""
    const variant = m.variant ? " · " + m.variant : ""

    const base = {
      provider,
      variant,
    }

    const dropVariant = {
      provider,
      variant: "",
    }

    const dropProvider = {
      provider: "",
      variant: "",
    }

    const pick = (p: typeof base) => {
      const tail = p.provider + p.variant
      const tailW = cols(renderer.widthMethod, tail)
      const room = Math.max(0, avail - tailW)
      const need = Math.min(minModel, avail)
      if (room < need) return
      return {
        provider: p.provider,
        variant: p.variant,
        model: truncateMiddle({ method: renderer.widthMethod, text: m.model, max: room }),
      }
    }

    const chosen = pick(base) ?? pick(dropVariant) ?? pick(dropProvider)
    if (!chosen) {
      return {
        head: headRaw,
        model: space + truncateMiddle({ method: renderer.widthMethod, text: m.model, max: avail }),
        provider: "",
        variant: "",
      }
    }

    return {
      head: headRaw,
      model: space + chosen.model,
      provider: chosen.provider,
      variant: chosen.variant,
    }
  }

  const topMeta = createMemo(() => fitMeta(topWidth()))
  const footMeta = createMemo(() => fitMeta(footWidth()))

  const stack = createMemo(() => {
    const w = span()
    if (w === 0) return true
    return w < 90
  })

  const pasteHint = createMemo(() => {
    const focus = store.pasteFocus
    if (!focus) return ""

    const hit = getPasteByExtmarkId(focus.extmarkId)
    const token = hit?.part.source?.text?.value

    if (token && isPasteSummaryToken(token)) {
      return "Paste selected • x expand • e edit • ←/→ jump • backspace/delete remove"
    }

    return "Paste selected • e edit • ←/→ jump • backspace/delete remove"
  })

  const spinnerDef = createMemo(() => {
    const color = local.agent.color(displayAgentName())
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })

  return (
    <>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => {
          autocomplete = r
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
      <box
        ref={(r) => {
          anchor = r
        }}
        renderBefore={function () {
          const el = this as BoxRenderable
          const w = el.width
          setSpan((p) => (p === w ? p : w))
        }}
        visible={props.visible !== false}
      >
        <box
          border={["left"]}
          borderColor={highlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: "┃",
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={theme.backgroundElement}
            flexGrow={1}
          >
            <textarea
              placeholder={props.sessionID ? undefined : `Ask anything... "${PLACEHOLDERS[store.placeholder]}"`}
              textColor={keybind.leader ? theme.textMuted : theme.text}
              focusedTextColor={keybind.leader ? theme.textMuted : theme.text}
              overflow="hidden"
              width="100%"
              minHeight={1}
              maxHeight={6}
              onContentChange={() => {
                if (store.suspend) return
                const value = input.plainText
                setStore("prompt", "input", value)
                autocomplete.onInput(value)
                syncExtmarksWithPromptParts()
                if (!store.pasteFocus) clearPasteFocusOverlays()
              }}
              onCursorChange={() => {
                const focus = store.pasteFocus
                const offset = input.visualCursor.offset

                if (focus) {
                  const extmark = input.extmarks.get(focus.extmarkId)
                  if (!extmark || !extmark.virtual) {
                    clearPasteFocus()
                  }

                  if (extmark && extmark.virtual) {
                    let left = extmark.start
                    if (extmark.start > 0 && input.getTextRange(extmark.start - 1, extmark.start) === " ") {
                      left = extmark.start - 1
                    }
                    let right = extmark.end
                    if (input.getTextRange(extmark.end, extmark.end + 1) === " ") right = extmark.end + 1

                    const ok =
                      focus.side === "left"
                        ? offset === extmark.start || offset === left
                        : offset === extmark.end || offset === right

                    if (!ok) clearPasteFocus()
                  }
                }

                const hit = getPasteAtOffset(offset)
                if (hit?.extmark.virtual && offset > hit.extmark.start && offset < hit.extmark.end) {
                  let next = hit.extmark.end
                  if (input.getTextRange(hit.extmark.end, hit.extmark.end + 1) === " ") next = hit.extmark.end + 1
                  input.cursorOffset = next
                  setStore("pasteFocus", { extmarkId: hit.extmark.id, side: "right" })
                }
              }}
              keyBindings={textareaKeybindings()}
              onKeyDown={async (e) => {
                if (props.disabled) {
                  e.preventDefault()
                  return
                }

                if (store.pasteFocus && e.name === "escape") {
                  clearPasteFocus()
                  e.preventDefault()
                  return
                }

                if (
                  store.pasteFocus &&
                  (e.name === "backspace" || e.name === "delete") &&
                  !e.ctrl &&
                  !e.meta &&
                  !e.shift &&
                  !e.super &&
                  !e.hyper &&
                  !e.option
                ) {
                  deletePasteChip(store.pasteFocus.extmarkId)
                  clearPasteFocus()
                  e.preventDefault()
                  return
                }

                const plain = !e.ctrl && !e.meta && !e.shift && !e.super && !e.hyper && !e.option

                if (
                  !store.pasteFocus &&
                  plain &&
                  (e.name === "backspace" || e.name === "delete") &&
                  !input.hasSelection()
                ) {
                  const offset = input.visualCursor.offset
                  const target = e.name === "delete" ? offset : offset - 1
                  if (target >= 0) {
                    for (const mark of input.extmarks.getAtOffset(target)) {
                      if (mark.typeId !== promptPartTypeId) continue
                      if (!mark.virtual) continue

                      const partIndex = store.extmarkToPartIndex.get(mark.id)
                      const part = partIndex === undefined ? undefined : store.prompt.parts[partIndex]
                      const token = part?.type === "text" && part.source?.text ? part.source.text.value : undefined

                      if (token && isPasteSummaryToken(token)) {
                        setStore("pasteFocus", { extmarkId: mark.id, side: e.name === "delete" ? "left" : "right" })
                        e.preventDefault()
                        return
                      }

                      const startPos = input.editBuffer.offsetToPosition(mark.start)
                      const endPos = input.editBuffer.offsetToPosition(mark.end)
                      if (!startPos || !endPos) {
                        e.preventDefault()
                        return
                      }

                      input.deleteRange(startPos.row, startPos.col, endPos.row, endPos.col)
                      e.preventDefault()
                      return
                    }
                  }
                }

                if (store.pasteFocus && plain && e.name === "x") {
                  const id = store.pasteFocus.extmarkId
                  const ok = expandPasteChip(id)
                  if (ok) clearPasteFocus()
                  if (!ok) {
                    toast.show({ message: "Can't expand this chip", variant: "info" })
                  }
                  e.preventDefault()
                  return
                }

                if (store.pasteFocus && plain && e.name === "e") {
                  e.preventDefault()
                  await editPasteAtCursor()
                  return
                }

                if (store.pasteFocus && !(plain && (e.name === "left" || e.name === "right"))) {
                  clearPasteFocus()
                }

                if (plain && !autocomplete.visible && (e.name === "left" || e.name === "right")) {
                  const focus = store.pasteFocus
                  if (focus) {
                    const extmark = input.extmarks.get(focus.extmarkId)
                    if (extmark && extmark.virtual) {
                      if (e.name === "right" && focus.side === "left") {
                        let next = extmark.end
                        if (input.getTextRange(extmark.end, extmark.end + 1) === " ") next = extmark.end + 1
                        input.cursorOffset = next
                        clearPasteFocus()
                        e.preventDefault()
                        return
                      }

                      if (e.name === "left" && focus.side === "right") {
                        const space = extmark.start > 0 && input.getTextRange(extmark.start - 1, extmark.start) === " "
                        input.cursorOffset = space ? extmark.start - 1 : extmark.start
                        clearPasteFocus()
                        e.preventDefault()
                        return
                      }
                    }

                    clearPasteFocus()
                  }

                  const offset = input.visualCursor.offset
                  if (e.name === "right") {
                    const hit = getPasteAtOffset(offset + 1)
                    if (hit?.extmark.virtual) {
                      setStore("pasteFocus", { extmarkId: hit.extmark.id, side: "left" })
                      e.preventDefault()
                      return
                    }
                  }

                  if (e.name === "left") {
                    let hit = offset > 0 ? getPasteAtOffset(offset - 1) : undefined
                    if (!hit && offset > 1 && input.getTextRange(offset - 1, offset) === " ") {
                      hit = getPasteAtOffset(offset - 2)
                    }
                    if (hit?.extmark.virtual) {
                      setStore("pasteFocus", { extmarkId: hit.extmark.id, side: "right" })
                      e.preventDefault()
                      return
                    }
                  }
                }

                // Handle clipboard paste (Ctrl+V) - check for images first on Windows
                // This is needed because Windows terminal doesn't properly send image data
                // through bracketed paste, so we need to intercept the keypress and
                // directly read from clipboard before the terminal handles it
                if (keybind.match("input_paste", e)) {
                  const content = await Clipboard.read()
                  if (content?.mime.startsWith("image/")) {
                    e.preventDefault()
                    await pasteImage({
                      filename: "clipboard",
                      mime: content.mime,
                      content: content.data,
                    })
                    return
                  }
                  // If no image, let the default paste behavior continue
                }
                if (keybind.match("input_clear", e) && store.prompt.input !== "") {
                  input.clear()
                  input.extmarks.clear()
                  setStore("prompt", {
                    input: "",
                    parts: [],
                  })
                  setStore("extmarkToPartIndex", new Map())
                  setStore("partByExtmarkId", new Map())
                  setStore("recentRemovedExtmarkIds", [])

                  // If Ctrl+C is also an app-exit binding, treat clearing as the
                  // first press so a second Ctrl+C exits.
                  if (keybind.match("app_exit", e) && e.ctrl && e.name === "c" && !e.repeated) {
                    arm(Date.now())
                  }
                  return
                }

                if (keybind.match("app_exit", e) && e.ctrl && e.name === "c" && store.prompt.input === "") {
                  e.preventDefault()
                  if (e.repeated) return

                  const now = Date.now()
                  const result = twice({ now, last: armed(), window: exitWindow })

                  if (result.hit) {
                    await exit()
                    return
                  }

                  arm(result.next)
                  toast.show({
                    message: "Press Ctrl+C again to exit",
                    variant: "info",
                    duration: 1500,
                  })
                  return
                }
                if (keybind.match("app_exit", e)) {
                  if (store.prompt.input === "") {
                    await exit()
                    // Don't preventDefault - let textarea potentially handle the event
                    e.preventDefault()
                    return
                  }
                }
                if (e.name === "!" && input.visualCursor.offset === 0) {
                  setStore("mode", "shell")
                  e.preventDefault()
                  return
                }
                if (store.mode === "shell") {
                  if ((e.name === "backspace" && input.visualCursor.offset === 0) || e.name === "escape") {
                    setStore("mode", "normal")
                    e.preventDefault()
                    return
                  }
                }
                if (store.mode === "normal") autocomplete.onKeyDown(e)
                if (!autocomplete.visible) {
                  if (
                    (keybind.match("history_previous", e) && input.cursorOffset === 0) ||
                    (keybind.match("history_next", e) && input.cursorOffset === getBufferEndOffset())
                  ) {
                    const direction = keybind.match("history_previous", e) ? -1 : 1
                    const item = history.move(direction, input.plainText)

                    if (item) {
                      input.setText(item.input)
                      setStore("prompt", item)
                      setStore("mode", item.mode ?? "normal")
                      restoreExtmarksFromParts(item.parts)
                      e.preventDefault()
                      if (direction === -1) input.cursorOffset = 0
                      if (direction === 1) input.gotoBufferEnd()
                    }
                    return
                  }

                  if (keybind.match("history_previous", e) && input.visualCursor.visualRow === 0) input.cursorOffset = 0
                  if (keybind.match("history_next", e) && input.visualCursor.visualRow === input.height - 1)
                    input.gotoBufferEnd()
                }
              }}
              onSubmit={submit}
              onPaste={async (event: PasteEvent) => {
                if (props.disabled) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = event.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                const candidate = normalizedText.trim()
                if (!candidate) {
                  command.trigger("prompt.paste")
                  return
                }

                // trim ' from the beginning and end of the pasted content. just
                // ' and nothing else
                const filepath = candidate.replace(/^'+|'+$/g, "").replace(/\\ /g, " ")
                const isUrl = /^(https?):\/\//.test(filepath)
                if (!isUrl) {
                  try {
                    const file = Bun.file(filepath)
                    // Handle SVG as raw text content, not as base64 image
                    if (file.type === "image/svg+xml") {
                      event.preventDefault()
                      const content = await file.text().catch(() => {})
                      if (content) {
                        pasteText(content, `[SVG: ${file.name ?? "image"}]`)
                        return
                      }
                    }
                    if (file.type.startsWith("image/")) {
                      event.preventDefault()
                      const content = await file
                        .arrayBuffer()
                        .then((buffer) => Buffer.from(buffer).toString("base64"))
                        .catch(() => {})
                      if (content) {
                        await pasteImage({
                          filename: file.name,
                          mime: file.type,
                          content,
                        })
                        return
                      }
                    }
                  } catch {}
                }

                const countText = normalizedText.trimEnd()
                const lineCount = (countText.match(/\n/g)?.length ?? 0) + 1
                const long = maxLineCols(renderer.widthMethod, countText) > 150
                if (
                  (lineCount >= 3 || long) &&
                  kv.get("paste_collapse_default", true) &&
                  !sync.data.config.experimental?.disable_paste_summary
                ) {
                  event.preventDefault()
                  pasteText(normalizedText, pasteSummary(countText))
                  return
                }

                // Force layout update and render for the pasted content
                setTimeout(() => {
                  input.getLayoutNode().markDirty()
                  renderer.requestRender()
                }, 0)
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                if (pasteFocusTypeId === 0) {
                  pasteFocusTypeId = input.extmarks.registerType("prompt-paste-focus")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  input.cursorColor = theme.text
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => r.target?.focus()}
              focusedBackgroundColor={theme.backgroundElement}
              cursorColor={theme.text}
              syntaxStyle={syntax()}
            />
            <Show when={store.pasteFocus}>
              <box flexShrink={0} paddingTop={1}>
                <text fg={theme.textMuted}>{pasteHint()}</text>
              </box>
            </Show>
            <Show when={tall() || stack()}>
              <box
                flexShrink={0}
                paddingTop={tall() ? 1 : 0}
                renderBefore={function () {
                  const el = this as BoxRenderable
                  const w = el.width
                  setTopWidth((p) => (p === w ? p : w))
                }}
              >
                <text width="100%" overflow="hidden">
                  <span style={{ fg: highlight() }}>{topMeta().head}</span>
                  <span style={{ fg: keybind.leader ? theme.textMuted : theme.text }}>{topMeta().model}</span>
                  <span style={{ fg: theme.textMuted }}>{topMeta().provider}</span>
                  <span style={{ fg: theme.warning, bold: true }}>{topMeta().variant}</span>
                </text>
              </box>
            </Show>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={highlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: theme.backgroundElement.a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={theme.backgroundElement}
            customBorderChars={
              theme.backgroundElement.a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <box flexDirection="row">
          <box
            flexGrow={1}
            flexShrink={1}
            renderBefore={function () {
              const el = this as BoxRenderable
              const w = el.width
              setFootWidth((p) => (p === w ? p : w))
            }}
          >
            <Switch>
              <Match when={(status() as any).type === "waiting"}>
                <box flexDirection="row" gap={1} flexGrow={1} justifyContent="space-between">
                  <box flexGrow={1} flexShrink={1} flexDirection="row" gap={1}>
                    <box marginLeft={1}>
                      <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
                        <spinner color={theme.accent} frames={["◜", "◠", "◝", "◞", "◡", "◟"]} interval={80} />
                      </Show>
                    </box>
                    <text fg={theme.accent} width="100%" overflow="hidden">
                      {waitText()}
                    </text>
                  </box>
                  <text fg={store.interrupt > 0 ? theme.primary : theme.text}>
                    esc{" "}
                    <span style={{ fg: store.interrupt > 0 ? theme.primary : theme.textMuted }}>
                      {store.interrupt > 0 ? "again to interrupt" : "interrupt"}
                    </span>
                  </text>
                </box>
              </Match>
              <Match when={status().type !== "idle"}>
                <box
                  flexDirection="row"
                  gap={1}
                  flexGrow={1}
                  justifyContent={status().type === "retry" ? "space-between" : "flex-start"}
                >
                  <box flexShrink={0} flexDirection="row" gap={1}>
                    <box marginLeft={1}>
                      <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
                        <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                      </Show>
                    </box>
                    <box flexDirection="row" gap={1} flexShrink={0}>
                      {(() => {
                        const retry = createMemo(() => {
                          const s = status()
                          if (s.type !== "retry") return
                          return s
                        })
                        const message = createMemo(() => {
                          const r = retry()
                          if (!r) return
                          if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
                            return "gemini is way too hot right now"

                          return truncateEnd({
                            method: renderer.widthMethod,
                            text: r.message,
                            max: 80,
                            tail: "...",
                          })
                        })
                        const isTruncated = createMemo(() => {
                          const r = retry()
                          if (!r) return false
                          return cols(renderer.widthMethod, r.message) > 120
                        })
                        const [seconds, setSeconds] = createSignal(0)
                        onMount(() => {
                          const timer = setInterval(() => {
                            const next = retry()?.next
                            if (next) setSeconds(Math.round((next - Date.now()) / 1000))
                          }, 1000)

                          onCleanup(() => {
                            clearInterval(timer)
                          })
                        })
                        const handleMessageClick = () => {
                          const r = retry()
                          if (!r) return
                          if (isTruncated()) {
                            DialogAlert.show(dialog, "Retry Error", r.message)
                          }
                        }

                        const retryText = () => {
                          const r = retry()
                          if (!r) return ""
                          const baseMessage = message()
                          const truncatedHint = isTruncated() ? " (click to expand)" : ""
                          const retryInfo = ` [retrying ${seconds() > 0 ? `in ${seconds()}s ` : ""}attempt #${r.attempt}]`
                          return baseMessage + truncatedHint + retryInfo
                        }

                        return (
                          <Show when={retry()}>
                            {/* biome-ignore lint/a11y/noStaticElementInteractions: TUI click handler */}
                            <box onMouseUp={handleMessageClick}>
                              <text fg={theme.error}>{retryText()}</text>
                            </box>
                          </Show>
                        )
                      })()}
                    </box>
                  </box>
                  <text fg={store.interrupt > 0 ? theme.primary : theme.text}>
                    esc{" "}
                    <span style={{ fg: store.interrupt > 0 ? theme.primary : theme.textMuted }}>
                      {store.interrupt > 0 ? "again to interrupt" : "interrupt"}
                    </span>
                  </text>
                </box>
              </Match>
              <Match when={!tall() && !stack()}>
                <text width="100%" overflow="hidden">
                  <span style={{ fg: highlight() }}>{footMeta().head}</span>
                  <span style={{ fg: keybind.leader ? theme.textMuted : theme.text }}>{footMeta().model}</span>
                  <span style={{ fg: theme.textMuted }}>{footMeta().provider}</span>
                  <span style={{ fg: theme.warning, bold: true }}>{footMeta().variant}</span>
                </text>
              </Match>
            </Switch>
          </box>
          <Show when={status().type !== "retry"}>
            <box gap={2} flexDirection="row" flexShrink={0}>
              <Switch>
                <Match when={store.mode === "normal"}>
                  <Show when={!stack() && showVariant()}>
                    <text fg={theme.text}>
                      {keybind.print("variant_cycle")} <span style={{ fg: theme.textMuted }}>variants</span>
                    </text>
                  </Show>
                  <Show when={!stack() && wide() && !lockedAgentName()}>
                    <text fg={theme.text}>
                      {keybind.print("agent_cycle")} <span style={{ fg: theme.textMuted }}>agents</span>
                    </text>
                  </Show>
                  <Show when={!stack() && !wide()}>
                    <text fg={theme.text}>
                      {keybind.print("sidebar_toggle")} <span style={{ fg: theme.textMuted }}>sidebar</span>
                    </text>
                  </Show>
                  <text fg={theme.text}>
                    {keybind.print("command_list")} <span style={{ fg: theme.textMuted }}>commands</span>
                  </text>
                </Match>
                <Match when={store.mode === "shell"}>
                  <text fg={theme.text}>
                    esc <span style={{ fg: theme.textMuted }}>exit shell mode</span>
                  </text>
                </Match>
              </Switch>
            </box>
          </Show>
        </box>
      </box>
    </>
  )
}
