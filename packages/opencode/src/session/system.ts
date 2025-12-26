import os from "node:os"
import path from "node:path"
import type { Provider } from "@/provider/provider"
import { Config } from "../config/config"
import { Ripgrep } from "../file/ripgrep"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_SPOOF from "./prompt/anthropic_spoof.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_POLARIS from "./prompt/polaris.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_SUMMARIZE from "./prompt/summarize.txt"
import PROMPT_TITLE from "./prompt/title.txt"

export namespace SystemPrompt {
  export function header(providerID: string) {
    if (providerID.includes("anthropic")) return [PROMPT_ANTHROPIC_SPOOF.trim()]
    return []
  }

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.includes("polaris-alpha")) return [PROMPT_POLARIS]
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
        `  ${
          project.vcs === "git"
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 200,
              })
            : ""
        }`,
        `</files>`,
      ].join("\n"),
    ]
  }

  const LOCAL_RULE_FILES = [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTEXT.md", // deprecated
  ]
  const GLOBAL_RULE_FILES = [
    path.join(Global.Path.config, "AGENTS.md"),
    path.join(os.homedir(), ".claude", "CLAUDE.md"),
  ]

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

    if (config.instructions) {
      for (let instruction of config.instructions) {
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

    const found = Array.from(paths).map((p) =>
      Bun.file(p)
        .text()
        .catch(() => "")
        .then((x) => `Instructions from: ${p}\n${x}`),
    )
    return Promise.all(found).then((result) => result.filter(Boolean))
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
    callerID?: string,
    subagentPrompt?: string,
  ): string[] {
    const basePrompt = `## Agent Communication

Agent sessions communicate by sending and receiving messages.

### History & Communication Rules

Incoming agent messages appear in your conversation history with the format:
\`\`\`
Agent session ses_... sent a message to you:
<content>
...
</content>
\`\`\`

Your outgoing agent messages are recorded as completed "send_agent_message" tool calls in your history.

**Crucial Rules:**
1. **Strict Channel Separation**:
   - **To the Human**: Your generated text output is for the human user's eyes only. Use it to explain your reasoning, provide status updates, or deliver final results to the user.
   - **To other Agents**: All communication between agents **MUST** happen via the "send_agent_message" tool with a concrete destination session id ("ses_...") in the "to" field. Agents are blind to each other's text output.
   - **Replying**: When you receive an agent message that requires a response, you **MUST** use the "send_agent_message" tool targeting the sender's "ses_..." id. Writing a "reply" in your text output will not reach the agent and only clutters the human's view.

### Receiving & Waking

Incoming messages wake your session when:
- You are idle, or
- You are waiting and the message satisfies your wait condition.

### Waiting Mechanism

wait_agent_message suspends your session until messages arrive from specified sources or timeout.

**Modes:**
- \`all\`: Wait until ALL specified sources have sent a message.
- \`any\`: Wait until AT LEAST ONE source has sent a message.

**Wake Priority**: Once waiting, your session ONLY wakes when:
- The wait condition is satisfied (sources respond per mode).
- Timeout occurs.
- Human sends a message (human input always wakes the session).

Messages from agents not in your sources list are queued and will not wake you. After calling wait_agent_message, end your turn immediately.

### Patterns

**Fire-and-Wait**: Delegate a task and wait for the result.
\`\`\`
spawn subagent → wait_agent_message(sources: [subagent], mode: "all") → process result
\`\`\`

**Gather-Reduce**: Spawn multiple agents, wait for all responses, aggregate.
\`\`\`
spawn A, B, C → wait_agent_message(sources: [A, B, C], mode: "all") → combine results
\`\`\`

**Streaming Receive**: React to findings incrementally without explicit waiting.
\`\`\`
spawn explorer → explorer sends findings as discovered → caller wakes on each incoming message → react immediately
\`\`\`

**Free-form Communication**: Agents communicate directly, bypassing the orchestrator.
\`\`\`
orchestrator spawns dev and QA → orchestrator receives their session_ids → orchestrator sends dev a message containing qa_session_id, and sends QA a message containing dev_session_id → dev↔QA communicate directly using those session_ids (bypassing orchestrator) until done
 \`\`\``

    if (sessionType === "primary") {
      return [basePrompt]
    }

    const taskSection = subagentPrompt
      ? `
## Your Task

${subagentPrompt}

`
      : ""

    return [
      `Current Session ID: ${sessionID}
Caller Session ID: ${callerID}
${taskSection}
${basePrompt}`,
    ]
  }
}
