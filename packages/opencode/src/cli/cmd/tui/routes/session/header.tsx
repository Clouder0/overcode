import { type Accessor, createMemo, Match, Show, Switch } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { pipe, sumBy } from "remeda"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useKeybind } from "../../context/keybind"
import { useTerminalDimensions } from "@opentui/solid"
import { buildSessionTree, sessionRunState } from "../../lib/session-tree"

const Title = (props: { title: Accessor<string>; truncate?: boolean }) => {
  const { theme } = useTheme()
  return (
    <text fg={theme.text} wrapMode={props.truncate ? "none" : undefined} flexShrink={props.truncate ? 1 : 0}>
      <span style={{ bold: true }}>#</span> <span style={{ bold: true }}>{props.title()}</span>
    </text>
  )
}

const ContextInfo = (props: { context: Accessor<string | undefined>; cost: Accessor<string> }) => {
  const { theme } = useTheme()
  return (
    <Show when={props.context()}>
      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
        {props.context()} ({props.cost()})
      </text>
    </Show>
  )
}

export function Header() {
  const route = useRouteData("session")
  const sync = useSync()
  const session = createMemo(() => sync.session.get(route.sessionID)!)
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])

  const cost = createMemo(() => {
    const total = pipe(
      messages(),
      sumBy((x) => (x.role === "assistant" ? x.cost : 0)),
    )
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    let result = total.toLocaleString()
    if (model?.limit.context) {
      result += "  " + Math.round((total / model.limit.context) * 100) + "%"
    }
    return result
  })

  const { theme } = useTheme()
  const keybind = useKeybind()

  const dimensions = useTerminalDimensions()
  const tall = createMemo(() => dimensions().height > 40)

  const displayTitle = createMemo(() => {
    const current = session()
    if (!current) return ""
    return current.title
  })

  const tree = createMemo(() =>
    buildSessionTree({
      currentSessionID: route.sessionID,
      sessions: sync.data.session,
      sort: "created",
    }),
  )

  // Count child/subagent sessions for the current session (including nested)
  const childCount = createMemo(() => Math.max(0, tree().list.length - 1))

  // Count how many children are currently active (working/waiting)
  const workingChildCount = createMemo(() => {
    const t = tree()
    return t.list.filter((item) => {
      if (item.id === t.rootID) return false
      const status = sync.data.session_status?.[item.id] as { type?: string } | undefined
      return sessionRunState(status) !== "done"
    }).length
  })

  return (
    <box flexShrink={0}>
      <box
        paddingTop={tall() ? 1 : 0}
        paddingBottom={tall() ? 1 : 0}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <Switch>
          <Match when={session()?.parentID}>
            <box flexDirection="row" gap={2}>
              <Title title={displayTitle} truncate={!tall()} />
              <text fg={theme.textMuted}>
                <b>Subagent session</b>
              </text>
              <text fg={theme.text}>
                Parent <span style={{ fg: theme.textMuted }}>{keybind.print("session_parent")}</span>
              </text>
              <text fg={theme.text}>
                Prev <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle_reverse")}</span>
              </text>
              <text fg={theme.text}>
                Next <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle")}</span>
              </text>
              <text fg={theme.text}>
                List <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_list")}</span>
              </text>
              <box flexGrow={1} flexShrink={1} />
              <ContextInfo context={context} cost={cost} />
            </box>
          </Match>
          <Match when={true}>
            <box flexDirection="row" justifyContent="space-between" gap={1}>
              <box flexDirection="row" gap={2}>
                <Title title={displayTitle} truncate={!tall()} />
                <Show when={childCount() > 0}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: workingChildCount() > 0 ? theme.warning : theme.success }}>
                      {workingChildCount() > 0 ? "◐" : "●"}
                    </span>{" "}
                    {childCount()} subagent{childCount() > 1 ? "s" : ""}
                    <Show when={workingChildCount() > 0}>
                      <span style={{ fg: theme.warning }}> ({workingChildCount()} working)</span>
                    </Show>{" "}
                    <span style={{ fg: theme.border }}>{keybind.print("session_child_list")}</span>
                  </text>
                </Show>
              </box>
              <ContextInfo context={context} cost={cost} />
            </box>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
