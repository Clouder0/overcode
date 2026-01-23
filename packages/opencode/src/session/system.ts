import os from "node:os"
import path from "node:path"
import type { Provider } from "@/provider/provider"
import { Flag } from "@/flag/flag"
import { Config } from "../config/config"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_SPOOF from "./prompt/anthropic_spoof.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_CODEX_INSTRUCTIONS from "./prompt/codex_header.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_SUMMARIZE from "./prompt/summarize.txt"
import PROMPT_TITLE from "./prompt/title.txt"

export namespace SystemPrompt {
  export function header(providerID: string) {
    if (providerID.includes("anthropic")) return [PROMPT_ANTHROPIC_SPOOF.trim()]
    return []
  }

  export function instructions() {
    return PROMPT_CODEX_INSTRUCTIONS.trim()
  }

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  export async function environment() {
    const project = Instance.project
    return [
      [
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<files>`,
        `</files>`,
      ].join("\n"),
    ]
  }

  const LOCAL_RULE_FILES = [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTEXT.md", // deprecated
  ]
  const GLOBAL_RULE_FILES = [path.join(Global.Path.config, "AGENTS.md")]
  if (!Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT) {
    GLOBAL_RULE_FILES.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
  }

  if (Flag.OPENCODE_CONFIG_DIR) {
    GLOBAL_RULE_FILES.push(path.join(Flag.OPENCODE_CONFIG_DIR, "AGENTS.md"))
  }

  export async function custom() {
    const config = await Config.get()
    const paths = new Set<string>()

    for (const localRuleFile of LOCAL_RULE_FILES) {
      const matches = await Filesystem.findUp(localRuleFile, Instance.directory, Instance.worktree)
      if (matches.length > 0) {
        matches.forEach((p) => {
          paths.add(p)
        })
        break
      }
    }

    for (const globalRuleFile of GLOBAL_RULE_FILES) {
      if (await Bun.file(globalRuleFile).exists()) {
        paths.add(globalRuleFile)
        break
      }
    }

    const urls: string[] = []
    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) {
          urls.push(instruction)
          continue
        }
        if (instruction.startsWith("~/")) {
          instruction = path.join(os.homedir(), instruction.slice(2))
        }
        let matches: string[] = []
        if (path.isAbsolute(instruction)) {
          matches = await Array.fromAsync(
            new Bun.Glob(path.basename(instruction)).scan({
              cwd: path.dirname(instruction),
              absolute: true,
              onlyFiles: true,
            }),
          ).catch(() => [])
        } else {
          matches = await Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])
        }
        matches.forEach((p) => {
          paths.add(p)
        })
      }
    }

    const foundFiles = Array.from(paths).map((p) =>
      Bun.file(p)
        .text()
        .catch(() => "")
        .then((x) => `Instructions:\n${x}`),
    )
    const foundUrls = urls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "")
        .then((x) => (x ? `Instructions:\n${x}` : "")),
    )
    return Promise.all([...foundFiles, ...foundUrls]).then((result) => result.filter(Boolean))
  }

  export function compaction(providerID: string) {
    switch (providerID) {
      case "anthropic":
        return [PROMPT_ANTHROPIC_SPOOF.trim(), PROMPT_COMPACTION]
      default:
        return [PROMPT_COMPACTION]
    }
  }

  export function summarize(providerID: string) {
    switch (providerID) {
      case "anthropic":
        return [PROMPT_ANTHROPIC_SPOOF.trim(), PROMPT_SUMMARIZE]
      default:
        return [PROMPT_SUMMARIZE]
    }
  }

  export function title(providerID: string) {
    switch (providerID) {
      case "anthropic":
        return [PROMPT_ANTHROPIC_SPOOF.trim(), PROMPT_TITLE]
      default:
        return [PROMPT_TITLE]
    }
  }

  export function messageProtocol(
    sessionType: "primary" | "subagent",
    sessionID: string,
    parentID?: string,
    subagentPrompt?: string,
  ): string[] {
    const basePrompt = `## Agent Communication

### What You Are

You are an agent in a multi-agent system. Multiple agents can run concurrently, each in its own session with its own context.

### How Your Agent Loop Works

You operate in a loop: you reason, call tools, observe results, and continue. This repeats until you decide your work is complete. When you stop generating, your session becomes idle until something wakes it (like an incoming message).

### How Communication Works

Each agent runs in its own session with its own context. Your text output is displayed to the human only - other agents cannot see it.

Communication is peer-to-peer: any two agents can communicate if they know each other's session IDs.

RECIPIENT-FIRST RULE (applies to ALL assistant text you produce):
Before writing any assistant text that is meant to communicate information (report/update/reply/status/decision), first decide the intended recipient(s):
- If the recipient is the human → write assistant text.
- If the recipient includes any agent session(s) → use send_agent_message(to="ses_...", text="...").
Never assume that writing assistant text will reach another agent.

How to choose the recipient session ID:
- If you are replying to an agent message, use the sender session id shown in the message header.
- If the instruction/task names a session id like ses_..., use that.
- If your context provides relevant session ids (e.g., Parent Session ID in subagent sessions), you may use them when the instruction is addressed to that agent.

Ambiguity handling (do not silently misdeliver):
- If you are told "report back / report your outcome / let me know / update me" but no recipient is specified and no session id is provided, first ask who the recipient is.
  - If you have any known agent session id that might be the intended recipient, ask via send_agent_message requesting the correct target session id(s).
  - Otherwise ask the human in assistant text.

Asynchronous delivery (agents may be slow):
- Sending a message is not the same as receiving a reply. The recipient agent may be busy, waiting on tools, or slow to respond.
- If the recipient is idle, a message usually wakes them. If they are working, your message can be queued until they finish their current step.
- Do not treat a lack of immediate reply as failure. Replies may arrive after you time out.
- Use wait_agent_message to wait with a timeout guard. A timeout is not an error; it is a safety guard that wakes you with the source's status so you can decide what to do next.
- If you time out and still need a reply:
  - If status is working/waiting/retry: wait again (consider a longer timeout).
  - If status is idle: send a follow-up message asking for status or confirming they saw your request.
- Avoid spamming: send one clear request, then wait; only follow up if needed.

Good: send_agent_message(to="ses_abc", text="<message>")  -> correctly sends to agent
Bad: To ses_abc: <message>  -> only shows to human, not to agent

Common failure mode:
- Wrong: "Report: ..." (assistant text) when the intended recipient is an agent session.
- Right: send_agent_message(to="<intended ses_...>", text="Report: ...")
- If unclear: send_agent_message(to="<a known ses_..., usually parent>", text="I have results. Which session id(s) should receive them?")

When you receive a message, it appears as:
\`\`\`
Sender Agent with session id ses_xxx sent a message:
<content>
...
</content>
\`\`\`

To reply, use send_agent_message with the sender's session ID.

### Waiting and the Timeout Guard

wait_agent_message sets a timeout guard for incoming messages. Your session enters a waiting state until either:
- The expected message arrives → you wake with the message in context
- Timeout expires → you wake with a timeout message showing the source's status

This ensures you don't wait indefinitely - you'll wake with the message or with timeout status. Without wait, incoming messages wake you when they arrive, but if no message comes, you remain idle with no way to know.

After calling wait_agent_message, stop generating. Your session is waiting and will resume when the condition is met.

**Wait modes**:
- mode="all": Wait until all sources respond
- mode="any": Wait until any source responds

**seq / since**:
- Some incoming agent messages may show a seq number.
- since is a cursor: the wait counts messages with seq > since.
- since=-1 means session start (counts any earlier messages).
- since=0 means current position: only incoming messages after this wait tool call would count. Usually you will wait on a previous checkpoint (for example, after subagent_spawn or send_agent_message).
- sources=["*"] means any agent; "*" is not a session id.
The major reason for introducing seq/since is to handle spurious messages that arrive while you are working. 
By setting since to the last known checkpoint, you ensure you can consider all messages that arrive after that point into wait condition.

<example>
Good: subagent_spawn(seq=1), agent message comes in(seq=2), wait_agent_message(since=1) → counts the agent message.
Bad: subagent_spawn(seq=1), agent message comes in(seq=2), wait_agent_message(since=0) -> since=0 means current position(seq=3), fails to count the agent message (it arrived before the wait).

Good:
A: send_agent_message(to="ses_B", text="Please analyze the data.") (seq=2)
A: received agent message from ses_B (seq=3)
A: wait_agent_message(sources=["ses_B"], since=2) → counts the message from ses_B.
Bad:
A: send_agent_message(to="ses_B", text="Please analyze the data.") (seq=2)
A: received agent message from ses_B (seq=3)
A: wait_agent_message(sources=["ses_B"], since=0) → since=0 means current position(seq=3), fails to count the message from ses_B.
Bad:
A: send_agent_message(to="ses_B", text="Please analyze the data.") (seq=2)
A: received agent message from ses_B (seq=3)
A: wait_agent_message(sources=["ses_B"], since=3) → since is exclusive, fails to count the earlier message from ses_B.
Bad:
A: send_agent_message(to="ses_B", text="Please analyze the data.") (seq=2)
A: received agent message from ses_B (seq=3)
A: wait_agent_message(sources=["ses_B"], since=1) → too far back, counts the earlier message from ses_B, wait may resolve immediately instead of waiting for new message.

Good:
A: send_agent_message(to="ses_B", text="Please analyze the data and streamingly send to \`ses_A\` to report.") (seq=1)
A: wait_agent_message(sources=["ses_A"], since=1) → counts the streamed messages from ses_A.
A: receives message from B (seq=2), decides to wait more
A: wait_agent_message(sources=["ses_A"], since=2) → counts further streamed messages from ses_A.
Bad:
A: send_agent_message(to="ses_B", text="Please analyze the data and streamingly send to \`ses_A\` to report.") (seq=1)
A: wait_agent_message(sources=["ses_A"], since=1) → counts the streamed messages from ses_A.
A: receives message from B (seq=2), decides to wait more
A: wait_agent_message(sources=["ses_A"], since=1) -> since=1 would be met by the earlier messages from ses_A, fails to count further streamed messages.

Good:
A: spawned with prompt "You are agent A. Your parent session id is ses_p. Your task is to coordinate with agent B. Please wait for parent to send you agent B's session id."
A: wait_agent_message(sources=["ses_p"], since=-1) → counts messages from parent session.
Bad:
A: spawned with prompt "You are agent A. Your parent session id is ses_p. Your task is to coordinate with agent B. Please wait for parent to send you agent B's session id."
A: wait_agent_message(sources=["ses_p"], since=0) → since=0 means current position, fails to count messages from parent session that arrived before the wait.

Good:
A: spawned with prompt "You are agent A. Your parent session id is ses_p. Your task is to coordinate with agent B. Please wait for agent B to handshake with you."
A: wait_agent_message(sources=["*"], since=-1) → don't know agent B's session id yet, so wait on any agent message from session start.
Bad:
A: spawned with prompt "You are agent A. Your parent session id is ses_p. Your task is to coordinate with agent B. Please wait for agent B to handshake with you."
A: wait_agent_message(sources=["*"], since=0) → since=0 means current position, fails to count messages from agent B that arrived before the wait.
</example>

**On timeout**, the message shows source status:
- **working**: Still processing. Wait again if you still need the response.
- **waiting**: Waiting for their own dependencies. Wait again.
- **retry**: Recovering from an error. Wait again.
- **idle**: Session not active. They may have finished without sending, or something went wrong. Send them a message to ask for status.
\`\`\``

    if (sessionType === "primary") {
      return [basePrompt]
    }

    const deliverySection = `
## Subagent Context

You are a subagent. Your task is specified in "Your Task" below.

Session IDs:
- Current Session ID: ${sessionID} (your ID, others use this to message you)
- Parent Session ID: ${parentID} (the session that spawned you)

`

    const taskSection = subagentPrompt
      ? `
## Your Task

${subagentPrompt}

`
      : ""

    return [
      `${deliverySection}
${basePrompt}
${taskSection}`,
    ]
  }
}
