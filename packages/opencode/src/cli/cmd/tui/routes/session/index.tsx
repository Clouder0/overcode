import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  useContext,
  type JSX,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import path from "path"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { SplitBorder } from "@tui/component/border"
import { useTheme } from "@tui/context/theme"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  addDefaultParsers,
  MacOSScrollAccel,
  type ScrollAcceleration,
  TextAttributes,
  RGBA,
} from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import type {
  AssistantMessage as AssistantMessageType,
  MessagePart as MessagePartType,
  Part,
  ToolPart as ToolPartType,
  UserMessage as UserMessageType,
  TextPart as TextPartType,
  ReasoningPart as ReasoningPartType,
} from "@opencode-ai/sdk/v2"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util/locale"
import { Log } from "@/util/log"
import { buildSessionTree } from "../../lib/session-tree"
import type { Tool } from "@/tool/tool"
import type { ReadTool } from "@/tool/read"
import type { WriteTool } from "@/tool/write"
import { BashTool } from "@/tool/bash"
import type { GlobTool } from "@/tool/glob"
import { TodoWriteTool } from "@/tool/todo"
import { QuestionTool } from "@/tool/question"
import type { GrepTool } from "@/tool/grep"
import type { ListTool } from "@/tool/ls"
import type { EditTool } from "@/tool/edit"
import type { ApplyPatchTool } from "@/tool/apply_patch"
import type { WebFetchTool } from "@/tool/webfetch"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { truncateEnd } from "@tui/lib/cols"
import { useSDK } from "@tui/context/sdk"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "@tui/context/keybind"
import { Header } from "./header"
import { parsePatch } from "diff"
import { useDialog } from "../../ui/dialog"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import { DialogSubagent } from "./dialog-subagent"
import { DialogChildSessionList } from "../../component/dialog-child-session-list"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogContext } from "./dialog-context"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { Flag } from "@/flag/flag"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import parsers from "../../../../../../parsers-config.ts"
import { Clipboard } from "../../util/clipboard"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import { Editor } from "../../util/editor"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { useExit } from "../../context/exit"
import { Filesystem } from "@/util/filesystem"
import { Global } from "@/global"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { formatTranscript } from "../../util/transcript"
import { SkillProjection } from "@/util/skill-projection"
import { resolveSkillStatus } from "./skill-status"
import { projectSkillProjection } from "./skill-projection"

addDefaultParsers(parsers.parsers)

class CustomSpeedScroll implements ScrollAcceleration {
  constructor(private speed: number) {}

  tick(_now?: number): number {
    return this.speed
  }

  reset(): void {}
}

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  diffWrapMode: () => "word" | "none"
  skillProjection: () => SkillProjection.Result
  sync: ReturnType<typeof useSync>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

