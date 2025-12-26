import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  useContext,
  type Component,
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
  RGBA,
  type ScrollAcceleration,
} from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import type { AssistantMessage, Part, ToolPart, UserMessage, TextPart, ReasoningPart } from "@opencode-ai/sdk/v2"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util/locale"
import type { Tool } from "@/tool/tool"
import type { ReadTool } from "@/tool/read"
import type { WriteTool } from "@/tool/write"
import { BashTool } from "@/tool/bash"
import type { GlobTool } from "@/tool/glob"
import { TodoWriteTool } from "@/tool/todo"
import type { GrepTool } from "@/tool/grep"
import type { ListTool } from "@/tool/ls"
import type { EditTool } from "@/tool/edit"
import type { PatchTool } from "@/tool/patch"
import type { WebFetchTool } from "@/tool/webfetch"
import { useKeyboard, useRenderer, useTerminalDimensions, type BoxProps, type JSX } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "@tui/context/keybind"
import { Header } from "./header"
import { parsePatch } from "diff"
import { useDialog } from "../../ui/dialog"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"

import { iife } from "@/util/iife"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { DialogChildSessionList } from "../../component/dialog-child-session-list"
import { Sidebar } from "./sidebar"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import parsers from "../../../../../../parsers-config.ts"
import { Clipboard } from "../../util/clipboard"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import { Editor } from "../../util/editor"
import stripAnsi from "strip-ansi"
import { Footer } from "./footer.tsx"
import { usePromptRef } from "../../context/prompt"
import { Filesystem } from "@/util/filesystem"
import { DialogSubagent } from "./dialog-subagent.tsx"

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
  conceal: () => boolean
  showThinking: () => boolean
  showTimestamps: () => boolean
  usernameVisible: () => boolean
  showDetails: () => boolean
  userMessageMarkdown: () => boolean
  diffWrapMode: () => "word" | "none"
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
  const session = createMemo(() => sync.session.get(route.sessionID)!)
  const rawMessages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const permissions = createMemo(() => sync.data.permission[route.sessionID] ?? [])

  // Get task prompt for current session
  const currentTaskPrompt = createMemo((): string | undefined => {
    const sessionID = route.sessionID
    const s = sync.data.session.find((x) => x.id === sessionID)
    if (!s) return undefined
    const prompt = (s as any).subagentPrompt
    if (typeof prompt !== "string" || !prompt) return undefined
    return prompt
  })

  // Messages getter that other code uses
  const messages = rawMessages

  const pending = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant" && !x.time.completed)?.id
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = createSignal<"show" | "hide" | "auto">(kv.get("sidebar", "auto"))
  const [conceal, setConceal] = createSignal(true)
  const [showThinking, setShowThinking] = createSignal(kv.get("thinking_visibility", true))
  const [showTimestamps, setShowTimestamps] = createSignal(kv.get("timestamps", "hide") === "show")
  const [usernameVisible, setUsernameVisible] = createSignal(kv.get("username_visible", true))
  const [showDetails, setShowDetails] = createSignal(kv.get("tool_details_visibility", true))
  const [showScrollbar, setShowScrollbar] = createSignal(kv.get("scrollbar_visible", false))
  const [userMessageMarkdown, setUserMessageMarkdown] = createSignal(kv.get("user_message_markdown", true))
  const [diffWrapMode, setDiffWrapMode] = createSignal<"word" | "none">("word")

  const wide = createMemo(() => dimensions().width > 120)
  const tall = createMemo(() => dimensions().height > 40)
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (sidebar() === "show") return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const sidebarOverlay = createMemo(() => sidebarVisible() && !wide())
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() && !sidebarOverlay() ? 42 : 0) - 4)

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

  createEffect(async () => {
    await sync.session
      .sync(route.sessionID)
      .then(() => {
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
        console.error(e)
        toast.show({
          message: `Session not found: ${route.sessionID}`,
          variant: "error",
        })
        return navigate({ type: "home" })
      })
  })

  const toast = useToast()
  const sdk = useSDK()

  // Handle initial prompt from fork
  createEffect(() => {
    if (route.initialPrompt && prompt) {
      prompt.set(route.initialPrompt)
    }
  })

  // Auto-navigate to whichever session currently needs permission input
  createEffect(() => {
    const currentSession = session()
    if (!currentSession) return
    const currentPermissions = permissions()
    let targetID = currentPermissions.length > 0 ? currentSession.id : undefined

    if (!targetID) {
      const child = sync.data.session.find(
        (x) => x.parentID === currentSession.id && (sync.data.permission[x.id]?.length ?? 0) > 0,
      )
      if (child) targetID = child.id
    }

    if (targetID && targetID !== currentSession.id) {
      navigate({
        type: "session",
        sessionID: targetID,
      })
    }
  })

  let scroll: ScrollBoxRenderable
  let prompt: PromptRef
  const keybind = useKeybind()

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

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    const first = permissions()[0]
    if (first) {
      const response = iife(() => {
        if (evt.ctrl || evt.meta) return
        if (evt.name === "return") return "once"
        if (evt.name === "a") return "always"
        if (evt.name === "d") return "reject"
        if (evt.name === "escape") return "reject"
        return
      })
      if (response) {
        sdk.client.permission.respond({
          permissionID: first.id,
          sessionID: route.sessionID,
          response: response,
        })
      }
    }
  })

  function toBottom() {
    setTimeout(() => {
      if (scroll) scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  const local = useLocal()

  function moveChild(direction: number) {
    const parentID = session()?.parentID ?? session()?.id
    let children = sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (children.length === 1) return
    let next = children.findIndex((x) => x.id === session()?.id) + direction
    if (next >= children.length) next = 0
    if (next < 0) next = children.length - 1
    if (children[next]) {
      navigate({
        type: "session",
        sessionID: children[next].id,
      })
    }
  }

  const command = useCommandDialog()
  command.register(() => [
    ...(sync.data.config.share !== "disabled"
      ? [
          {
            title: "Share session",
            value: "session.share",
            suggested: route.type === "session",
            keybind: "session_share" as const,
            disabled: !!session()?.share?.url,
            category: "Session",
            onSelect: async (dialog: any) => {
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
        ]
      : []),
    {
      title: "Rename session",
      value: "session.rename",
      keybind: "session_rename",
      category: "Session",
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      keybind: "session_timeline",
      category: "Session",
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
      onSelect: (dialog) => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: "Unshare session",
      value: "session.unshare",
      keybind: "session_unshare",
      disabled: !session()?.share?.url,
      category: "Session",
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
      onSelect: async (dialog) => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const revert = session().revert?.messageID
        const message = messages().findLast((x) => {
          if (x.role !== "user") return false
          if (revert && x.id >= revert) return false
          const parts = sync.data.part[x.id] ?? []
          return parts.some((p) => p.type === "text" && !("synthetic" in p && p.synthetic) && !(p as any).ignored)
        })
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
      disabled: !session()?.revert?.messageID,
      category: "Session",
      onSelect: (dialog) => {
        dialog.clear()
        const messageID = session().revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => {
          if (x.role !== "user") return false
          if (x.id <= messageID) return false
          const parts = sync.data.part[x.id] ?? []
          return parts.some((p) => p.type === "text" && !("synthetic" in p && p.synthetic) && !(p as any).ignored)
        })
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
        setSidebar((prev) => {
          if (prev === "auto") return sidebarVisible() ? "hide" : "show"
          if (prev === "show") return "hide"
          return "show"
        })
        if (sidebar() === "show") kv.set("sidebar", "auto")
        if (sidebar() === "hide") kv.set("sidebar", "hide")
        dialog.clear()
      },
    },
    {
      title: usernameVisible() ? "Hide username" : "Show username",
      value: "session.username_visible.toggle",
      keybind: "username_toggle",
      category: "Session",
      onSelect: (dialog) => {
        setUsernameVisible((prev) => {
          const next = !prev
          kv.set("username_visible", next)
          return next
        })
        dialog.clear()
      },
    },
    {
      title: "Toggle code concealment",
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
      onSelect: (dialog) => {
        setShowTimestamps((prev) => {
          const next = !prev
          kv.set("timestamps", next ? "show" : "hide")
          return next
        })
        dialog.clear()
      },
    },
    {
      title: showThinking() ? "Hide thinking" : "Show thinking",
      value: "session.toggle.thinking",
      category: "Session",
      onSelect: (dialog) => {
        setShowThinking((prev) => {
          const next = !prev
          kv.set("thinking_visibility", next)
          return next
        })
        dialog.clear()
      },
    },
    {
      title: "Toggle diff wrapping",
      value: "session.toggle.diffwrap",
      category: "Session",
      onSelect: (dialog) => {
        setDiffWrapMode((prev) => (prev === "word" ? "none" : "word"))
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: "Session",
      onSelect: (dialog) => {
        const newValue = !showDetails()
        setShowDetails(newValue)
        kv.set("tool_details_visibility", newValue)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        setShowScrollbar((prev) => {
          const next = !prev
          kv.set("scrollbar_visible", next)
          return next
        })
        dialog.clear()
      },
    },
    {
      title: userMessageMarkdown() ? "Disable user message markdown" : "Enable user message markdown",
      value: "session.toggle.user_message_markdown",
      category: "Session",
      onSelect: (dialog) => {
        setUserMessageMarkdown((prev) => {
          const next = !prev
          kv.set("user_message_markdown", next)
          return next
        })
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      keybind: "messages_page_up",
      category: "Session",
      disabled: true,
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
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: "Session",
      disabled: true,
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
      disabled: true,
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
      disabled: true,
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
      disabled: true,
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
      disabled: true,
      onSelect: (dialog) => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      keybind: "messages_previous",
      category: "Session",
      disabled: true,
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

        const base64 = Buffer.from(text).toString("base64")
        const osc52 = `\x1b]52;c;${base64}\x07`
        const finalOsc52 = process.env["TMUX"] ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52
        /* @ts-expect-error */
        renderer.writeOut(finalOsc52)
        Clipboard.copy(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      keybind: "session_copy",
      category: "Session",
      onSelect: async (dialog) => {
        try {
          // Format session transcript as markdown
          const sessionData = session()
          const sessionMessages = messages()

          let transcript = `# ${sessionData.title}\n\n`
          transcript += `**Session ID:** ${sessionData.id}\n`
          transcript += `**Created:** ${new Date(sessionData.time.created).toLocaleString()}\n`
          transcript += `**Updated:** ${new Date(sessionData.time.updated).toLocaleString()}\n\n`
          transcript += `---\n\n`

          for (const msg of sessionMessages) {
            const parts = sync.data.part[msg.id] ?? []
            const role = msg.role === "user" ? "User" : "Assistant"
            transcript += `## ${role}\n\n`

            for (const part of parts) {
              if (part.type === "text" && !part.synthetic) {
                transcript += `${part.text}\n\n`
              } else if (part.type === "tool" && part.tool !== "send_agent_message") {
                transcript += `\`\`\`\nTool: ${part.tool}\n\`\`\`\n\n`
              }
            }

            transcript += `---\n\n`
          }

          // Copy to clipboard
          await Clipboard.copy(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch (error) {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript to file",
      value: "session.export",
      keybind: "session_export",
      category: "Session",
      onSelect: async (dialog) => {
        try {
          // Format session transcript as markdown
          const sessionData = session()
          const sessionMessages = messages()

          let transcript = `# ${sessionData.title}\n\n`
          transcript += `**Session ID:** ${sessionData.id}\n`
          transcript += `**Created:** ${new Date(sessionData.time.created).toLocaleString()}\n`
          transcript += `**Updated:** ${new Date(sessionData.time.updated).toLocaleString()}\n\n`
          transcript += `---\n\n`

          for (const msg of sessionMessages) {
            const parts = sync.data.part[msg.id] ?? []
            const role = msg.role === "user" ? "User" : "Assistant"
            transcript += `## ${role}\n\n`

            for (const part of parts) {
              if (part.type === "text" && !part.synthetic) {
                transcript += `${part.text}\n\n`
              } else if (part.type === "tool" && part.tool !== "send_agent_message") {
                transcript += `\`\`\`\nTool: ${part.tool}\n\`\`\`\n\n`
              }
            }

            transcript += `---\n\n`
          }

          // Prompt for optional filename
          const customFilename = await DialogPrompt.show(dialog, "Export filename", {
            value: `session-${sessionData.id.slice(0, 8)}.md`,
          })

          // Cancel if user pressed escape
          if (customFilename === null) return

          // Save to file in current working directory
          const exportDir = process.cwd()
          const filename = customFilename.trim()
          const filepath = path.join(exportDir, filename)

          await Bun.write(filepath, transcript)

          // Open with EDITOR if available
          const result = await Editor.open({ value: transcript, renderer })
          if (result !== undefined) {
            // User edited the file, save the changes
            await Bun.write(filepath, result)
          }

          toast.show({ message: `Session exported to ${filename}`, variant: "success" })
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
        const current = session()
        if (!current) return
        const rootID = current.parentID ?? current.id
        const directChildren = sync.data.session.filter((s) => s.parentID === rootID)
        if (directChildren.length === 0) {
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
      disabled: !session()?.parentID,
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

  return (
    <context.Provider
      value={{
        get width() {
          return contentWidth()
        },
        conceal,
        showThinking,
        showTimestamps,
        usernameVisible,
        showDetails,
        userMessageMarkdown,
        diffWrapMode,
        sync,
      }}
    >
      <box flexDirection="row">
        <box flexGrow={1} paddingBottom={1} paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
          <Show
            when={session()}
            fallback={
              <box flexGrow={1} justifyContent="center" alignItems="center">
                <box flexDirection="row" gap={1}>
                  <spinner color={theme.accent} frames={["◜", "◠", "◝", "◞", "◡", "◟"]} interval={80} />
                  <text fg={theme.textMuted}>Loading session...</text>
                </box>
              </box>
            }
          >
            <Show when={!sidebarVisible() || sidebarOverlay()}>
              <Header />
            </Show>
            <For each={[route.sessionID]}>
              {(sessionID) => (
                <scrollbox
                  ref={(r) => (scroll = r)}
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
                  <For each={messages()}>
                    {(message, index) => (
                      <Switch>
                        <Match when={message.id === revert()?.messageID}>
                          {(function () {
                            const command = useCommandDialog()
                            const [hover, setHover] = createSignal(false)
                            const dialog = useDialog()

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
                                  <text fg={theme.textMuted}>{revert()!.reverted.length} message reverted</text>
                                  <text fg={theme.textMuted}>
                                    <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span> or /redo to
                                    restore
                                  </text>
                                  <Show when={revert()!.diffFiles?.length}>
                                    <box marginTop={1}>
                                      <For each={revert()!.diffFiles}>
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
                            )
                          })()}
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
                                  sessionID={route.sessionID}
                                  setPrompt={(promptInfo) => prompt.set(promptInfo)}
                                />
                              ))
                            }}
                            message={message as UserMessage}
                            parts={sync.data.part[message.id] ?? []}
                            pending={pending()}
                          />
                        </Match>
                        <Match when={message.role === "assistant"}>
                          <AssistantMessage
                            last={lastAssistant()?.id === message.id}
                            message={message as AssistantMessage}
                            parts={sync.data.part[message.id] ?? []}
                          />
                        </Match>
                      </Switch>
                    )}
                  </For>
                </scrollbox>
              )}
            </For>
            <box flexShrink={0}>
              <Prompt
                ref={(r) => {
                  prompt = r
                  promptRef.set(r)
                }}
                disabled={permissions().length > 0}
                onSubmit={() => {
                  toBottom()
                }}
                sessionID={route.sessionID}
              />
            </box>
            <Show when={(!sidebarVisible() || sidebarOverlay()) && tall()}>
              <Footer />
            </Show>
          </Show>
          <Toast />
        </box>
        <Show when={sidebarVisible() && !sidebarOverlay()}>
          <Sidebar sessionID={route.sessionID} />
        </Show>
        <Show when={sidebarOverlay()}>
          <box
            position="absolute"
            left={0}
            top={0}
            width={dimensions().width}
            height={dimensions().height}
            backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
            zIndex={100}
            flexDirection="row"
            justifyContent="flex-end"
            onMouseUp={() => setSidebar("hide")}
          >
            <box onMouseUp={(e) => e.stopPropagation()}>
              <Sidebar sessionID={route.sessionID} />
            </box>
          </box>
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

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = use()
  const local = useLocal()
  const text = createMemo(() => props.parts.flatMap((x) => (x.type === "text" && !x.synthetic ? [x] : []))[0])
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const messages = createMemo(() =>
    props.parts.flatMap((x) => ((x as any).type === "message" ? [x as unknown as MessagePartData] : [])),
  )
  const sync = useSync()
  const { theme, syntax } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending && props.message.id > props.pending)
  const color = createMemo(() => (queued() ? theme.accent : local.agent.color(props.message.agent)))

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
            <Switch>
              <Match when={ctx.userMessageMarkdown()}>
                <code
                  filetype="markdown"
                  drawUnstyledText={false}
                  streaming={false}
                  syntaxStyle={syntax()}
                  content={text()?.text ?? ""}
                  conceal={ctx.conceal()}
                  fg={theme.text}
                />
              </Match>
              <Match when={!ctx.userMessageMarkdown()}>
                <text fg={theme.text}>{text()?.text}</text>
              </Match>
            </Switch>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={1} paddingTop={1} gap={1} flexWrap="wrap">
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
            <text fg={theme.textMuted}>
              {ctx.usernameVisible() ? `${sync.data.config.username ?? "You "}` : "You "}
              <Show
                when={queued()}
                fallback={
                  <Show when={ctx.showTimestamps()}>
                    <span style={{ fg: theme.textMuted }}>
                      {ctx.usernameVisible() ? " · " : " "}
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </Show>
                }
              >
                <span> </span>
                <span style={{ bg: theme.accent, fg: theme.backgroundPanel, bold: true }}> QUEUED </span>
              </Show>
            </text>
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

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  const local = useLocal()
  const { theme } = useTheme()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])

  // Access parts reactively from the store to ensure new parts are picked up
  const reactiveParts = createMemo(() => sync.data.part[props.message.id] ?? props.parts)

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
      <Show when={props.message.error}>
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
        <Match when={props.last || final()}>
          <box paddingLeft={3}>
            <text marginTop={1}>
              <span style={{ fg: local.agent.color(props.message.mode) }}>▣ </span>{" "}
              <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.mode)}</span>
              <span style={{ fg: theme.textMuted }}> · {props.message.modelID}</span>
              <Show when={duration()}>
                <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
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
  wait: WaitPart,
}

// Type for wait parts (from message-v2.ts)
interface WaitPartData {
  id: string
  sessionID: string
  messageID: string
  type: "wait"
  sources: string[]
  timeout: number
  mode: "all" | "any"
  status: "waiting" | "resolved" | "timedOut"
  respondedSources: string[]
  time: {
    created: number
    resolved?: number
  }
}

function WaitPart(props: { last: boolean; part: WaitPartData; message: AssistantMessage }) {
  const { theme } = useTheme()
  const sync = useSync()

  // Helper to get agent name from session ID (with short ID suffix)
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

  const sourceNames = createMemo(() => props.part.sources.map(getAgentName))
  const respondedNames = createMemo(() => props.part.respondedSources.map(getAgentName))

  // Sources that didn't respond
  const failedSources = createMemo(() => {
    const responded = new Set(props.part.respondedSources)
    return props.part.sources.filter((s) => !responded.has(s)).map(getAgentName)
  })

  const duration = createMemo(() => {
    if (!props.part.time.resolved) return null
    const secs = (props.part.time.resolved - props.part.time.created) / 1000
    return secs < 1 ? `${Math.round(secs * 1000)}ms` : `${secs.toFixed(1)}s`
  })

  const statusColor = createMemo(() => {
    if (props.part.status === "waiting") return theme.warning
    if (props.part.status === "resolved") return theme.success
    return theme.error
  })

  // Resolved (all mode): hide entirely - responses speak for themselves
  if (props.part.status === "resolved" && props.part.mode === "all") {
    return null
  }

  // Resolved (any mode): show who responded, who was abandoned
  if (props.part.status === "resolved" && props.part.mode === "any") {
    return (
      <box id={"wait-" + props.part.id} marginTop={1} paddingLeft={6}>
        <text fg={statusColor()}>
          ✓ {respondedNames().join(", ")}
          {failedSources().length > 0 && <span style={{ fg: theme.textMuted }}> · ○ {failedSources().join(", ")}</span>}
          {duration() && <span style={{ fg: theme.textMuted }}> ({duration()})</span>}
        </text>
      </box>
    )
  }

  // Timed out: show who failed
  if (props.part.status === "timedOut") {
    const timedOutNames = failedSources().length > 0 ? failedSources() : sourceNames()
    return (
      <box id={"wait-" + props.part.id} marginTop={1} paddingLeft={6}>
        <text fg={statusColor()}>
          ⏱ {timedOutNames.join(", ")} timed out
          {respondedNames().length > 0 && <span style={{ fg: theme.success }}> · ✓ {respondedNames().join(", ")}</span>}
        </text>
      </box>
    )
  }

  // Waiting: show what we're waiting for
  return (
    <box id={"wait-" + props.part.id} marginTop={1} paddingLeft={6}>
      <text fg={statusColor()}>
        ⏳ {sourceNames().join(", ")} ({props.part.mode}, {Math.round(props.part.timeout / 1000)}s)
      </text>
    </box>
  )
}

// Type for message parts (unified protocol messages)
interface MessagePartData {
  id: string
  sessionID: string
  messageID: string
  type: "message"
  direction: "outgoing" | "incoming"
  peer: string
  peerType: "human" | "agent"
  text: string
  timeout?: number
  timeoutOccurred?: boolean
  time: {
    created: number
  }
}

// Message display with directional indentation
function MessagePartComponent(props: { last: boolean; part: MessagePartData; message: AssistantMessage }) {
  const { theme, syntax } = useTheme()
  const ctx = use()
  const sync = useSync()
  const dialog = useDialog()
  const renderer = useRenderer()

  const peerSession = createMemo(() =>
    props.part.peerType === "agent" ? sync.session.get(props.part.peer) : undefined,
  )

  // Check if current session is a subagent (has parentID)
  const currentSession = createMemo(() => sync.session.get(props.part.sessionID))
  const isSubagentSession = createMemo(() => !!currentSession()?.parentID)

  const isTimeout = props.part.timeoutOccurred
  const isIncoming = props.part.direction === "incoming"
  const isHuman = props.part.peerType === "human"
  const isToHuman = !isIncoming && isHuman

  // For agent messages: expanded by default in subagent sessions, collapsed in primary
  const [expanded, setExpanded] = createSignal(isSubagentSession())

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

  // Peer name resolution
  const peerInfo = createMemo(() => {
    if (isHuman) return { name: "human", shortId: "" }
    const shortId = props.part.peer.slice(-4)
    const session = peerSession()
    if (session?.title?.startsWith("Subagent - ")) {
      return { name: session.title.slice(11), shortId }
    }
    if (session?.title) return { name: session.title, shortId }
    return { name: "agent", shortId }
  })

  const arrow = isIncoming ? "←" : "→"
  // Colors: → human (primary/orange), → agent (secondary/blue), ← agent (info/cyan)
  const color = isToHuman ? theme.primary : isIncoming ? theme.info : theme.secondary
  const headerPad = isIncoming ? "" : "      " // 6 spaces for outgoing

  // Content handling for agent messages: show up to 3 lines when collapsed
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

  // Check if peer is an agent that can be navigated to
  const canNavigateToPeer = createMemo(() => props.part.peerType === "agent")

  const handlePeerClick = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    if (canNavigateToPeer()) {
      dialog.replace(() => <DialogSubagent sessionID={props.part.peer} />)
    }
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
      {/* Header line: arrow + peer name (clickable for agents) */}
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
          <text onMouseUp={handlePeerClick}>
            <span style={{ fg: isTimeout ? theme.error : color, bold: true, underline: true }}>{peerInfo().name}</span>
            {peerInfo().shortId && <span style={{ fg: theme.textMuted }}>#{peerInfo().shortId}</span>}
          </text>
        </Show>
        <text>
          {isTimeout && <span style={{ fg: theme.error }}> (timed out)</span>}
          {queued() && <span style={{ bg: theme.accent, fg: theme.backgroundPanel, bold: true }}> QUEUED </span>}
        </text>
      </box>
      {/* Expand/collapse indicator for agent messages */}
      <Show when={!isToHuman && contentInfo().canExpand}>
        <text fg={theme.textMuted} onMouseUp={toggleExpand}>
          {expanded() ? " ▼ collapse" : " ▶ expand"}
        </text>
      </Show>
      {/* Content: full markdown for human, expandable for agents */}
      <Show when={isToHuman} fallback={<text fg={theme.text}>{displayContent()}</text>}>
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

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme, subtleSyntax } = useTheme()
  const ctx = use()
  const content = createMemo(() => {
    // Filter out redacted reasoning chunks from OpenRouter
    // OpenRouter sends encrypted reasoning data that appears as [REDACTED]
    return props.part.text.replace("[REDACTED]", "").trim()
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
          content={"_Thinking:_ " + content()}
          conceal={ctx.conceal()}
          fg={theme.textMuted}
        />
      </box>
    </Show>
  )
}

// TextPart: show reasoning/text outside of structural tags
// During streaming, show content from <message to="human"> with matching border style
function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()

  // Check if the raw text contains <message to="human"> content
  const hasHumanMessage = createMemo(() => {
    const text = props.part.text
    // Check for complete or incomplete <message to="human"> tags
    return /<message\b[^>]*\bto=["']human["']/i.test(text)
  })

  const displayText = createMemo(() => {
    const text = props.part.text
    const isStreaming = !props.message.time.completed

    let result = text

    // 1. Hide ALL complete <wait> tags (self-closing)
    result = result.replace(/<wait\b[^>]*\/>/gi, "")

    // 2. Handle <message> tags differently based on streaming state
    if (isStreaming) {
      // During streaming: extract content from <message to="human"> for display
      // (MessagePart doesn't exist yet, so we show content in TextPart)
      result = result.replace(/<message\b[^>]*\bto=["']human["'][^>]*>([\s\S]*?)<\/message>/gi, "$1")
      // Hide complete non-human message tags entirely
      result = result.replace(/<message\b[^>]*>([\s\S]*?)<\/message>/gi, "")

      // 3. Extract content from INCOMPLETE <message to="human"> tags (streaming)
      const humanMsgMatch = result.match(/<message\b[^>]*\bto=["']human["'][^>]*>(?![\s\S]*<\/message>)([\s\S]*)$/)
      if (humanMsgMatch) {
        const beforeTag = result.slice(0, humanMsgMatch.index)
        const contentInside = humanMsgMatch[1] || ""
        result = (beforeTag + contentInside).trimEnd()
      } else {
        // 4. Hide incomplete <message> tags for non-human targets entirely
        const incompleteMsg = result.search(/<message\b(?![\s\S]*<\/message>)[\s\S]*$/)
        if (incompleteMsg > -1) {
          result = result.slice(0, incompleteMsg).trimEnd()
        }
      }

      // 5. Hide incomplete <wait> tags (not yet self-closed)
      const incompleteWait = result.search(/<wait\b(?![\s\S]*\/>)[\s\S]*$/)
      if (incompleteWait > -1) {
        result = result.slice(0, incompleteWait).trimEnd()
      }

      // 6. Hide trailing partial tag starts (e.g., "<mes", "<wai", "<m")
      result = result.replace(/<[a-z]{0,6}$/i, "").trimEnd()
    } else {
      // After streaming completes: hide ALL message tag content entirely
      // MessagePartComponent will render these with proper styling (border, header)
      result = result.replace(/<message\b[^>]*>([\s\S]*?)<\/message>/gi, "")
    }

    return result
  })

  const isStreaming = () => !props.message.time.completed
  const showWithBorder = () => isStreaming() && hasHumanMessage()

  return (
    <Show when={displayText().trim()}>
      <Show
        when={showWithBorder()}
        fallback={
          <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexShrink={0}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={isStreaming()}
              syntaxStyle={syntax()}
              content={displayText()}
              conceal={ctx.conceal()}
              fg={theme.text}
            />
          </box>
        }
      >
        {/* Render with border styling matching MessagePartComponent when streaming <message to="human"> */}
        <box
          id={"text-" + props.part.id}
          marginTop={1}
          paddingLeft={2}
          border={["left"]}
          borderColor={theme.primary}
          customBorderChars={SplitBorder.customBorderChars}
        >
          {/* Header line matching MessagePartComponent */}
          <text>
            <span style={{ fg: theme.primary }}>→</span> <span style={{ fg: theme.primary, bold: true }}>human</span>
          </text>
          <code
            filetype="markdown"
            drawUnstyledText={false}
            streaming={true}
            syntaxStyle={syntax()}
            content={displayText()}
            conceal={ctx.conceal()}
            fg={theme.text}
          />
        </box>
      </Show>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const { theme } = useTheme()
  const { showDetails } = use()
  const sync = useSync()
  const [margin, setMargin] = createSignal(0)

  // Helper to get the part's index in the store (for reactive access)
  const partIndex = createMemo(() => {
    const parts = sync.data.part[props.message.id]
    if (!parts) return -1
    return parts.findIndex((p) => p.id === props.part.id)
  })

  // Access part reactively for non-state properties (tool name, callID, etc.)
  const reactivePart = createMemo(() => {
    const idx = partIndex()
    if (idx < 0) return props.part
    const part = sync.data.part[props.message.id]?.[idx]
    if (part && part.type === "tool") return part
    return props.part
  })

  // Access part state directly from store to ensure state changes trigger re-renders
  // This is separate from reactivePart because SolidJS memo dependencies are based on
  // property access - we need to directly access state properties through the store path
  const partState = createMemo(() => {
    const idx = partIndex()
    if (idx < 0) return props.part.state
    const part = sync.data.part[props.message.id]?.[idx]
    if (part && part.type === "tool") return part.state
    return props.part.state
  })

  // Access part state reactively - separate memo to ensure state changes trigger re-renders
  const metadata = createMemo(() => {
    const state = partState()
    return state.status === "pending" ? {} : (state.metadata ?? {})
  })

  const component = createMemo(() => {
    const part = reactivePart()
    const state = partState() // Use reactive state directly from store
    if (part.tool === "send_agent_message") {
      const ok = state.status === "completed" && (state.metadata as any)?.ok === true
      if (ok) return undefined
    }

    // Hide tool if showDetails is false and tool completed successfully
    // But always show if there's an error or permission is required
    // wait_agent_message is rendered like a wait indicator and should remain visible
    const shouldHide =
      !showDetails() &&
      part.tool !== "wait_agent_message" &&
      state.status === "completed" &&
      !sync.data.permission[props.message.sessionID]?.some((x) => x.callID === part.callID)

    if (shouldHide) {
      return undefined
    }

    const render = ToolRegistry.render(part.tool) ?? GenericTool

    const input = state.input ?? {}
    const container = ToolRegistry.container(part.tool)
    const permissions = sync.data.permission[props.message.sessionID] ?? []
    const permissionIndex = permissions.findIndex((x) => x.callID === part.callID)
    const permission = permissions[permissionIndex]

    const style: BoxProps =
      container === "block" || permission
        ? {
            border: permissionIndex === 0 ? (["left", "right"] as const) : (["left"] as const),
            paddingTop: 1,
            paddingBottom: 1,
            paddingLeft: 2,
            marginTop: 1,
            gap: 1,
            backgroundColor: theme.backgroundPanel,
            customBorderChars: SplitBorder.customBorderChars,
            borderColor: permissionIndex === 0 ? theme.warning : theme.background,
          }
        : {
            paddingLeft: 3,
          }

    return (
      <box
        marginTop={margin()}
        {...style}
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
        <Dynamic
          component={render}
          input={input}
          tool={part.tool}
          metadata={metadata()}
          permission={permission?.metadata ?? {}}
          output={state.status === "completed" ? state.output : undefined}
        />
        {state.status === "error" && (
          <box paddingLeft={2}>
            <text fg={theme.error}>{state.error?.replace("Error: ", "") ?? "Unknown error"}</text>
          </box>
        )}
        {permission && (
          <box gap={1}>
            <text fg={theme.text}>Permission required to run this tool:</text>
            <box flexDirection="row" gap={2}>
              <text fg={theme.text}>
                <b>enter</b>
                <span style={{ fg: theme.textMuted }}> accept</span>
              </text>
              <text fg={theme.text}>
                <b>a</b>
                <span style={{ fg: theme.textMuted }}> accept always</span>
              </text>
              <text fg={theme.text}>
                <b>d</b>
                <span style={{ fg: theme.textMuted }}> deny</span>
              </text>
            </box>
          </box>
        )}
      </box>
    )
  })

  return (
    <>
      <Show when={component()}>{component()}</Show>
    </>
  )
}

type ToolProps<T extends Tool.Info> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  permission: Record<string, any>
  tool: string
  output?: string
}
function GenericTool(props: ToolProps<any>) {
  return (
    <ToolTitle icon="⚙" fallback="Writing command..." when={true}>
      {props.tool} {input(props.input)}
    </ToolTitle>
  )
}

type ToolRegistration<T extends Tool.Info = any> = {
  name: string
  container: "inline" | "block"
  render?: Component<ToolProps<T>>
}
const ToolRegistry = (() => {
  const state: Record<string, ToolRegistration> = {}
  function register<T extends Tool.Info>(input: ToolRegistration<T>) {
    state[input.name] = input
    return input
  }
  return {
    register,
    container(name: string) {
      return state[name]?.container
    },
    render(name: string) {
      return state[name]?.render
    },
  }
})()

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

ToolRegistry.register<typeof BashTool>({
  name: "bash",
  container: "block",
  render(props) {
    const output = createMemo(() => stripAnsi(props.metadata.output?.trim() ?? ""))
    const { theme } = useTheme()
    return (
      <>
        <ToolTitle icon="#" fallback="Writing command..." when={props.input.command}>
          {props.input.description || "Shell"}
        </ToolTitle>
        <Show when={props.input.command}>
          <text fg={theme.text}>$ {props.input.command}</text>
        </Show>
        <Show when={output()}>
          <box>
            <text fg={theme.text}>{output()}</text>
          </box>
        </Show>
      </>
    )
  },
})

ToolRegistry.register<typeof ReadTool>({
  name: "read",
  container: "inline",
  render(props) {
    return (
      <>
        <ToolTitle icon="→" fallback="Reading file..." when={props.input.filePath}>
          Read {normalizePath(props.input.filePath!)} {input(props.input, ["filePath"])}
        </ToolTitle>
      </>
    )
  },
})

ToolRegistry.register<typeof WriteTool>({
  name: "write",
  container: "block",
  render(props) {
    const { theme, syntax } = useTheme()
    const code = createMemo(() => {
      if (!props.input.content) return ""
      return props.input.content
    })

    const diagnostics = createMemo(() => {
      const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
      return props.metadata.diagnostics?.[filePath] ?? []
    })

    const done = !!props.input.filePath

    return (
      <>
        <ToolTitle icon="←" fallback="Preparing write..." when={done}>
          Wrote {props.input.filePath}
        </ToolTitle>
        <Show when={done}>
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(props.input.filePath!)}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
        </Show>
        <Show when={diagnostics().length}>
          <For each={diagnostics()}>
            {(diagnostic) => (
              <text fg={theme.error}>
                Error [{diagnostic.range.start.line}:{diagnostic.range.start.character}]: {diagnostic.message}
              </text>
            )}
          </For>
        </Show>
      </>
    )
  },
})

ToolRegistry.register<typeof GlobTool>({
  name: "glob",
  container: "inline",
  render(props) {
    return (
      <>
        <ToolTitle icon="✱" fallback="Finding files..." when={props.input.pattern}>
          Glob "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
          <Show when={props.metadata.count}>({props.metadata.count} matches)</Show>
        </ToolTitle>
      </>
    )
  },
})

ToolRegistry.register<typeof GrepTool>({
  name: "grep",
  container: "inline",
  render(props) {
    return (
      <ToolTitle icon="✱" fallback="Searching content..." when={props.input.pattern}>
        Grep "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
        <Show when={props.metadata.matches}>({props.metadata.matches} matches)</Show>
      </ToolTitle>
    )
  },
})

ToolRegistry.register<typeof ListTool>({
  name: "list",
  container: "inline",
  render(props) {
    const dir = createMemo(() => {
      if (props.input.path) {
        return normalizePath(props.input.path)
      }
      return ""
    })
    return (
      <>
        <ToolTitle icon="→" fallback="Listing directory..." when={props.input.path !== undefined}>
          List {dir()}
        </ToolTitle>
      </>
    )
  },
})

ToolRegistry.register<typeof WebFetchTool>({
  name: "webfetch",
  container: "inline",
  render(props) {
    return (
      <ToolTitle icon="%" fallback="Fetching from the web..." when={(props.input as any).url}>
        WebFetch {(props.input as any).url}
      </ToolTitle>
    )
  },
})

ToolRegistry.register({
  name: "codesearch",
  container: "inline",
  render(props: ToolProps<any>) {
    const input = props.input as any
    const metadata = props.metadata as any
    return (
      <ToolTitle icon="◇" fallback="Searching code..." when={input.query}>
        Exa Code Search "{input.query}" <Show when={metadata.results}>({metadata.results} results)</Show>
      </ToolTitle>
    )
  },
})

ToolRegistry.register({
  name: "websearch",
  container: "inline",
  render(props: ToolProps<any>) {
    const input = props.input as any
    const metadata = props.metadata as any
    return (
      <ToolTitle icon="◈" fallback="Searching web..." when={input.query}>
        Exa Web Search "{input.query}" <Show when={metadata.numResults}>({metadata.numResults} results)</Show>
      </ToolTitle>
    )
  },
})

ToolRegistry.register<typeof EditTool>({
  name: "edit",
  container: "block",
  render(props) {
    const ctx = use()
    const { theme, syntax } = useTheme()

    const view = createMemo(() => {
      const diffStyle = ctx.sync.data.config.tui?.diff_style
      if (diffStyle === "stacked") return "unified"
      // Default to "auto" behavior
      return ctx.width > 120 ? "split" : "unified"
    })

    const ft = createMemo(() => filetype(props.input.filePath))

    const diffContent = createMemo(() => props.metadata.diff ?? props.permission["diff"])

    const diagnostics = createMemo(() => {
      const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
      const arr = props.metadata.diagnostics?.[filePath] ?? []
      return arr.filter((x) => x.severity === 1).slice(0, 3)
    })

    return (
      <>
        <ToolTitle icon="←" fallback="Preparing edit..." when={props.input.filePath}>
          Edit {normalizePath(props.input.filePath!)}{" "}
          {input({
            replaceAll: props.input.replaceAll,
          })}
        </ToolTitle>
        <Show when={diffContent()}>
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
        </Show>
        <Show when={diagnostics().length}>
          <box>
            <For each={diagnostics()}>
              {(diagnostic) => (
                <text fg={theme.error}>
                  Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
                </text>
              )}
            </For>
          </box>
        </Show>
      </>
    )
  },
})

ToolRegistry.register<typeof PatchTool>({
  name: "patch",
  container: "block",
  render(props) {
    const { theme } = useTheme()
    return (
      <>
        <ToolTitle icon="%" fallback="Preparing patch..." when={true}>
          Patch
        </ToolTitle>
        <Show when={props.output}>
          <box>
            <text fg={theme.text}>{props.output?.trim()}</text>
          </box>
        </Show>
      </>
    )
  },
})

ToolRegistry.register<typeof TodoWriteTool>({
  name: "todowrite",
  container: "block",
  render(props) {
    const { theme } = useTheme()
    return (
      <>
        <Show when={!props.input.todos?.length}>
          <ToolTitle icon="⚙" fallback="Updating todos..." when={true}>
            Updating todos...
          </ToolTitle>
        </Show>
        <Show when={props.metadata.todos?.length}>
          <box>
            <For each={props.input.todos ?? []}>
              {(todo) => <TodoItem status={todo.status} content={todo.content} />}
            </For>
          </box>
        </Show>
      </>
    )
  },
})

// Subagent spawn tool - shows spawned subagent sessions
// Uses block container for consistent left-border panel style
ToolRegistry.register({
  name: "subagent_spawn",
  container: "block",
  render(props: ToolProps<any>) {
    const { theme } = useTheme()
    const sync = useSync()
    const dialog = useDialog()
    const metadata = () =>
      props.metadata as
        | {
            spawned?: Array<{ session_id: string; agent: string }>
            errors?: string[]
          }
        | undefined
    const input = props.input as { agents?: Array<{ agent: string; prompt: string }> } | undefined

    const spawned = createMemo(() => metadata()?.spawned ?? [])
    const count = createMemo(() => spawned().length || input?.agents?.length || 0)

    return (
      <box>
        {/* Header */}
        <text fg={theme.secondary}>
          <b>
            🔀 Spawned {count()} subagent{count() > 1 ? "s" : ""}
          </b>
        </text>

        {/* Loading state - before spawn completes */}
        <Show when={!spawned().length && input?.agents?.length}>
          <For each={input!.agents}>
            {(agent) => (
              <box marginTop={1}>
                <text fg={theme.textMuted}>
                  <span style={{ fg: theme.warning }}>◐</span> <b>{agent.agent}</b> spawning...
                </text>
              </box>
            )}
          </For>
        </Show>

        {/* Spawned subagent rows */}
        <For each={spawned()}>
          {(item) => (
            <SubagentRow
              sessionID={item.session_id}
              agent={item.agent}
              onSelect={() => dialog.replace(() => <DialogSubagent sessionID={item.session_id} />)}
            />
          )}
        </For>

        {/* Errors */}
        <Show when={metadata()?.errors?.length}>
          <For each={metadata()?.errors ?? []}>{(error) => <text fg={theme.error}>✗ {error}</text>}</For>
        </Show>
      </box>
    )
  },
})

ToolRegistry.register({
  name: "wait_agent_message",
  container: "inline",
  render(props: ToolProps<any>) {
    const { theme } = useTheme()
    const sync = useSync()

    const meta = createMemo(() => props.metadata as any)
    const input = createMemo(() => props.input as any)

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
    const respondedSources = createMemo(() => (meta()?.respondedSources as string[] | undefined) ?? [])

    const createdAt = createMemo(() => meta()?.createdAt as number | undefined)
    const deadline = createMemo(() => meta()?.deadline as number | undefined)

    const [now, setNow] = createSignal(Date.now())
    createEffect(() => {
      if (status() !== "waiting") return
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

    const sourceNames = createMemo(() => sources().map(getAgentName))
    const respondedNames = createMemo(() => respondedSources().map(getAgentName))

    const failedSources = createMemo(() => {
      const responded = new Set(respondedSources())
      return sources()
        .filter((s) => !responded.has(s))
        .map(getAgentName)
    })

    const statusColor = createMemo(() => {
      if (status() === "waiting") return theme.warning
      if (status() === "resolved") return theme.success
      return theme.error
    })

    if (status() === "blocked") {
      return (
        <box marginTop={1} paddingLeft={6}>
          <text fg={statusColor()}>⛔ wait_agent_message blocked</text>
        </box>
      )
    }

    // Resolved (all mode): hide entirely - responses speak for themselves
    if (status() === "resolved" && mode() === "all") {
      return null
    }

    // Resolved (any mode): show who responded, who was abandoned
    if (status() === "resolved" && mode() === "any") {
      return (
        <box marginTop={1} paddingLeft={6}>
          <text fg={statusColor()}>
            ✓ {respondedNames().join(", ")}
            {failedSources().length > 0 && (
              <span style={{ fg: theme.textMuted }}> · ○ {failedSources().join(", ")}</span>
            )}
          </text>
        </box>
      )
    }

    // Timed out: show who failed
    if (status() === "timedOut") {
      const timedOutNames = failedSources().length > 0 ? failedSources() : sourceNames()
      return (
        <box marginTop={1} paddingLeft={6}>
          <text fg={statusColor()}>
            ⏱ {timedOutNames.join(", ")} timed out
            {respondedNames().length > 0 && (
              <span style={{ fg: theme.success }}> · ✓ {respondedNames().join(", ")}</span>
            )}
          </text>
        </box>
      )
    }

    // Waiting: show progress and remaining time
    return (
      <box marginTop={1} paddingLeft={6}>
        <text fg={statusColor()}>
          ⏳{" "}
          <Show
            when={respondedNames().length > 0}
            fallback={<span style={{ fg: theme.textMuted }}>{sourceNames().join(", ")}</span>}
          >
            <span style={{ fg: theme.success }}>✓ {respondedNames().join(", ")}</span>
            {failedSources().length > 0 && (
              <span style={{ fg: theme.textMuted }}> · ○ {failedSources().join(", ")}</span>
            )}
          </Show>
          <span style={{ fg: theme.textMuted }}>
            {" "}
            ({mode()}, {Math.round((timeout() ?? 0) / 1000)}s)
            {elapsed() !== undefined && <span> · {fmt(elapsed())} elapsed</span>}
            {remaining() !== undefined && <span> · {fmt(remaining())} left</span>}
          </span>
        </text>
      </box>
    )
  },
})

// Subagent row - simple text-based display within the panel
function SubagentRow(props: { sessionID: string; agent: string; onSelect: () => void }) {
  const { theme } = useTheme()
  const sync = useSync()

  onMount(() => {
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

  // Get the initial task
  const initialTask = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    const firstUser = messages.find((m) => m.role === "user")
    if (!firstUser) return undefined
    const parts = sync.data.part[firstUser.id] ?? []
    const msgPart = parts.find((p) => (p as any).type === "message" && (p as any).direction === "incoming") as any
    if (msgPart?.text) {
      const text = msgPart.text.trim()
      return text.length > 60 ? text.slice(0, 60) + "..." : text
    }
    const textPart = parts.find((p) => p.type === "text" && "synthetic" in p && p.synthetic)
    if (textPart && textPart.type === "text") {
      const text = (() => {
        const raw = textPart.text.trim()

        if (raw.startsWith("OPENCODE_INBOX")) {
          const lines = raw.split("\n")
          if (lines.length <= 2) return raw
          return lines.slice(2).join("\n").replace(/^  /gm, "").trim()
        }

        if (raw.startsWith("OPENCODE_INBOUND")) {
          return raw.replace(/^OPENCODE_INBOUND[^\n]*\n?/, "").trim()
        }

        return raw
      })()
      return text.length > 60 ? text.slice(0, 60) + "..." : text
    }
    return undefined
  })

  // Get the last response
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
        return text.length > 60 ? text.slice(0, 60) + "..." : text
      }
      const textPart = parts.find((p) => p.type === "text" && !("synthetic" in p && p.synthetic))
      if (textPart && textPart.type === "text") {
        const text = textPart.text.trim()
        return text.length > 60 ? text.slice(0, 60) + "..." : text
      }
    }
    return undefined
  })

  return (
    <box marginTop={1} onMouseUp={props.onSelect}>
      {/* Status + Agent name */}
      <text>
        <Show when={isWorking()} fallback={<span style={{ fg: theme.success }}>✓</span>}>
          <span style={{ fg: theme.warning }}>◐</span>
        </Show>{" "}
        <span style={{ fg: theme.secondary, bold: true }}>{props.agent}</span>
        <span style={{ fg: theme.textMuted }}>#{shortId}</span>
        <span style={{ fg: theme.textMuted }}> [{status()}]</span>
      </text>
      {/* Task preview */}
      <Show when={initialTask()}>
        <text fg={theme.textMuted}> → {initialTask()}</text>
      </Show>
      {/* Response preview */}
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
