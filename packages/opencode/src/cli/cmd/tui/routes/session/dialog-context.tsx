import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { createMemo, createResource, onMount, Show } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import type { SessionContext } from "@opencode-ai/sdk/v2"

export function DialogContext(props: { sessionID: string }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()

  onMount(() => {
    dialog.setSize("large")
  })

  const [ctx] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      const res = await sdk.client.session.context({ sessionID })
      return res.data as SessionContext
    },
  )

  const height = createMemo(() => {
    // The dialog is already vertically centered; keep body scrollable.
    return Math.max(8, Math.min(24, dimensions().height - 14))
  })

  const cpd = createMemo(() => ctx()?.cpd)
  const actions = createMemo(() => ctx()?.actions)
  const estimate = createMemo(() => ctx()?.estimate)

  const formatAt = (at: number | null | undefined) => {
    if (!at) return "-"
    return new Date(at).toLocaleString()
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Context
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <Show
        when={ctx.error}
        fallback={
          <Show when={ctx()} fallback={<text fg={theme.textMuted}>Loading...</text>}>
            {(value) => (
              <>
                <box flexDirection="row" gap={1}>
                  <text fg={theme.textMuted}>Flags:</text>
                  <text fg={value().flags.cpd ? theme.info : theme.textMuted}>CPD</text>
                  <text fg={value().flags.trim ? theme.warning : theme.textMuted}>TRIM</text>
                  <text fg={value().flags.think ? theme.warning : theme.textMuted}>THINK</text>
                  <text fg={value().flags.rctx ? theme.error : theme.textMuted}>RCTX</text>
                </box>

                <Show when={estimate()}>
                  {(estValue) => (
                    <box flexDirection="row" gap={2}>
                      <text fg={theme.textMuted}>
                        Target: <span style={{ fg: theme.text }}>{estValue().target ?? "-"}</span>
                      </text>
                      <text fg={theme.textMuted}>
                        Tokens: <span style={{ fg: theme.text }}>{estValue().total}</span>
                        <span style={{ fg: theme.textMuted }}>
                          {" "}
                          (system {estValue().system}, messages {estValue().messages})
                        </span>
                      </text>
                      <Show when={estValue().budget !== null && estValue().budget !== undefined}>
                        <text fg={theme.textMuted}>
                          Budget: <span style={{ fg: theme.text }}>{estValue().budget}</span>
                        </text>
                      </Show>
                    </box>
                  )}
                </Show>

                <Show when={actions()}>
                  {(actionsValue) => (
                    <box flexDirection="row" gap={2}>
                      <text fg={theme.textMuted}>
                        TRIM: <span style={{ fg: theme.text }}>{actionsValue().trim.count}</span>
                        <span style={{ fg: theme.textMuted }}> (~{actionsValue().trim.tokens} tokens)</span>
                        <span style={{ fg: theme.textMuted }}> at {formatAt(actionsValue().trim.at)}</span>
                      </text>
                      <text fg={theme.textMuted}>
                        THINK: <span style={{ fg: theme.text }}>{actionsValue().think.count}</span>
                        <span style={{ fg: theme.textMuted }}> (~{actionsValue().think.tokens} tokens)</span>
                        <span style={{ fg: theme.textMuted }}> at {formatAt(actionsValue().think.at)}</span>
                      </text>
                      <text fg={theme.textMuted}>
                        RCTX: <span style={{ fg: theme.text }}>{formatAt(actionsValue().rctx.at)}</span>
                      </text>
                    </box>
                  )}
                </Show>

                <Show when={cpd()} fallback={<text fg={theme.textMuted}>No CPD stored for this session.</text>}>
                  {(cpdValue) => (
                    <>
                      <box flexDirection="row" gap={2}>
                        <text fg={theme.textMuted}>
                          Updated:{" "}
                          <span style={{ fg: theme.text }}>{new Date(cpdValue().updated).toLocaleString()}</span>
                        </text>
                        <text fg={theme.textMuted}>
                          Upto: <span style={{ fg: theme.text }}>{cpdValue().upto}</span>
                        </text>
                        <Show when={cpdValue().size !== undefined}>
                          <text fg={theme.textMuted}>
                            Size: <span style={{ fg: theme.text }}>{cpdValue().size}</span>
                          </text>
                        </Show>
                      </box>

                      <box border={true} borderColor={theme.border} backgroundColor={theme.backgroundPanel}>
                        <scrollbox
                          height={height()}
                          backgroundColor={theme.backgroundPanel}
                          paddingLeft={1}
                          paddingRight={1}
                          paddingTop={1}
                          paddingBottom={1}
                          verticalScrollbarOptions={{
                            paddingLeft: 1,
                            visible: true,
                            trackOptions: {
                              backgroundColor: theme.backgroundElement,
                              foregroundColor: theme.border,
                            },
                          }}
                        >
                          <text fg={theme.text} wrapMode="word">
                            {cpdValue().text}
                          </text>
                        </scrollbox>
                      </box>
                    </>
                  )}
                </Show>
              </>
            )}
          </Show>
        }
      >
        <text fg={theme.error}>Failed to load context.</text>
      </Show>
    </box>
  )
}