export function Session() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const thread = createMemo(() =>
    buildSessionTree({
      currentSessionID: route.sessionID,
      sessions: sync.data.session,
      sort: "created",
    }),
  )

  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const skillProjection = createMemo(() =>
    projectSkillProjection({
      messages: messages().map((msg) => ({
        id: msg.id,
        role: msg.role,
        error: "error" in msg ? msg.error : undefined,
      })),
      partsByMessageID: sync.data.part,
    }),
  )
  const permissions = createMemo(() => sync.data.permission[route.sessionID] ?? [])
  const questions = createMemo(() => sync.data.question[route.sessionID] ?? [])

  // When processing queued user messages FIFO, the assistant message can be created after
  // later user messages. Use the *parent user id* to mark queued prompts reliably.
  const pending = createMemo(() => {
    const active = messages().findLast((x) => x.role === "assistant" && !x.time.completed) as
      | AssistantMessageType
      | undefined
    return active?.parentID
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "hide")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const [showThinking, setShowThinking] = kv.signal("thinking_visibility", true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [animationsEnabled, setAnimationsEnabled] = kv.signal("animations_enabled", true)

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 42 : 0) - 4)

  const scrollAcceleration = createMemo(() => {
    const tui = sync.data.config.tui
    if (tui?.scroll_acceleration?.enabled) {
      return new MacOSScrollAccel()
    }
    if (tui?.scroll_speed) {
      return new CustomSpeedScroll(tui.scroll_speed)
    }

    return new CustomSpeedScroll(3)
  })

  const toast = useToast()
  const sdk = useSDK()
  const [compacting, setCompacting] = createSignal(false)
  const [tick, setTick] = createSignal(Date.now())
  const clock = setInterval(() => setTick(Date.now()), 30_000)
  onCleanup(() => clearInterval(clock))
  const [ready, setReady] = createSignal(false)

  const isCompacting = (value?: number) => {
    if (typeof value !== "number") return false
    return tick() - value < 10 * 60 * 1000
  }

  createEffect(async () => {
    setReady(false)
    await sync.session
      .sync(route.sessionID)
      .then(() => {
        setReady(true)
        if (scroll) scroll.scrollBy(100_000)
      })
      .catch((e) => {
        const name = e instanceof Error ? e.name : undefined
        if (name === "AbortError") return
        if (name === "TimeoutError") {
          toast.show({
            message: `Timed out loading session: ${route.sessionID}`,
            variant: "error",
          })
          return
        }
        Log.Default.error("tui session sync failed", {
          error: e instanceof Error ? e.message : String(e),
          name: e instanceof Error ? e.name : undefined,
          stack: e instanceof Error ? e.stack : undefined,
          sessionID: route.sessionID,
        })
        toast.show({
          message: `Session not found: ${route.sessionID}`,
          variant: "error",
        })
        return navigate({ type: "home" })
      })
  })

  // Keep previous CPD timestamp without creating a reactive feedback loop.
  const contextState = {
    current: undefined as
      | {
          sessionID: string
          cpdUpdated: number | null
        }
      | undefined,
  }

  createEffect(() => {
    const value = session()
    if (!value) return

    const ctx = value.context
    const next = {
      sessionID: value.id,
      cpdUpdated: ctx?.cpd?.updated ?? null,
    }

    const prev = contextState.current
    if (!prev || prev.sessionID !== next.sessionID) {
      contextState.current = next
      return
    }

    if (next.cpdUpdated !== null && next.cpdUpdated !== prev.cpdUpdated) {
      toast.show({
        variant: "info",
        message: "Context updated (CPD refreshed)",
        duration: 2000,
      })
    }

    contextState.current = next
  })

  // Get task prompt for current session
  const currentTaskPrompt = createMemo((): string | undefined => {
    const sessionID = route.sessionID
    const s = sync.data.session.find((x) => x.id === sessionID)
    if (!s) return undefined
    const prompt = (s as any).subagentPrompt
    if (typeof prompt !== "string" || !prompt) return undefined
    return prompt
  })

  const [initialPromptApplied, setInitialPromptApplied] = createSignal(false)
  const [promptHandle, setPromptHandle] = createSignal<PromptRef | undefined>(undefined)

  createEffect(() => {
    // Apply `initialPrompt` once per session navigation.
    route.sessionID
    route.initialPrompt
    setInitialPromptApplied(false)
  })

  createEffect(() => {
    const initial = route.initialPrompt
    if (!initial) return
    const handle = promptHandle()
    if (!handle) return
    if (initialPromptApplied()) return
    handle.set(initial)
    setInitialPromptApplied(true)
  })

  let lastSwitch: string | undefined = undefined

  const markerKind = (part: { metadata?: unknown }) => {
    const meta = part.metadata
    if (!meta || typeof meta !== "object") return
    const base = meta as Record<string, unknown>
    const opencode = base.opencode
    if (!opencode || typeof opencode !== "object") return
    const marker = (opencode as Record<string, unknown>).marker
    if (!marker || typeof marker !== "object") return
    const record = marker as Record<string, unknown>
    const kind = record.kind
    if (typeof kind !== "string") return
    return kind
  }

  sdk.event.on("message.part.updated", (evt) => {
    const part = evt.properties.part

    if (part.type === "text" && part.synthetic === true && part.ignored === true) {
      if (part.sessionID !== route.sessionID) return
      if (!ready()) return
      const kind = markerKind(part)
      if (!kind) return

      const variant = kind === "rctx" ? "error" : kind === "think" ? "warning" : kind === "trim" ? "warning" : "info"
      const duration = kind === "rctx" ? 4000 : 3000

      toast.show({
        variant,
        message: part.text,
        duration,
      })
      return
    }

    if (part.type !== "tool") return
    if (part.sessionID !== route.sessionID) return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set("build")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      lastSwitch = part.id
    }
  })

  let scroll: ScrollBoxRenderable
  let prompt: PromptRef
  const keybind = useKeybind()

  const exit = useExit()
  useKeyboard((evt) => {
    if (!keybind.match("app_exit", evt)) return

    // Ctrl+C/Ctrl+D overlap with prompt editing keys; let the prompt handle
    // them (clear/delete) and only allow exiting via non-editing bindings.
    if (evt.ctrl && (evt.name === "c" || evt.name === "d")) return

    exit()
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => {
          if (!part) return false
          if (part.type === "text" && !part.synthetic && !part.ignored) return true
          if ((part as any).type === "message") return true
          return false
        })
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (scroll) scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  const local = useLocal()

  function moveChild(direction: number) {
    const t = thread()
    if (t.list.length <= 1) return

    const index = t.list.findIndex((x) => x.id === route.sessionID)
    const current = index >= 0 ? index : 0

    const next = (current + direction + t.list.length) % t.list.length
    const target = t.list[next]?.id
    if (!target) return

    navigate({
      type: "session",
      sessionID: target,
    })
  }

  const command = useCommandDialog()
  command.register(() => [
    {
      title: "Share session",
      value: "session.share",
      suggested: route.type === "session",
      keybind: "session_share",
      category: "Session",
      enabled: sync.data.config.share !== "disabled" && !session()?.share?.url,
      slash: {
        name: "share",
      },
      onSelect: async (dialog) => {
        await sdk.client.session
          .share({
            sessionID: route.sessionID,
          })
          .then((res) =>
            Clipboard.copy(res.data!.share!.url).catch(() =>
              toast.show({ message: "Failed to copy URL to clipboard", variant: "error" }),
            ),
          )
          .then(() => toast.show({ message: "Share URL copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to share session", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Rename session",
      value: "session.rename",
      keybind: "session_rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      keybind: "session_timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: "Fork from message",
      value: "session.fork",
      keybind: "session_fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: "Compact session",
      value: "session.compact",
      keybind: "session_compact",
      category: "Session",
      enabled:
        !compacting() &&
        (() => {
          const status = sync.data.session_status?.[route.sessionID]
          if (status?.type && status.type !== "idle") return false
          if (status?.type === "idle") return true
          return !isCompacting(session()?.time?.compacting)
        })(),
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      onSelect: async (dialog) => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }

        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type && status.type !== "idle") {
          toast.show({
            variant: "warning",
            message: "Session is busy; interrupt or wait before compacting",
            duration: 2500,
          })
          return
        }

        if (!status?.type && isCompacting(session()?.time?.compacting)) {
          toast.show({
            variant: "warning",
            message: "Session is already compacting",
            duration: 2500,
          })
          return
        }

        if (compacting()) return

        setCompacting(true)
        toast.show({
          variant: "info",
          message: "Compacting session...",
          duration: 1500,
        })

        await sdk.client.session
          .summarize({
            sessionID: route.sessionID,
            modelID: selectedModel.modelID,
            providerID: selectedModel.providerID,
          })
          .catch((e) => {
            const name = e instanceof Error ? e.name : undefined
            if (name === "AbortError") return
            toast.show({
              variant: "error",
              message: "Failed to compact session",
              duration: 3500,
            })
          })
          .finally(() => setCompacting(false))

        dialog.clear()
      },
    },
    {
      title: "Show context",
      value: "session.context",
      category: "Session",
      slash: {
        name: "context",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogContext sessionID={route.sessionID} />)
      },
    },
    {
      title: "Unshare session",
      value: "session.unshare",
      keybind: "session_unshare",
      category: "Session",
      enabled: !!session()?.share?.url,
      slash: {
        name: "unshare",
      },
      onSelect: async (dialog) => {
        await sdk.client.session
          .unshare({
            sessionID: route.sessionID,
          })
          .then(() => toast.show({ message: "Session unshared successfully", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to unshare session", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      keybind: "messages_undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      onSelect: async (dialog) => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const revert = session()?.revert?.messageID
        const message = messages().findLast((x) => (!revert || x.id < revert) && x.role === "user")
        if (!message) return
        sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
          })
        const parts = sync.data.part[message.id]
        prompt.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dialog.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      keybind: "messages_redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      onSelect: (dialog) => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt.set({ input: "", parts: [] })
          return
        }
        sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      value: "session.sidebar.toggle",
      keybind: "sidebar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal" as any,
      category: "Session",
      onSelect: (dialog) => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      onSelect: (dialog) => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: showThinking() ? "Hide thinking" : "Show thinking",
      value: "session.toggle.thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      onSelect: (dialog) => {
        setShowThinking((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: "Session",
      onSelect: (dialog) => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      keybind: "messages_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      keybind: "messages_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      keybind: "messages_line_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      keybind: "messages_line_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      keybind: "messages_half_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      keybind: "messages_first",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      keybind: "messages_last",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      keybind: "messages_last_user",
      category: "Session",
      hidden: true,
      onSelect: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      keybind: "messages_next",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      keybind: "messages_previous",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      keybind: "messages_copy",
      category: "Session",
      onSelect: (dialog) => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        Clipboard.copy(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
            },
          )
          await Clipboard.copy(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch (error) {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      keybind: "session_export",
      category: "Session",
      slash: {
        name: "export",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await Editor.open({ value: transcript, renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Bun.write(filepath, transcript)

            // Open with EDITOR if available
            const result = await Editor.open({ value: transcript, renderer })
            if (result !== undefined) {
              await Bun.write(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch (error) {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Switch subagent session",
      value: "session.child.list",
      keybind: "session_child_list",
      category: "Session",
      onSelect: (dialog) => {
        const t = buildSessionTree({
          currentSessionID: route.sessionID,
          sessions: sync.data.session,
          sort: "created",
        })

        if (t.list.length <= 1) {
          toast.show({ variant: "warning", message: "No subagent sessions found", duration: 2000 })
          dialog.clear()
          return
        }

        dialog.replace(() => <DialogChildSessionList sessionID={route.sessionID} />)
      },
    },
    {
      title: "Next child session",
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        moveChild(1)
        dialog.clear()
      },
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        moveChild(-1)
        dialog.clear()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      keybind: "session_parent",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      },
    },
  ])

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)

  const revertDiffFiles = createMemo(() => {
    const diffText = revertInfo()?.diff ?? ""
    if (!diffText) return []

    try {
      const patches = parsePatch(diffText)
      return patches.map((patch) => {
        const filename = patch.newFileName || patch.oldFileName || "unknown"
        const cleanFilename = filename.replace(/^[ab]\//, "")
        return {
          filename: cleanFilename,
          additions: patch.hunks.reduce(
            (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("+")).length,
            0,
          ),
          deletions: patch.hunks.reduce(
            (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("-")).length,
            0,
          ),
        }
      })
    } catch (error) {
      return []
    }
  })

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    return messages().filter((x) => x.id >= messageID && x.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  const dialog = useDialog()
  const renderer = useRenderer()

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  // Ensure history is loaded when navigating between sessions.
  createEffect(
    on(
      () => route.sessionID,
      (id) => {
        sync.session.sync(id).catch(() => {})
      },
    ),
  )

  return (
    <context.Provider
      value={{
        get width() {
          return contentWidth()
        },
        sessionID: route.sessionID,
        conceal,
        showThinking,
        showTimestamps,
        showDetails,
        diffWrapMode,
        skillProjection,
        sync,
      }}
    >
      <box flexDirection="row">
        <box flexGrow={1} paddingBottom={1} paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
          <Show when={session()}>
            <Show when={!sidebarVisible() || !wide() || !!session()?.parentID}>
              <Header />
            </Show>
            <Show when={route.sessionID} keyed>
              {(sessionID) => (
                <scrollbox
                  id={"messages-" + sessionID}
                  ref={(r) => {
                    scroll = r
                  }}
                  viewportOptions={{
                    paddingRight: showScrollbar() ? 1 : 0,
                  }}
                  verticalScrollbarOptions={{
                    paddingLeft: 1,
                    visible: showScrollbar(),
                    trackOptions: {
                      backgroundColor: theme.backgroundElement,
                      foregroundColor: theme.border,
                    },
                  }}
                  stickyScroll={true}
                  stickyStart="bottom"
                  flexGrow={1}
                  scrollAcceleration={scrollAcceleration()}
                >
                  {/* Task prompt card - stable placeholder to avoid scrollbox child insertion issues */}
                  <box id="task-prompt">
                    <Show when={currentTaskPrompt()}>
                      {(prompt) => (
                        <box
                          id="task-prompt-card"
                          marginTop={1}
                          paddingLeft={2}
                          border={["left"]}
                          borderColor={theme.secondary}
                          customBorderChars={SplitBorder.customBorderChars}
                        >
                          <text fg={theme.secondary}>
                            <b>Task</b>
                          </text>
                          <text fg={theme.text}>{prompt()}</text>
                        </box>
                      )}
                    </Show>
                  </box>
                  <For each={sync.data.message[sessionID] ?? []}>
                    {(message, index) => (
                      <Switch>
                        <Match when={message.id === revert()?.messageID}>
                          <RevertNotice data={revert() as RevertNoticeData} />
                        </Match>
                        <Match when={revert()?.messageID && message.id >= revert()!.messageID}>
                          <></>
                        </Match>
                        <Match when={message.role === "user"}>
                          <UserMessage
                            index={index()}
                            onMouseUp={() => {
                              if (renderer.getSelection()?.getSelectedText()) return
                              dialog.replace(() => (
                                <DialogMessage
                                  messageID={message.id}
                                  sessionID={sessionID}
                                  setPrompt={(promptInfo) => prompt.set(promptInfo)}
                                />
                              ))
                            }}
                            message={message as UserMessageType}
                            parts={sync.data.part[message.id] ?? []}
                            pending={pending()}
                          />
                        </Match>
                        <Match when={message.role === "assistant"}>
                          <AssistantMessage
                            last={lastAssistant()?.id === message.id}
                            message={message as AssistantMessageType}
                            parts={sync.data.part[message.id] ?? []}
                          />
                        </Match>
                      </Switch>
                    )}
                  </For>
                </scrollbox>
              )}
            </Show>
            <box flexShrink={0}>
              <Show when={permissions().length > 0}>
                <PermissionPrompt request={permissions()[0]} />
              </Show>
              <Show when={questions().length > 0}>
                <QuestionPrompt request={questions()[0]} />
              </Show>
              <Prompt
                visible={permissions().length === 0 && questions().length === 0}
                ref={(r) => {
                  prompt = r
                  promptRef.set(r)
                  setPromptHandle(r)
                }}
                disabled={permissions().length > 0 || questions().length > 0}
                onSubmit={() => {
                  toBottom()
                }}
                sessionID={route.sessionID}
              />
            </box>
          </Show>
          <Toast />
        </box>
        <Show when={sidebarVisible()}>
          <Switch>
            <Match when={wide()}>
              <Sidebar sessionID={route.sessionID} />
            </Match>
            <Match when={!wide()}>
              <box
                position="absolute"
                top={0}
                left={0}
                right={0}
                bottom={0}
                alignItems="flex-end"
                backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
              >
                <Sidebar sessionID={route.sessionID} />
              </box>
            </Match>
          </Switch>
        </Show>
      </box>
    </context.Provider>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

type RevertNoticeData = {
  messageID: string
  reverted: UserMessageType[]
  diff?: string
  diffFiles: {
    filename: string
    additions: number
    deletions: number
  }[]
}

function RevertNotice(props: { data: RevertNoticeData }) {
  const keybind = useKeybind()
  const command = useCommandDialog()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)

  const handleUnrevert = async () => {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Confirm Redo",
      "Are you sure you want to restore the reverted messages?",
    )
    if (confirmed) {
      command.trigger("session.redo")
    }
  }

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: TUI click handler */}
      {/* biome-ignore lint/a11y/useKeyWithMouseEvents: TUI hover handler */}
      <box
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={handleUnrevert}
        marginTop={1}
        flexShrink={0}
        border={["left"]}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.backgroundPanel}
      >
        <box
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
        >
          <text fg={theme.textMuted}>{props.data.reverted.length} message reverted</text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span> or /redo to restore
          </text>
          <Show when={props.data.diffFiles.length > 0}>
            <box marginTop={1}>
              <For each={props.data.diffFiles}>
                {(file) => (
                  <text fg={theme.text}>
                    {file.filename}
                    <Show when={file.additions > 0}>
                      <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                    </Show>
                    <Show when={file.deletions > 0}>
                      <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                    </Show>
                  </text>
                )}
              </For>
            </box>
          </Show>
        </box>
      </box>
    </>
  )
}

function UserMessage(props: {
  message: UserMessageType
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = use()
  const local = useLocal()
  const text = createMemo(() => props.parts.flatMap((x) => (x.type === "text" && !x.synthetic ? [x] : []))[0])
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const messages = createMemo(() => props.parts.flatMap((x) => (x.type === "message" ? [x] : [])))
  const sync = useSync()
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending && props.message.id > props.pending)
  const color = createMemo(() => (queued() ? theme.accent : local.agent.color(props.message.agent)))
  const metadataVisible = createMemo(() => queued() || ctx.showTimestamps())

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  return (
    <>
      <Show when={text()}>
        <box
          id={props.message.id}
          border={["left"]}
          borderColor={color()}
          customBorderChars={SplitBorder.customBorderChars}
          marginTop={props.index === 0 ? 0 : 1}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: TUI click handler */}
          {/* biome-ignore lint/a11y/useKeyWithMouseEvents: TUI hover handler */}
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{text()?.text}</text>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const bg = createMemo(() => {
                      if (file.mime.startsWith("image/")) return theme.accent
                      if (file.mime === "application/pdf") return theme.primary
                      return theme.secondary
                    })
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: bg(), fg: theme.background }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={queued()}
              fallback={
                <Show when={ctx.showTimestamps()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>
                <span style={{ bg: theme.accent, fg: theme.backgroundPanel, bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
      {/* Render protocol messages (incoming from other sessions) */}
      <For each={messages()}>
        {(part) => <MessagePartComponent last={false} part={part} message={props.message as any} />}
      </For>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}

function AssistantMessage(props: { message: AssistantMessageType; parts: Part[]; last: boolean }) {
  const local = useLocal()
  const { theme } = useTheme()
  const sync = useSync()
  const renderer = useRenderer()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })

  const duration = createMemo(() => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
  })

  const replyingTo = createMemo(() => {
    const list = messages()
    const idx = list.findIndex((x) => x.id === props.message.id)
    if (idx <= 0) return

    const prev = list[idx - 1]
    if (prev?.id === props.message.parentID) return

    const user = list.find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user) return `#${props.message.parentID.slice(-4)}`
    const parts = sync.data.part[user.id] ?? []
    const part = parts.find((p) => p.type === "text" && !p.synthetic && !p.ignored) as TextPartType | undefined
    if (!part) return `#${props.message.parentID.slice(-4)}`

    const line = part.text.replace(/\n/g, " ").trim()
    if (!line) return `#${props.message.parentID.slice(-4)}`
    return line
  })

  const reactiveParts = createMemo(() => sync.data.part[props.message.id] ?? props.parts)

  return (
    <>
      <For each={reactiveParts()}>
        {(part, index) => {
          const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
          return (
            <Show when={component()}>
              <Dynamic
                last={index() === reactiveParts().length - 1}
                component={component()}
                part={part as any}
                message={props.message}
              />
            </Show>
          )
        }}
      </For>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          <text fg={theme.textMuted}>{props.message.error?.data.message}</text>
        </box>
      </Show>
      <Switch>
        <Match when={props.last || final() || props.message.error?.name === "MessageAbortedError"}>
          <box paddingLeft={3}>
            <text marginTop={1}>
              <span
                style={{
                  fg:
                    props.message.error?.name === "MessageAbortedError"
                      ? theme.textMuted
                      : local.agent.color(props.message.agent),
                }}
              >
                ▣{" "}
              </span>{" "}
              <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.mode)}</span>
              <span style={{ fg: theme.textMuted }}> · {props.message.modelID}</span>
              <Show when={replyingTo()}>
                <span style={{ fg: theme.textMuted }}>
                  {" "}
                  · ↳ {truncateEnd({ method: renderer.widthMethod, text: replyingTo()!, max: 60, tail: "..." })}
                </span>
              </Show>
              <Show when={duration()}>
                <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
              </Show>
              <Show when={props.message.error?.name === "MessageAbortedError"}>
                <span style={{ fg: theme.textMuted }}> · interrupted</span>
              </Show>
            </text>
          </box>
        </Match>
      </Switch>
    </>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
  message: MessagePartComponent,
}

type MessagePartData = MessagePartType

function MessagePartComponent(props: { last: boolean; part: MessagePartData; message: AssistantMessageType }) {
  const { theme, syntax } = useTheme()
  const ctx = use()
  const sync = useSync()
  const dialog = useDialog()
  const renderer = useRenderer()

  const peerSession = createMemo(() =>
    props.part.peerType === "agent" ? sync.session.get(props.part.peer) : undefined,
  )

  const currentSession = createMemo(() => sync.session.get(props.part.sessionID))
  const isSubagentSession = createMemo(() => !!currentSession()?.parentID)

  const isTimeout = props.part.timeoutOccurred
  const isIncoming = props.part.direction === "incoming"
  const isHuman = props.part.peerType === "human"
  const isSystem = props.part.peerType === "system"
  const isWaitResult = isIncoming && isSystem && props.part.peer === "Wait result"
  const isToHuman = !isIncoming && isHuman

  const [expanded, setExpanded] = createSignal(isSubagentSession() && !isWaitResult)

  const sessionStatus = createMemo(() => sync.data.session_status?.[props.part.sessionID] as any)

  const pendingAssistant = createMemo(() => {
    const messages = sync.data.message[props.part.sessionID] ?? []
    const pending = messages.findLast((x) => x.role === "assistant" && !(x as any).time?.completed) as any
    return pending?.id as string | undefined
  })

  const queued = createMemo(() => {
    if (!isIncoming) return false
    if (props.part.peerType !== "agent") return false

    const pending = pendingAssistant()
    if (pending && props.part.messageID > pending) return true

    const status = sessionStatus()
    if (status?.type === "waiting") {
      const started = status.time?.created as number | undefined
      if (started !== undefined) {
        return props.part.time.created >= started
      }
    }

    return false
  })

  const peerInfo = createMemo(() => {
    if (isHuman) return { name: "human", shortId: "" }
    if (isSystem) return { name: props.part.peer, shortId: "" }

    const shortId = props.part.peer.slice(-4)
    const session = peerSession()
    if (session?.title?.startsWith("Subagent - ")) {
      return { name: session.title.slice(11), shortId }
    }
    if (session?.title) return { name: session.title, shortId }
    return { name: "agent", shortId }
  })

  const arrow = isWaitResult ? "⏱" : isIncoming ? "←" : "→"
  const color = isToHuman ? theme.primary : isWaitResult ? theme.warning : isIncoming ? theme.info : theme.secondary
  const headerPad = isIncoming ? "" : "      "

  const contentInfo = createMemo(() => {
    const text = props.part.text.trim()
    const lines = text.split("\n")
    const totalLines = lines.length
    const maxCollapsedLines = 3

    if (totalLines <= maxCollapsedLines) {
      return { preview: text, full: text, canExpand: false }
    }

    const previewLines = lines.slice(0, maxCollapsedLines)
    const preview = previewLines.join("\n") + " …"
    return { preview, full: text, canExpand: true }
  })

  const displayContent = createMemo(() => {
    if (expanded() || !contentInfo().canExpand) {
      return contentInfo().full
    }
    return contentInfo().preview
  })

  const canNavigateToPeer = createMemo(() => props.part.peerType === "agent")
  const showTimeoutLabel = createMemo(() => isTimeout || isWaitResult)

  const seq = createMemo(() => {
    const meta = props.part.metadata
    if (!meta || typeof meta !== "object") return undefined
    const data = (meta as { opencode?: unknown }).opencode
    if (!data || typeof data !== "object") return undefined
    const value = (data as any).seq
    if (typeof value !== "number") return undefined
    return value
  })

  const handlePeerClick = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    if (!canNavigateToPeer()) return
    dialog.replace(() => <DialogSubagent sessionID={props.part.peer} />)
  }

  const toggleExpand = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    setExpanded(!expanded())
  }

  return (
    <box
      id={"message-" + props.part.id}
      marginTop={1}
      paddingLeft={2}
      border={["left"]}
      borderColor={color}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box flexDirection="row">
        <text>
          {headerPad}
          <span style={{ fg: color }}>{arrow}</span>{" "}
        </text>
        <Show
          when={canNavigateToPeer()}
          fallback={
            <text>
              <span style={{ fg: isTimeout ? theme.error : color, bold: true }}>{peerInfo().name}</span>
              {peerInfo().shortId && <span style={{ fg: theme.textMuted }}>#{peerInfo().shortId}</span>}
            </text>
          }
        >
          <>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: TUI click handler */}
            <text onMouseUp={handlePeerClick}>
              <span style={{ fg: isTimeout ? theme.error : color, bold: true, underline: true }}>
                {peerInfo().name}
              </span>
              {peerInfo().shortId && <span style={{ fg: theme.textMuted }}>#{peerInfo().shortId}</span>}
            </text>
          </>
        </Show>
        <text>
          {seq() !== undefined && <span style={{ fg: theme.textMuted }}> seq: {seq()}</span>}
          {showTimeoutLabel() && <span style={{ fg: theme.error }}> (timed out)</span>}
          {queued() && <span style={{ bg: theme.accent, fg: theme.backgroundPanel, bold: true }}> QUEUED </span>}
        </text>
      </box>
      <Show when={!isToHuman && contentInfo().canExpand}>
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: TUI click handler */}
          <text fg={theme.textMuted} onMouseUp={toggleExpand}>
            {expanded() ? " ▼ collapse" : " ▶ expand"}
          </text>
        </>
      </Show>
      <Show
        when={isToHuman}
        fallback={
          <Show
            when={expanded() || !contentInfo().canExpand}
            fallback={<text fg={theme.text}>{displayContent()}</text>}
          >
            <Show
              when={isWaitResult}
              fallback={
                <code
                  filetype="markdown"
                  drawUnstyledText={false}
                  streaming={false}
                  syntaxStyle={syntax()}
                  content={displayContent()}
                  conceal={ctx.conceal()}
                  fg={theme.text}
                />
              }
            >
              <text fg={theme.text}>{displayContent()}</text>
            </Show>
          </Show>
        }
      >
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={!props.message.time.completed}
          syntaxStyle={syntax()}
          content={props.part.text}
          conceal={ctx.conceal()}
          fg={theme.text}
        />
      </Show>
    </box>
  )
}

function ReasoningPart(props: { last: boolean; part: ReasoningPartType; message: AssistantMessageType }) {
  const { theme, subtleSyntax } = useTheme()
  const ctx = use()
  const content = createMemo(() => {
    // Filter out redacted reasoning chunks from OpenRouter
    // OpenRouter sends encrypted reasoning data that appears as [REDACTED]
    return props.part.text.replace("[REDACTED]", "").trim()
  })

  const label = createMemo(() => {
    if (props.part.ignored !== true) return "_Thinking:_"

    const meta = props.part.metadata
    const opencode = meta && typeof meta === "object" ? (meta as { opencode?: unknown }).opencode : undefined
    const reason = opencode && typeof opencode === "object" ? (opencode as { reason?: unknown }).reason : undefined

    if (reason === "interrupted") return "_Thinking (omitted when you continued):_"
    if (reason === "provider_rejected_reasoning_context") return "_Thinking (not sent to provider):_"
    return "_Thinking (omitted from model context):_"
  })

  return (
    <Show when={content() && ctx.showThinking()}>
      <box
        id={"text-" + props.part.id}
        paddingLeft={2}
        marginTop={1}
        flexDirection="column"
        border={["left"]}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.backgroundElement}
      >
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={true}
          syntaxStyle={subtleSyntax()}
          content={label() + " " + content()}
          conceal={ctx.conceal()}
          fg={theme.textMuted}
        />
      </box>
    </Show>
  )
}

function TextPart(props: { last: boolean; part: TextPartType; message: AssistantMessageType }) {
  const ctx = use()
  const { theme, syntax } = useTheme()

  const marker = createMemo(() => {
    if (props.part.ignored !== true) return

    const meta = props.part.metadata
    if (!meta || typeof meta !== "object") return

    const opencode = (meta as any).opencode
    if (!opencode || typeof opencode !== "object") return

    const marker = (opencode as any).marker
    if (!marker || typeof marker !== "object") return

    const kind = (marker as any).kind
    if (kind === "trim" || kind === "think" || kind === "rctx") return kind as "trim" | "think" | "rctx"
  })

  const badge = createMemo(() => {
    const kind = marker()
    if (!kind) return

    if (kind === "rctx") return { label: "RCTX", bg: theme.error }
    if (kind === "trim") return { label: "TRIM", bg: theme.warning }
    return { label: "THINK", bg: theme.warning }
  })

  const trimmed = createMemo(() => props.part.text.trim())

  return (
    <Show when={trimmed()} keyed>
      {(text) => (
        <Show
          when={badge()}
          keyed
          fallback={
            <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexShrink={0}>
              <Switch>
                <Match when={Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
                  <markdown syntaxStyle={syntax()} content={text} conceal={ctx.conceal()} />
                </Match>
                <Match when={!Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
                  <code
                    filetype="markdown"
                    drawUnstyledText={false}
                    streaming={true}
                    syntaxStyle={syntax()}
                    content={text}
                    conceal={ctx.conceal()}
                    fg={theme.text}
                  />
                </Match>
              </Switch>
            </box>
          }
        >
          {(value) => (
            <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexShrink={0}>
              <text fg={theme.textMuted}>
                <span style={{ bg: value.bg, fg: theme.backgroundPanel, bold: true }}> {value.label} </span>
                <span style={{ fg: theme.textMuted }}> {text}</span>
              </text>
            </box>
          )}
        </Show>
      )}
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPartType; message: AssistantMessageType }) {
  const ctx = use()
  const sync = useSync()

  const partIndex = createMemo(() => {
    const parts = sync.data.part[props.message.id]
    if (!parts) return -1
    return parts.findIndex((p) => p.id === props.part.id)
  })

  const reactivePart = createMemo(() => {
    const idx = partIndex()
    if (idx < 0) return props.part
    const part = sync.data.part[props.message.id]?.[idx]
    if (part && part.type === "tool") return part
    return props.part
  })

  const partState = createMemo(() => {
    const idx = partIndex()
    if (idx < 0) return props.part.state
    const part = sync.data.part[props.message.id]?.[idx]
    if (part && part.type === "tool") return part.state
    return props.part.state
  })

  const hidden = createMemo(() => {
    const part = reactivePart()
    const state = partState()

    if (part.tool === "send_agent_message") {
      const ok = state.status === "completed" && (state.metadata as any)?.ok === true
      if (ok) return true
    }

    if (ctx.showDetails()) return false
    if (part.tool === "wait_agent_message") return false
    if (part.tool === "skill") return false
    if (state.status !== "completed") return false

    const permissions = sync.data.permission[props.message.sessionID] ?? []
    const hasPermission = permissions.some((x) => x.tool?.callID === part.callID)
    if (hasPermission) return false

    return true
  })

  const toolprops = {
    get metadata() {
      const state = partState()
      return state.status === "pending" ? {} : (state.metadata ?? {})
    },
    get input() {
      return partState().input ?? {}
    },
    get output() {
      const state = partState()
      return state.status === "completed" ? state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.message.sessionID] ?? []
      const callID = reactivePart().callID
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === callID)
      return permissions[permissionIndex]
    },
    get tool() {
      return reactivePart().tool
    },
    get part() {
      return reactivePart()
    },
  }

  return (
    <Show when={!hidden()}>
      <Switch>
        <Match when={reactivePart().tool === "bash"}>
          <Bash {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "list"}>
          <List {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "codesearch"}>
          <CodeSearch {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "apply_patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "todowrite"}>
          <TodoWrite {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "subagent_spawn"}>
          <SubagentSpawn {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "wait_agent_message"}>
          <WaitAgentMessage {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={reactivePart().tool === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

type ToolProps<T extends Tool.Info> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  permission: Record<string, any>
  tool: string
  output?: string
  part: ToolPartType
}
function GenericTool(props: ToolProps<any>) {
  return (
    <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part}>
      {props.tool} {input(props.input)}
    </InlineTool>
  )
}

function Skill(props: ToolProps<any>) {
  const { theme } = useTheme()
  const ctx = use()

  const name = createMemo(() => {
    const meta = props.metadata as Record<string, unknown> | undefined
    const metaName = meta?.name
    if (typeof metaName === "string" && metaName.trim().length > 0) return metaName.trim()

    const inputData = props.input as Record<string, unknown> | undefined
    const inputName = inputData?.name
    if (typeof inputName === "string" && inputName.trim().length > 0) return inputName.trim()

    return "unknown"
  })

  const status = createMemo(() => {
    const meta = props.metadata as Record<string, unknown> | undefined
    return resolveSkillStatus({
      status: props.part.state.status,
      applied: meta?.applied,
      reason: meta?.reason,
      superseded: ctx.skillProjection().supersededPartIDs.has(props.part.id),
    })
  })

  const icon = createMemo(() => {
    if (status() === "failed") return "✗"
    if (status() === "loading") return "◐"
    if (status() === "noop") return "○"
    if (status() === "superseded") return "◇"
    return "◆"
  })

  const iconColor = createMemo(() => {
    if (status() === "failed") return theme.error
    if (status() === "noop") return theme.textMuted
    if (status() === "superseded") return theme.textMuted
    if (status() === "loading") return theme.warning
    return theme.secondary
  })

  const complete = createMemo(() => status() !== "loading")

  const title = createMemo(() => {
    if (status() === "failed") return `Skill ${name()} (failed)`
    if (status() === "noop") return `Skill ${name()} (up-to-date)`
    if (status() === "superseded") return `Skill ${name()} (superseded)`
    return `Skill ${name()} (active)`
  })

  return (
    <Show when={status() !== "hidden"}>
      <>
        <InlineTool
          icon={icon()}
          iconColor={iconColor()}
          pending={`Loading skill ${name()}...`}
          complete={complete()}
          part={props.part}
        >
          {title()}
        </InlineTool>
        <Show when={status() === "superseded"}>
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Superseded by newer load in this session
            </text>
          </box>
        </Show>
        <Show when={status() === "noop"}>
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Reused existing active skill load
            </text>
          </box>
        </Show>
      </>
    </Show>
  )
}

function ToolTitle(props: { fallback: string; when: any; icon: string; children: JSX.Element }) {
  const { theme } = useTheme()
  return (
    <text paddingLeft={3} fg={props.when ? theme.textMuted : theme.text}>
      <Show fallback={<>~ {props.fallback}</>} when={props.when}>
        <span style={{ bold: true }}>{props.icon}</span> {props.children}
      </Show>
    </text>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: any
  pending: string
  children: JSX.Element
  part: ToolPartType
}) {
  const [margin, setMargin] = createSignal(0)
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const fg = createMemo(() => {
    if (permission()) return theme.warning
    if (props.complete) return theme.textMuted
    return theme.text
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  return (
    <box
      marginTop={margin()}
      paddingLeft={3}
      renderBefore={function () {
        const el = this as BoxRenderable
        const parent = el.parent
        if (!parent) {
          return
        }
        if (el.height > 1) {
          setMargin(1)
          return
        }
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) {
          setMargin(1)
          return
        }
      }}
    >
      <text paddingLeft={3} fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
        <Show fallback={<>~ {props.pending}</>} when={props.complete}>
          <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
        </Show>
      </text>
      <Show when={error() && !denied()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function BlockTool(props: { title: string; children: JSX.Element; onClick?: () => void; part?: ToolPartType }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: TUI click handler */}
      {/* biome-ignore lint/a11y/useKeyWithMouseEvents: TUI hover handler */}
      <box
        border={["left"]}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        marginTop={1}
        gap={1}
        backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.background}
        onMouseOver={() => props.onClick && setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText()) return
          props.onClick?.()
        }}
      >
        <text paddingLeft={3} fg={theme.textMuted}>
          {props.title}
        </text>
        {props.children}
        <Show when={error()}>
          <text fg={theme.error}>{error()}</text>
        </Show>
      </box>
    </>
  )
}

function Bash(props: ToolProps<typeof BashTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const output = createMemo(() => stripAnsi(props.metadata.output?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const overflow = createMemo(() => lines().length > 10)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, 10), "…"].join("\n")
  })

  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined

    const base = sync.data.path.directory
    if (!base) return undefined

    const absolute = path.resolve(base, workdir)
    if (absolute === base) return undefined

    const home = Global.Path.home
    if (!home) return absolute

    const match = absolute === home || absolute.startsWith(home + path.sep)
    return match ? absolute.replace(home, "~") : absolute
  })

  const title = createMemo(() => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })

  return (
    <Switch>
      <Match when={props.metadata.output !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={1}>
            <text fg={theme.text}>$ {props.input.command}</text>
            <text fg={theme.text}>{limited()}</text>
            <Show when={overflow()}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={props.input.command} part={props.part}>
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Write(props: ToolProps<typeof WriteTool>) {
  const { theme, syntax } = useTheme()
  const code = createMemo(() => {
    if (!props.input.content) return ""
    return props.input.content
  })

  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    return props.metadata.diagnostics?.[filePath] ?? []
  })

  return (
    <Switch>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool title={"# Wrote " + normalizePath(props.input.filePath!)} part={props.part}>
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(props.input.filePath!)}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
          <Show when={diagnostics().length}>
            <For each={diagnostics()}>
              {(diagnostic) => (
                <text fg={theme.error}>
                  Error [{diagnostic.range.start.line}:{diagnostic.range.start.character}]: {diagnostic.message}
                </text>
              )}
            </For>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing write..." complete={props.input.filePath} part={props.part}>
          Write {normalizePath(props.input.filePath!)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<typeof GlobTool>) {
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={props.input.pattern} part={props.part}>
      Glob "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.count}>({props.metadata.count} matches)</Show>
    </InlineTool>
  )
}

