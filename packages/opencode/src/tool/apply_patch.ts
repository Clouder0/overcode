import z from "zod"
import * as path from "path"
import * as fs from "fs/promises"
import { Tool } from "./tool"
import { FileTime } from "../file/time"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectory } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "../lsp"
import { Filesystem } from "../util/filesystem"

const PatchParams = z.object({
  patchText: z.string().describe("The full patch text that describes all changes to be made"),
})

export const ApplyPatchTool = Tool.define("apply_patch", {
  description: "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
  parameters: PatchParams,
  async execute(params, ctx) {
    if (!params.patchText) {
      throw new Error("patchText is required")
    }

    // Parse the patch to get hunks
    let hunks: Patch.Hunk[]
    try {
      const parseResult = Patch.parsePatch(params.patchText)
      hunks = parseResult.hunks
    } catch (error) {
      throw new Error(`apply_patch verification failed: ${error}`)
    }

    if (hunks.length === 0) {
      const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
      if (normalized === "*** Begin Patch\n*** End Patch") {
        throw new Error("patch rejected: empty patch")
      }
      throw new Error("apply_patch verification failed: no hunks found")
    }

    // Validate file paths and check permissions
    const fileChanges: Array<{
      filePath: string
      oldContent: string
      newContent: string
      type: "add" | "update" | "delete" | "move"
      movePath?: string
      diff: string
      additions: number
      deletions: number
    }> = []

    let totalDiff = ""

    for (const hunk of hunks) {
      const filePath = path.resolve(Instance.directory, hunk.path)
      await assertExternalDirectory(ctx, filePath)

      switch (hunk.type) {
        case "add": {
          const oldContent = ""
          const newContent =
            hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
          const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

          let additions = 0
          let deletions = 0
          for (const change of diffLines(oldContent, newContent)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }

          fileChanges.push({
            filePath,
            oldContent,
            newContent,
            type: "add",
            diff,
            additions,
            deletions,
          })

          totalDiff += diff + "\n"
          break
        }

        case "update": {
          // Check if file exists for update
          const stats = await fs.stat(filePath).catch(() => null)
          if (!stats || stats.isDirectory()) {
            throw new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`)
          }

          // Read file and assert it hasn't changed since last read
          await FileTime.assert(ctx.sessionID, filePath)
          const oldContent = await fs.readFile(filePath, "utf-8")
          let newContent = oldContent

          // Apply the update chunks to get new content
          try {
            const fileUpdate = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks)
            newContent = fileUpdate.content
          } catch (error) {
            throw new Error(`apply_patch verification failed: ${error}`)
          }

          const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

          let additions = 0
          let deletions = 0
          for (const change of diffLines(oldContent, newContent)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }

          const movePath = hunk.move_path ? path.resolve(Instance.directory, hunk.move_path) : undefined
          await assertExternalDirectory(ctx, movePath)

          fileChanges.push({
            filePath,
            oldContent,
            newContent,
            type: hunk.move_path ? "move" : "update",
            movePath,
            diff,
            additions,
            deletions,
          })

          totalDiff += diff + "\n"
          break
        }

        case "delete": {
          await FileTime.assert(ctx.sessionID, filePath)
          const contentToDelete = await fs.readFile(filePath, "utf-8").catch((error) => {
            throw new Error(`apply_patch verification failed: ${error}`)
          })
          const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

          const deletions = contentToDelete.split("\n").length

          fileChanges.push({
            filePath,
            oldContent: contentToDelete,
            newContent: "",
            type: "delete",
            diff: deleteDiff,
            additions: 0,
            deletions,
          })

          totalDiff += deleteDiff + "\n"
          break
        }
      }
    }

    // Check permissions if needed
    await ctx.ask({
      permission: "edit",
      patterns: fileChanges.map((c) => path.relative(Instance.worktree, c.filePath)),
      always: ["*"],
      metadata: {
        diff: totalDiff,
      },
    })

    // Apply the changes
    const changedFiles: string[] = []

    const locked = fileChanges.flatMap((change) => {
      if (change.type === "move" && change.movePath) {
        return [change.filePath, change.movePath]
      }
      return [change.filePath]
    })

    await FileTime.withLocks(locked, async () => {
      for (const change of fileChanges) {
        if (change.type === "update" || change.type === "delete") {
          await FileTime.assert(ctx.sessionID, change.filePath)
        }

        if (change.type === "add") {
          // Create parent directories (recursive: true is safe on existing/root dirs)
          await fs.mkdir(path.dirname(change.filePath), { recursive: true })
          await fs.writeFile(change.filePath, change.newContent, "utf-8")
          changedFiles.push(change.filePath)
        }

        if (change.type === "update") {
          await fs.writeFile(change.filePath, change.newContent, "utf-8")
          changedFiles.push(change.filePath)
        }

        if (change.type === "move" && change.movePath) {
          // Create parent directories (recursive: true is safe on existing/root dirs)
          await fs.mkdir(path.dirname(change.movePath), { recursive: true })
          await fs.writeFile(change.movePath, change.newContent, "utf-8")
          await fs.unlink(change.filePath)
          changedFiles.push(change.movePath)
        }

        if (change.type === "delete") {
          await fs.unlink(change.filePath)
          changedFiles.push(change.filePath)
        }

        // Update file time tracking
        if (change.type === "add") {
          const file = Bun.file(change.filePath)
          const stats = await file.stat()
          FileTime.read(ctx.sessionID, change.filePath, FileTime.stamp(stats.mtime, change.newContent))
        }
        if (change.type === "move" && change.movePath) {
          const file = Bun.file(change.movePath)
          const stats = await file.stat()
          FileTime.read(ctx.sessionID, change.movePath, FileTime.stamp(stats.mtime, change.newContent))
        }
        if (change.type === "update") {
          const file = Bun.file(change.filePath)
          const stats = await file.stat()
          FileTime.read(ctx.sessionID, change.filePath, FileTime.stamp(stats.mtime, change.newContent))
        }
        if (change.type === "delete") {
          FileTime.clear(ctx.sessionID, change.filePath)
        }
      }
    })

    // Publish file change events
    for (const filePath of changedFiles) {
      await Bus.publish(FileWatcher.Event.Updated, { file: filePath, event: "change" })
    }

    // Notify LSP of file changes and collect diagnostics
    for (const change of fileChanges) {
      if (change.type === "delete") continue
      const target = change.movePath ?? change.filePath
      await LSP.touchFile(target, true)
    }
    const diagnostics = await LSP.diagnostics()

    // Generate output summary
    const summaryLines = fileChanges.map((change) => {
      if (change.type === "add") {
        return `A ${path.relative(Instance.worktree, change.filePath)}`
      }
      if (change.type === "delete") {
        return `D ${path.relative(Instance.worktree, change.filePath)}`
      }
      const target = change.movePath ?? change.filePath
      return `M ${path.relative(Instance.worktree, target)}`
    })
    let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

    // Report LSP errors for changed files
    const MAX_DIAGNOSTICS_PER_FILE = 20
    for (const change of fileChanges) {
      if (change.type === "delete") continue
      const target = change.movePath ?? change.filePath
      const normalized = Filesystem.normalizePath(target)
      const issues = diagnostics[normalized] ?? []
      const errors = issues.filter((item) => item.severity === 1)
      if (errors.length > 0) {
        const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
        const suffix =
          errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
        output += `\n\nLSP errors detected in ${path.relative(Instance.worktree, target)}, please fix:\n<diagnostics file="${target}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
      }
    }

    // Build per-file metadata for UI rendering
    const files = fileChanges.map((change) => ({
      filePath: change.filePath,
      relativePath: path.relative(Instance.worktree, change.movePath ?? change.filePath),
      type: change.type,
      diff: change.diff,
      before: change.oldContent,
      after: change.newContent,
      additions: change.additions,
      deletions: change.deletions,
      movePath: change.movePath,
    }))

    return {
      title: output,
      metadata: {
        diff: totalDiff,
        files,
        diagnostics,
      },
      output,
    }
  },
})
