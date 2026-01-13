import z from "zod"
import * as path from "path"
import * as fs from "fs/promises"
import { Tool } from "./tool"
import { FileTime } from "../file/time"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { Patch } from "../patch"
import { createTwoFilesPatch } from "diff"
import { assertExternalDirectory } from "./external-directory"

const PatchParams = z.object({
  patchText: z.string().describe("The full patch text that describes all changes to be made"),
})

export const PatchTool = Tool.define("patch", {
  description:
    "Apply a patch to modify multiple files. Supports adding, updating, and deleting files with context-aware changes.",
  parameters: PatchParams,
  async execute(params, ctx) {
    if (!params.patchText) {
      throw new Error("patchText is required")
    }

    let hunks: Patch.Hunk[]
    try {
      hunks = Patch.parsePatch(params.patchText).hunks
    } catch (error) {
      throw new Error(`Failed to parse patch: ${error}`)
    }

    if (hunks.length === 0) {
      throw new Error("No file changes found in patch")
    }

    const locks = hunks.flatMap((hunk) => {
      const src = path.resolve(Instance.directory, hunk.path)
      if (hunk.type !== "update" || !hunk.move_path) return [src]
      return [src, path.resolve(Instance.directory, hunk.move_path)]
    })

    const result = await FileTime.withLocks(locks, async () => {
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
      }> = []

      let totalDiff = ""

      for (const hunk of hunks) {
        const filePath = path.resolve(Instance.directory, hunk.path)

        await assertExternalDirectory(ctx, filePath)

        switch (hunk.type) {
          case "add": {
            const oldContent = ""
            const newContent = hunk.contents
            const diff = createTwoFilesPatch(filePath, filePath, oldContent, newContent)

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: "add",
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            const stats = await fs.stat(filePath).catch(() => null)
            if (!stats || stats.isDirectory()) {
              throw new Error(`File not found or is directory: ${filePath}`)
            }

            await FileTime.assert(ctx.sessionID, filePath)

            const oldContent = await fs.readFile(filePath, "utf-8")
            let newContent = oldContent

            try {
              newContent = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks).content
            } catch (error) {
              throw new Error(`Failed to apply update to ${filePath}: ${error}`)
            }

            const diff = createTwoFilesPatch(filePath, filePath, oldContent, newContent)

            const movePath = hunk.move_path ? path.resolve(Instance.directory, hunk.move_path) : undefined
            await assertExternalDirectory(ctx, movePath)

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: movePath ? "move" : "update",
              movePath,
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            await FileTime.assert(ctx.sessionID, filePath)

            const oldContent = await fs.readFile(filePath, "utf-8")
            const diff = createTwoFilesPatch(filePath, filePath, oldContent, "")

            fileChanges.push({
              filePath,
              oldContent,
              newContent: "",
              type: "delete",
            })

            totalDiff += diff + "\n"
            break
          }
        }
      }

      const patterns = Array.from(
        new Set(
          fileChanges
            .flatMap((c) => {
              const base = path.relative(Instance.worktree, c.filePath)
              if (!c.movePath) return [base]
              return [base, path.relative(Instance.worktree, c.movePath)]
            })
            .filter((p) => p !== ""),
        ),
      )

      await ctx.ask({
        permission: "edit",
        patterns,
        always: ["*"],
        metadata: {
          diff: totalDiff,
        },
      })

      const changedFiles: string[] = []

      for (const change of fileChanges) {
        switch (change.type) {
          case "add": {
            const dir = path.dirname(change.filePath)
            if (dir !== "." && dir !== "/") {
              await fs.mkdir(dir, { recursive: true })
            }
            await fs.writeFile(change.filePath, change.newContent, "utf-8")
            changedFiles.push(change.filePath)

            const statsAfter = await Bun.file(change.filePath).stat()
            FileTime.read(ctx.sessionID, change.filePath, FileTime.stamp(statsAfter.mtime, change.newContent))
            break
          }

          case "update": {
            await fs.writeFile(change.filePath, change.newContent, "utf-8")
            changedFiles.push(change.filePath)

            const statsAfter = await Bun.file(change.filePath).stat()
            FileTime.read(ctx.sessionID, change.filePath, FileTime.stamp(statsAfter.mtime, change.newContent))
            break
          }

          case "move": {
            if (!change.movePath) break

            const dir = path.dirname(change.movePath)
            if (dir !== "." && dir !== "/") {
              await fs.mkdir(dir, { recursive: true })
            }

            await fs.writeFile(change.movePath, change.newContent, "utf-8")
            await fs.unlink(change.filePath)
            changedFiles.push(change.movePath)

            FileTime.clear(ctx.sessionID, change.filePath)
            const statsAfter = await Bun.file(change.movePath).stat()
            FileTime.read(ctx.sessionID, change.movePath, FileTime.stamp(statsAfter.mtime, change.newContent))
            break
          }

          case "delete": {
            await fs.unlink(change.filePath)
            changedFiles.push(change.filePath)
            FileTime.clear(ctx.sessionID, change.filePath)
            break
          }
        }
      }

      return {
        changedFiles,
        totalDiff,
        changedCount: fileChanges.length,
      }
    })

    for (const filePath of result.changedFiles) {
      await Bus.publish(FileWatcher.Event.Updated, { file: filePath, event: "change" })
    }

    const relativePaths = result.changedFiles.map((filePath) => path.relative(Instance.worktree, filePath))
    const summary = `${result.changedCount} files changed`

    return {
      title: summary,
      metadata: {
        diff: result.totalDiff,
      },
      output: `Patch applied successfully. ${summary}:\n${relativePaths.map((p) => `  ${p}`).join("\n")}`,
    }
  },
})