function Read(props: ToolProps<typeof ReadTool>) {
  const { theme } = useTheme()
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool icon="→" pending="Reading file..." complete={props.input.filePath} part={props.part}>
        Read {normalizePath(props.input.filePath!)} {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {normalizePath(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps<typeof GrepTool>) {
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={props.input.pattern} part={props.part}>
      Grep "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.matches}>({props.metadata.matches} matches)</Show>
    </InlineTool>
  )
}

function List(props: ToolProps<typeof ListTool>) {
  const dir = createMemo(() => {
    if (props.input.path) {
      return normalizePath(props.input.path)
    }
    return ""
  })
  return (
    <InlineTool icon="→" pending="Listing directory..." complete={props.input.path !== undefined} part={props.part}>
      List {dir()}
    </InlineTool>
  )
}

function WebFetch(props: ToolProps<typeof WebFetchTool>) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={(props.input as any).url} part={props.part}>
      WebFetch {(props.input as any).url}
    </InlineTool>
  )
}

function CodeSearch(props: ToolProps<any>) {
  const input = props.input as any
  const metadata = props.metadata as any
  return (
    <InlineTool icon="◇" pending="Searching code..." complete={input.query} part={props.part}>
      Exa Code Search "{input.query}" <Show when={metadata.results}>({metadata.results} results)</Show>
    </InlineTool>
  )
}

