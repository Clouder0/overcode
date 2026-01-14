import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { trimDiff } from "./edit"
import { assertExternalDirectory } from "./external-directory"

const MAX_DIAGNOSTICS_PER_FILE = 20
const MAX_PROJECT_DIAGNOSTICS_FILES = 5

type Diagnostic = Parameters<typeof LSP.Diagnostic.pretty>[0]

function selectDiagnostics(issues: Diagnostic[], limit: number) {
  const errors = issues.filter((item) => (item.severity ?? 1) === 1)
  const warnings = issues.filter((item) => item.severity === 2)
  const selected = [...errors, ...warnings].slice(0, limit)
  const remaining = errors.length + warnings.length - selected.length
  return {
    selected,
    remaining,
    hasErrors: errors.length > 0,
  }
}

export const WriteTool = Tool.define("write", {
  description: DESCRIPTION,
  parameters: z.object({
    content: z.string().describe("The content to write to the file"),
    filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
  }),
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    await assertExternalDirectory(ctx, filepath)

    const result = await FileTime.withLock(filepath, async () => {
      const file = Bun.file(filepath)
      const exists = await file.exists()
      const contentOld = exists ? await file.text() : ""
      if (exists) await FileTime.assert(ctx.sessionID, filepath)

      const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
      await ctx.ask({
        permission: "edit",
        patterns: [path.relative(Instance.worktree, filepath)],
        always: ["*"],
        metadata: {
          filepath,
          diff,
        },
      })

      await Bun.write(filepath, params.content)
      await Bus.publish(File.Event.Edited, {
        file: filepath,
      })

      const fileAfter = Bun.file(filepath)
      const statsAfter = await fileAfter.stat()
      const contentAfter = await fileAfter.text()
      FileTime.read(ctx.sessionID, filepath, FileTime.stamp(statsAfter.mtime, contentAfter))

      return {
        exists,
      }
    })

    let output = "Wrote file successfully."
    const savedDiagnostics: Record<string, Diagnostic[]> = {}
    await LSP.touchFile(filepath, true)
    const diagnostics = await LSP.diagnostics()
    const normalizedFilepath = Filesystem.normalizePath(filepath)
    let projectDiagnosticsCount = 0
    for (const [file, issues] of Object.entries(diagnostics)) {
      const selected = selectDiagnostics(issues, MAX_DIAGNOSTICS_PER_FILE)
      if (file === normalizedFilepath) {
        if (selected.selected.length === 0) continue
        savedDiagnostics[file] = selected.selected
        const suffix = selected.remaining > 0 ? `\n... and ${selected.remaining} more` : ""
        output += `\n\nLSP diagnostics detected in this file:\n<diagnostics file="${filepath}">\n${selected.selected.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
        continue
      }

      if (!selected.hasErrors) continue
      if (projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
      projectDiagnosticsCount++
      savedDiagnostics[file] = selected.selected
      const suffix = selected.remaining > 0 ? `\n... and ${selected.remaining} more` : ""
      output += `\n\nLSP errors detected in other files:\n<diagnostics file="${file}">\n${selected.selected.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
    }

    return {
      title: path.relative(Instance.worktree, filepath),
      metadata: {
        diagnostics: savedDiagnostics,
        filepath,
        exists: result.exists,
      },
      output,
    }
  },
})
