import { describe, expect, test } from "bun:test"
import { SystemPrompt } from "../../src/session/system"

describe("session.system message protocol", () => {
  test("documents seq-first wait policy", () => {
    const protocol = SystemPrompt.messageProtocol("primary", "ses_test").join("\n")

    expect(protocol).toContain("**seq / since (default policy)**")
    expect(protocol).toContain("Default decision order:")
    expect(protocol).toContain("If send_agent_message returns a checkpoint seq")
    expect(protocol).toContain("If subagent_spawn returns a checkpoint seq, use that exact value as since")
    expect(protocol).toContain("Use since=-1 only for intentional backlog catch-up from session start")
    expect(protocol).toContain("A checkpoint seq remains valid for later waits in the same workflow")
    expect(protocol).toContain("Current model-context snapshot can lag newly persisted inbound replies")
    expect(protocol).toContain("not transcript render position")
  })

  test("documents post-send wait decision paths", () => {
    const protocol = SystemPrompt.messageProtocol("primary", "ses_test").join("\n")

    expect(protocol).toContain("Sending does not require immediate waiting.")
    expect(protocol).toContain("If independent work remains, continue now.")
    expect(protocol).toContain("Before ending your turn, run a reply check.")
    expect(protocol).toContain(
      "If no requested follow-up reply still matters, continue or end your turn without waiting.",
    )
  })

  test("documents optional seq in inbox message format", () => {
    const protocol = SystemPrompt.messageProtocol("primary", "ses_test").join("\n")

    expect(protocol).toContain("Sender Agent with session id ses_xxx (seq: 42) sent a message:")
    expect(protocol).toContain('The "(seq: 42)" segment may be absent for some messages.')
  })

  test("documents single-source waits as mode=all", () => {
    const protocol = SystemPrompt.messageProtocol("primary", "ses_test").join("\n")

    expect(protocol).toContain('For a single explicit source (`sources=["ses_..."]`), use mode="all".')
    expect(protocol).toContain(
      'Reserve mode="any" for wildcard waits (`sources=["*"]`) or intentional multi-source race waits where any one reply unblocks you.',
    )
    expect(protocol).toContain('Do not use `sources=["*"]` as a default follow-up to send_agent_message.')
    expect(protocol).toContain('A: wait_agent_message(sources=["ses_B"], since=2) → counts the message from ses_B.')
  })

  test("documents that no-op skill loads satisfy requirement", () => {
    const protocol = SystemPrompt.messageProtocol("primary", "ses_test").join("\n")

    expect(protocol).toContain("If a skill call reports up-to-date/no-op, treat the skill requirement as satisfied")
    expect(protocol).toContain("do not call the same skill again in that response")
  })
})
