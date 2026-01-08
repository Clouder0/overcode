import { describe, expect, test } from "bun:test"
import path from "path"
import * as fs from "fs/promises"

import { FileTime } from "../../src/file/time"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("file.time", () => {
  test("allows mtime drift when content unchanged", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "a.txt"), "hello"),
    })

    const filePath = path.join(tmp.path, "a.txt")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = Bun.file(filePath)
        const stats = await file.stat()
        FileTime.read("s", filePath, FileTime.stamp(stats.mtime, "hello"))

        const next = new Date(stats.mtime.getTime() + 60000)
        await fs.utimes(filePath, next, next)
        const driftStats = await Bun.file(filePath).stat()

        await expect(FileTime.assert("s", filePath)).resolves.toBeUndefined()

        const after = FileTime.get("s", filePath)
        expect(after).toBeDefined()
        expect(after!.mtimeMs).toBeGreaterThanOrEqual(driftStats.mtime.getTime())
      },
    })
  })

  test("blocks same-size content changes", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "b.txt"), "abcd"),
    })

    const filePath = path.join(tmp.path, "b.txt")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = Bun.file(filePath)
        const stats = await file.stat()
        FileTime.read("s", filePath, FileTime.stamp(stats.mtime, "abcd"))

        await Bun.write(filePath, "abce")

        await expect(FileTime.assert("s", filePath)).rejects.toThrow("modified since")
      },
    })
  })

  test("blocks size changes", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "c.txt"), "abc"),
    })

    const filePath = path.join(tmp.path, "c.txt")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = Bun.file(filePath)
        const stats = await file.stat()
        FileTime.read("s", filePath, FileTime.stamp(stats.mtime, "abc"))

        await Bun.write(filePath, "abcd")

        await expect(FileTime.assert("s", filePath)).rejects.toThrow("modified since")
      },
    })
  })
})
