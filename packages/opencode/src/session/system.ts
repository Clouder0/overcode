import { Ripgrep } from "../file/ripgrep"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"

import { Instance } from "../project/instance"
import path from "path"
import os from "os"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_POLARIS from "./prompt/polaris.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_ANTHROPIC_SPOOF from "./prompt/anthropic_spoof.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_SUMMARIZE from "./prompt/summarize.txt"
import PROMPT_TITLE from "./prompt/title.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import type { Provider } from "@/provider/provider"

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
        .then((x) => "Instructions from: " + p + "\n" + x),
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

  export function messageProtocol(sessionType: "primary" | "subagent", callerID?: string): string[] {
    if (sessionType === "primary") {
      return [
        `## Communication Protocol

All responses must use structured message tags:

<message to="TARGET" timeout="TIMEOUT">
Your content here
</message>

### Targets
- to="human": Send to human user
- to="ses_xxx": Send to specific session ID
- to="caller": Send to parent session (subagents only)

### Timeout Values
- timeout="-1": Final response (no wait for reply, normal conversation)
- timeout="0": Send and continue immediately (progress updates, parallel dispatch)
- timeout="N": Wait N milliseconds for response, then continue

### Single-Target Communication
For sending to ONE target and waiting for response, use message timeout:

<message to="ses_explore_001" timeout="60000">
Find the authentication implementation
</message>

The system waits 60 seconds for response from ses_explore_001.

### Multi-Target Parallel Fan-Out
For sending to MULTIPLE targets and collecting responses, use <wait>:

<message to="ses_explore_001" timeout="0">Find auth code</message>
<message to="ses_explore_002" timeout="0">Find database code</message>
<wait sources="ses_explore_001,ses_explore_002" timeout="120000" mode="all"/>

Wait attributes:
- sources: comma-separated session IDs, or "children" for all spawned subagents
- timeout: total milliseconds to wait
- mode: "all" (wait for all) or "any" (wait for first response)

### CRITICAL: Single Wait Rule
- At most ONE <wait> tag per turn
- <wait> MUST be the LAST element - no messages after <wait>
- Violation triggers a malformed response error

### Spawning Subagents
Use subagent_spawn to delegate work:
- subagent_spawn({ agents: [{ agent: "explore", message: "Find auth" }] })
- Returns: { spawned: [{ session_id: "ses_xxx", agent: "explore" }] }

Responses arrive as: [From ses_xxx]: content...

Available agents: explore (codebase search), librarian (docs/examples)`,
      ]
    }
    return [
      `## Subagent Context

You are a subagent session.
Session ID: ${callerID ? "subagent" : "unknown"}
Caller: ${callerID ?? "unknown"}

## Communication Protocol

All responses must use structured message tags:

<message to="TARGET" timeout="TIMEOUT">
Your content here
</message>

### Targets
- to="caller": Send to parent session (default for subagents)
- to="human": Send directly to human (bypass caller)
- to="ses_xxx": Send to specific session ID

### Timeout Values
- timeout="-1": Final response (no wait for reply)
- timeout="0": Progress update, continue working immediately
- timeout="N": Question, wait N milliseconds for answer

### Patterns

Progress update (continue working):
<message to="caller" timeout="0">
Found 50 files, analyzing...
</message>

Question with timeout:
<message to="caller" timeout="30000">
Should I include test files?
</message>

Final response:
<message to="caller" timeout="-1">
Analysis complete: Found authentication in src/auth/...
</message>

Direct to human (bypass caller):
<message to="human" timeout="-1">
This requires confirmation. Proceed? [y/n]
</message>

### CRITICAL: Single Wait Rule
- At most ONE <wait> tag per turn
- <wait> MUST be the LAST element - no messages after <wait>
- Violation triggers a malformed response error

Focus on the task assigned and provide clear, actionable results.`,
    ]
  }
}