function WebSearch(props: ToolProps<any>) {
  const input = props.input as any
  const metadata = props.metadata as any
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={input.query} part={props.part}>
      Exa Web Search "{input.query}" <Show when={metadata.numResults}>({metadata.numResults} results)</Show>
    </InlineTool>
  )
}

function Edit(props: ToolProps<typeof EditTool>) {
  const ctx = use()
  const { theme, syntax } = useTheme()

  const view = createMemo(() => {
    const diffStyle = ctx.sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(props.input.filePath))

  const diffContent = createMemo(() => props.metadata.diff)

  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    const arr = props.metadata.diagnostics?.[filePath] ?? []
    return arr.filter((x) => x.severity === 1).slice(0, 3)
  })

  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool title={"← Edit " + normalizePath(props.input.filePath!)} part={props.part}>
          <box paddingLeft={1}>
            <diff
              diff={diffContent()}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax()}
              showLineNumbers={true}
              width="100%"
              wrapMode={ctx.diffWrapMode()}
              fg={theme.text}
              addedBg={theme.diffAddedBg}
              removedBg={theme.diffRemovedBg}
              contextBg={theme.diffContextBg}
              addedSignColor={theme.diffHighlightAdded}
              removedSignColor={theme.diffHighlightRemoved}
              lineNumberFg={theme.diffLineNumber}
              lineNumberBg={theme.diffContextBg}
              addedLineNumberBg={theme.diffAddedLineNumberBg}
              removedLineNumberBg={theme.diffRemovedLineNumberBg}
            />
          </box>
          <Show when={diagnostics().length}>
            <box>
              <For each={diagnostics()}>
                {(diagnostic) => (
                  <text fg={theme.error}>
                    Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]{" "}
                    {diagnostic.message}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit..." complete={props.input.filePath} part={props.part}>
          Edit {normalizePath(props.input.filePath!)} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps<typeof ApplyPatchTool>) {
  const ctx = use()
  const { theme, syntax } = useTheme()

  const files = createMemo(() => props.metadata.files ?? [])

  const view = createMemo(() => {
    const diffStyle = ctx.sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <box paddingLeft={1}>
        <diff
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode={ctx.diffWrapMode()}
          fg={theme.text}
          addedBg={theme.diffAddedBg}
          removedBg={theme.diffRemovedBg}
          contextBg={theme.diffContextBg}
          addedSignColor={theme.diffHighlightAdded}
          removedSignColor={theme.diffHighlightRemoved}
          lineNumberFg={theme.diffLineNumber}
          lineNumberBg={theme.diffContextBg}
          addedLineNumberBg={theme.diffAddedLineNumberBg}
          removedLineNumberBg={theme.diffRemovedLineNumberBg}
        />
      </box>
    )
  }

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + normalizePath(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={title(file)} part={props.part}>
              <Show
                when={file.type !== "delete"}
                fallback={
                  <text fg={theme.diffRemoved}>
                    -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <Diff diff={file.diff} filePath={file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing apply_patch..." complete={false} part={props.part}>
          apply_patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps<typeof TodoWriteTool>) {
  return (
    <Switch>
      <Match when={props.metadata.todos?.length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={props.input.todos ?? []}>
              {(todo) => <TodoItem status={todo.status} content={todo.content} />}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="Updating todos..." complete={false} part={props.part}>
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps<typeof QuestionTool>) {
  const { theme } = useTheme()

  type QuestionInfo = { question: string }

  const questions = createMemo(() => (props.input.questions as QuestionInfo[] | undefined) ?? [])
  const answers = createMemo(() => props.metadata.answers as string[][] | undefined)

  function format(answer?: string[]) {
    if (!answer?.length) return "Unanswered"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={answers()}>
        <BlockTool title="# Questions" part={props.part}>
          <box>
            <For each={questions()}>
              {(q, i) => (
                <box flexDirection="row" gap={1}>
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(answers()?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="?" pending="Asking questions..." complete={false} part={props.part}>
          Asking questions...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function SubagentSpawn(props: ToolProps<any>) {
  const themeState = useTheme()
  const theme = themeState.theme
  const syntax = themeState.syntax
  const dialog = useDialog()

  const pending = createMemo(() => props.part.state.status === "pending")

  const metadata = createMemo(() => {
    return props.metadata as
      | {
          ok?: boolean
          status?: string
          reason?: string
          blocked?: string[]
          spawned?: Array<{ session_id: string; agent: string }>
          errors?: string[]
          seq?: number
        }
      | undefined
  })

  const input = createMemo(() => props.input as { agents?: Array<{ agent: string; prompt: string }> } | undefined)

  const spawned = createMemo(() => metadata()?.spawned ?? [])
  const requested = createMemo(() => input()?.agents?.length ?? 0)
  const blocked = createMemo(() => !pending() && (metadata()?.ok === false || metadata()?.status === "blocked"))

  const title = createMemo(() => {
    if (blocked()) return `# Subagent spawn blocked (${requested()} requested)`
    const count = spawned().length || requested()
    return `# Spawned ${count} subagent${count === 1 ? "" : "s"}`
  })

  const seq = createMemo(() => metadata()?.seq)

  return (
    <BlockTool title={title()} part={props.part}>
      <box>
        <Show when={blocked()}>
          <box flexDirection="column" gap={1}>
            <text fg={theme.error}>
              ✗ <b>Blocked</b> by machine-wide LLM concurrency limits
            </text>
            <Show when={props.output}>
              <code
                filetype="markdown"
                drawUnstyledText={false}
                fg={theme.textMuted}
                content={props.output ?? ""}
                syntaxStyle={syntax()}
              />
            </Show>
          </box>
        </Show>

        <Show when={!blocked()}>
          <Show when={seq() !== undefined}>
            <text fg={theme.textMuted}>checkpoint seq: {seq()}</text>
          </Show>

          <Show when={pending() && !spawned().length && requested() > 0}>
            <For each={input()!.agents}>
              {(agent) => (
                <box marginTop={1}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.warning }}>◐</span> <b>{agent.agent}</b> spawning...
                  </text>
                </box>
              )}
            </For>
          </Show>

          <For each={spawned()}>
            {(item) => (
              <SubagentRow
                sessionID={item.session_id}
                agent={item.agent}
                onSelect={() => dialog.replace(() => <DialogSubagent sessionID={item.session_id} />)}
              />
            )}
          </For>

          <Show when={metadata()?.errors?.length}>
            <For each={metadata()?.errors ?? []}>{(error) => <text fg={theme.error}>✗ {error}</text>}</For>
          </Show>
        </Show>
      </box>
    </BlockTool>
  )
}

function WaitAgentMessage(props: ToolProps<any>) {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const renderer = useRenderer()
  const ctx = use()

  const state = createMemo(() => props.part.state as any)

  const meta = createMemo(() => {
    const s = state()
    if (!s || s.status === "pending") return undefined
    return s.metadata as any
  })

  const input = createMemo(() => {
    const s = state()
    if (!s || s.status === "pending") return undefined
    return s.input as any
  })

  const status = createMemo(() => (meta()?.status as string | undefined) ?? "waiting")
  const mode = createMemo(() => (meta()?.mode as ("all" | "any") | undefined) ?? input()?.mode)
  const timeout = createMemo(() => (meta()?.timeout as number | undefined) ?? input()?.timeout)
  const sources = createMemo(() => {
    const fromMetadata = meta()?.sources as string[] | undefined
    if (fromMetadata) return fromMetadata
    const raw = input()?.sources
    if (typeof raw === "string") return [raw]
    if (Array.isArray(raw)) return raw
    return []
  })

  const isWildcard = createMemo(() => sources().length === 1 && sources()[0] === "*")
  const respondedSources = createMemo(() => (meta()?.respondedSources as string[] | undefined) ?? [])
  const respondedSeqs = createMemo(() => (meta()?.respondedSeqs as Record<string, number> | undefined) ?? {})
  const timedOutSeqs = createMemo(() => (meta()?.timedOutSeqs as Record<string, number> | undefined) ?? {})

  const createdAt = createMemo(() => meta()?.createdAt as number | undefined)
  const deadline = createMemo(() => meta()?.deadline as number | undefined)
  const baselineSince = createMemo(() => meta()?.since as number | undefined)
  const rawSince = createMemo(() => {
    const value = input()?.since
    if (typeof value !== "number") return undefined
    return value
  })
  const sinceLabel = createMemo(() => {
    const baseline = baselineSince()
    if (baseline !== undefined) {
      const raw = rawSince()
      if (raw === undefined || raw === baseline) return String(baseline)
      return `${baseline} (raw: ${raw})`
    }

    const raw = rawSince()
    if (raw === undefined) return undefined
    return String(raw)
  })
  const resolvedAt = createMemo(() => meta()?.resolvedAt as number | undefined)
  const resolvedElapsed = createMemo(() => {
    const start = createdAt()
    if (start === undefined) return undefined
    const end = resolvedAt()
    if (end === undefined) return undefined
    return Math.max(0, end - start)
  })
  const interruptedAt = createMemo(() => meta()?.interruptedAt as number | undefined)
  const interruptedBy = createMemo(() => meta()?.interruptedBy as "prompt" | "abort" | undefined)

  const interruptedLabel = createMemo(() => {
    const by = interruptedBy()
    if (by === "prompt") return "new prompt"
    if (by === "abort") return "abort"
    return undefined
  })

  const interruptedElapsed = createMemo(() => {
    const start = createdAt()
    if (start === undefined) return undefined
    const at = interruptedAt()
    if (at === undefined) return undefined
    return Math.max(0, at - start)
  })

  const interruptedLeft = createMemo(() => {
    const at = interruptedAt()
    if (at === undefined) return undefined
    const end = deadline()
    if (end === undefined) return undefined
    return Math.max(0, end - at)
  })

  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (effectiveStatus() !== "waiting") return
    const timer = setInterval(() => setNow(Date.now()), 100)
    onCleanup(() => clearInterval(timer))
  })

  const elapsed = createMemo(() => {
    const start = createdAt()
    if (!start) return undefined
    return Math.max(0, now() - start)
  })

  const remaining = createMemo(() => {
    const end = deadline()
    if (!end) return undefined
    return Math.max(0, end - now())
  })

  const effectiveStatus = createMemo(() => {
    const s = status()
    if (s !== "waiting") return s

    const end = deadline()
    if (end !== undefined && now() >= end) {
      return "timedOut"
    }

    return s
  })

  const fmt = (ms: number | undefined) => {
    if (ms === undefined) return ""
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  const getAgentName = (id: string) => {
    const shortId = id.slice(-4)
    const session = sync.session.get(id)
    if (session?.title?.startsWith("Subagent - ")) {
      const agentType = session.title.slice(11)
      return `${agentType}#${shortId}`
    }
    if (session?.title) return `${session.title}#${shortId}`
    return `agent#${shortId}`
  }

  const label = (id: string) => {
    if (!id.startsWith("ses_")) return id
    return getAgentName(id)
  }

  const formatSeqs = (seqs: Record<string, number>) => {
    const entries = Object.entries(seqs)
    if (entries.length === 0) return undefined
    return entries.map(([id, seq]) => `${label(id)}:${seq}`).join(", ")
  }

  const respondedSeqLine = createMemo(() => formatSeqs(respondedSeqs()))
  const timedOutSeqLine = createMemo(() => formatSeqs(timedOutSeqs()))

  const failedSources = createMemo(() => {
    if (isWildcard()) return []
    const responded = new Set(respondedSources())
    return sources().filter((s) => !responded.has(s))
  })

  const timedOutSources = createMemo(() => {
    if (isWildcard()) return []
    const failed = failedSources()
    if (failed.length > 0) return failed
    return sources()
  })

  const statusColor = createMemo(() => {
    if (effectiveStatus() === "waiting") return theme.warning
    if (effectiveStatus() === "resolved") return theme.success
    if (effectiveStatus() === "interrupted") return theme.warning
    return theme.error
  })

  const jump = (sessionID: string) => {
    if (renderer.getSelection()?.getSelectedText()) return
    if (!sessionID.startsWith("ses_")) return
    route.navigate({ type: "session", sessionID })
  }

  const SessionLink = (props: { sessionID: string; fg: RGBA }) => {
    const isLink = props.sessionID.startsWith("ses_")

    if (!isLink) {
      return (
        <text>
          <span style={{ fg: props.fg }}>{props.sessionID}</span>
        </text>
      )
    }

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: TUI click handler
      // biome-ignore lint/a11y/useFocusableInteractive: TUI click handler
      <box onMouseUp={() => jump(props.sessionID)}>
        <text>
          <span style={{ fg: props.fg, underline: true }}>{getAgentName(props.sessionID)}</span>
        </text>
      </box>
    )
  }

  const CommaList = (props: { sessions: string[]; fg: RGBA }) => {
    return (
      <For each={props.sessions}>
        {(sessionID, index) => (
          <>
            <Show when={index() > 0}>
              <text fg={theme.textMuted}>, </text>
            </Show>
            <SessionLink sessionID={sessionID} fg={props.fg} />
          </>
        )}
      </For>
    )
  }

  const MetaLine = (props: { elapsed?: number; left?: number }) => {
    return (
      <text fg={theme.textMuted}>
        ({mode()}, {Math.round((timeout() ?? 0) / 1000)}s{sinceLabel() ? `, since: ${sinceLabel()}` : ""})
        {props.elapsed !== undefined && <span> · {fmt(props.elapsed)} elapsed</span>}
        {props.left !== undefined && <span> · {fmt(props.left)} left</span>}
      </text>
    )
  }

  return (
    <Switch>
      <Match when={effectiveStatus() === "blocked"}>
        <box marginTop={1} paddingLeft={6}>
          <box flexDirection="column">
            <box flexDirection="row" flexWrap="wrap">
              <text fg={statusColor()}>⛔ wait blocked</text>
              <Show when={meta()?.error}>
                <text fg={theme.textMuted}> · {meta()?.error}</text>
              </Show>
            </box>
            <MetaLine />
          </box>
        </box>
      </Match>
      <Match when={effectiveStatus() === "resolved" && mode() === "all"}>
        <box marginTop={1} paddingLeft={6}>
          <box flexDirection="column">
            <box flexDirection="row" flexWrap="wrap">
              <text fg={statusColor()}>✓ </text>
              <CommaList sessions={respondedSources().length > 0 ? respondedSources() : sources()} fg={statusColor()} />
              <Show when={failedSources().length > 0}>
                <text fg={theme.textMuted}> · ○ </text>
                <CommaList sessions={failedSources()} fg={theme.textMuted} />
              </Show>
            </box>
            <MetaLine elapsed={resolvedElapsed()} />
            <Show when={ctx.showDetails() && respondedSeqLine()}>
              <text fg={theme.textMuted}>seq: {respondedSeqLine()}</text>
            </Show>
          </box>
        </box>
      </Match>
      <Match when={effectiveStatus() === "resolved" && mode() === "any"}>
        <box marginTop={1} paddingLeft={6}>
          <box flexDirection="column">
            <box flexDirection="row" flexWrap="wrap">
              <text fg={statusColor()}>✓ </text>
              <CommaList sessions={respondedSources()} fg={statusColor()} />
              <Show when={failedSources().length > 0}>
                <text fg={theme.textMuted}> · ○ </text>
                <CommaList sessions={failedSources()} fg={theme.textMuted} />
              </Show>
            </box>
            <MetaLine elapsed={resolvedElapsed()} />
            <Show when={ctx.showDetails() && respondedSeqLine()}>
              <text fg={theme.textMuted}>seq: {respondedSeqLine()}</text>
            </Show>
          </box>
        </box>
      </Match>
      <Match when={effectiveStatus() === "interrupted"}>
        <box marginTop={1} paddingLeft={6}>
          <box flexDirection="column">
            <box flexDirection="row" flexWrap="wrap">
              <text fg={statusColor()}>⏹ wait interrupted</text>
              <Show when={interruptedLabel()}>
                <text fg={theme.textMuted}> ({interruptedLabel()})</text>
              </Show>
              <Show when={respondedSources().length > 0}>
                <text fg={theme.success}> · ✓ </text>
                <CommaList sessions={respondedSources()} fg={theme.success} />
              </Show>
              <Show when={failedSources().length > 0}>
                <text fg={theme.textMuted}> · ○ </text>
                <CommaList sessions={failedSources()} fg={theme.textMuted} />
              </Show>
            </box>
            <MetaLine elapsed={interruptedElapsed()} left={interruptedLeft()} />
            <Show when={ctx.showDetails() && respondedSeqLine()}>
              <text fg={theme.textMuted}>seq: {respondedSeqLine()}</text>
            </Show>
          </box>
        </box>
      </Match>
      <Match when={effectiveStatus() === "timedOut"}>
        <box marginTop={1} paddingLeft={6}>
          <box flexDirection="column">
            <box flexDirection="row" flexWrap="wrap">
              <text fg={statusColor()}>⏱ </text>
              <CommaList sessions={timedOutSources()} fg={statusColor()} />
              <text fg={statusColor()}> timed out</text>
              <Show when={respondedSources().length > 0}>
                <text fg={theme.success}> · ✓ </text>
                <CommaList sessions={respondedSources()} fg={theme.success} />
              </Show>
            </box>
            <MetaLine elapsed={resolvedElapsed()} />
            <Show when={ctx.showDetails() && (respondedSeqLine() || timedOutSeqLine())}>
              <Show when={respondedSeqLine()}>
                <text fg={theme.textMuted}>seq: {respondedSeqLine()}</text>
              </Show>
              <Show when={timedOutSeqLine()}>
                <text fg={theme.textMuted}>last: {timedOutSeqLine()}</text>
              </Show>
            </Show>
          </box>
        </box>
      </Match>
      <Match when={true}>
        <box marginTop={1} paddingLeft={6}>
          <box flexDirection="column">
            <box flexDirection="row" flexWrap="wrap">
              <text fg={statusColor()}>⏳ </text>
              <Show
                when={respondedSources().length > 0}
                fallback={
                  isWildcard() ? (
                    <text fg={theme.textMuted}>any agent</text>
                  ) : (
                    <CommaList sessions={sources()} fg={theme.textMuted} />
                  )
                }
              >
                <text fg={theme.success}>✓ </text>
                <CommaList sessions={respondedSources()} fg={theme.success} />
                <Show when={failedSources().length > 0}>
                  <text fg={theme.textMuted}> · ○ </text>
                  <CommaList sessions={failedSources()} fg={theme.textMuted} />
                </Show>
              </Show>
            </box>
            <MetaLine elapsed={elapsed()} left={remaining()} />
            <Show when={ctx.showDetails() && respondedSeqLine()}>
              <text fg={theme.textMuted}>seq: {respondedSeqLine()}</text>
            </Show>
          </box>
        </box>
      </Match>
    </Switch>
  )
}

function SubagentRow(props: { sessionID: string; agent: string; onSelect: () => void }) {
  const { theme } = useTheme()
  const sync = useSync()
  const renderer = useRenderer()

  createEffect(() => {
    sync.session.sync(props.sessionID).catch(() => {})
  })

  const status = createMemo(() => {
    const s = sync.data.session_status?.[props.sessionID] as { type: string } | undefined
    if (s?.type === "busy" || s?.type === "retry") return "working"
    if (s?.type === "waiting") return "waiting"
    return "done"
  })

  const isWorking = createMemo(() => status() === "working" || status() === "waiting")
  const shortId = props.sessionID.slice(-4)

  const initialTask = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    const firstUser = messages.find((m) => m.role === "user")
    if (!firstUser) return undefined
    const parts = sync.data.part[firstUser.id] ?? []
    const msgPart = parts.find((p) => (p as any).type === "message" && (p as any).direction === "incoming") as any
    if (msgPart?.text) {
      const text = msgPart.text.trim()
      return truncateEnd({ method: renderer.widthMethod, text, max: 60, tail: "..." })
    }
    const textPart = parts.find((p) => p.type === "text" && "synthetic" in p && p.synthetic)
    if (textPart && textPart.type === "text") {
      const text = textPart.text.trim()
      return truncateEnd({ method: renderer.widthMethod, text, max: 60, tail: "..." })
    }
    return undefined
  })

  const lastResponse = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== "assistant") continue
      const parts = sync.data.part[msg.id] ?? []
      const msgPart = parts.find(
        (p) => (p as any).type === "message" && (p as any).direction === "outgoing" && (p as any).peerType === "agent",
      ) as any
      if (msgPart?.text) {
        const text = msgPart.text.trim()
        return truncateEnd({ method: renderer.widthMethod, text, max: 60, tail: "..." })
      }
      const textPart = parts.find((p) => p.type === "text" && !("synthetic" in p && p.synthetic))
      if (textPart && textPart.type === "text") {
        const text = textPart.text.trim()
        return truncateEnd({ method: renderer.widthMethod, text, max: 60, tail: "..." })
      }
    }
    return undefined
  })

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: TUI click handler
    <box marginTop={1} onMouseUp={props.onSelect}>
      <text>
        <Show when={isWorking()} fallback={<span style={{ fg: theme.success }}>✓</span>}>
          <span style={{ fg: theme.warning }}>◐</span>
        </Show>{" "}
        <span style={{ fg: theme.secondary, bold: true }}>{props.agent}</span>
        <span style={{ fg: theme.textMuted }}>#{shortId}</span>
        <span style={{ fg: theme.textMuted }}> [{status()}]</span>
      </text>
      <Show when={initialTask()}>
        <text fg={theme.textMuted}> → {initialTask()}</text>
      </Show>
      <Show when={lastResponse()}>
        <text fg={theme.text}> ← {lastResponse()}</text>
      </Show>
    </box>
  )
}

function normalizePath(input?: string) {
  if (!input) return ""
  if (path.isAbsolute(input)) {
    return path.relative(process.cwd(), input) || "."
  }
  return input
}

function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
