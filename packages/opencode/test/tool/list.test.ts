import { describe, expect, test } from "bun:test"
import path from "path"
import { ListTool } from "../../src/tool/ls"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.list", () => {
  test("lists files in directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "a")
        await Bun.write(path.join(dir, "sub", "b.txt"), "b")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const list = await ListTool.init()
        const result = await list.execute({ path: tmp.path }, ctx)
        expect(result.output).toContain("a.txt")
        expect(result.output).toContain("sub/")
      },
    })
  })

  test("applies transport truncation when list output exceeds transport cap", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const a = "a".repeat(180)
        const b = "b".repeat(180)
        const c = "c".repeat(180)
        for (const i of Array.from({ length: 100 }, (_, idx) => idx)) {
          const dirpath = path.join(dir, `${a}${i}`, `${b}${i}`, `${c}${i}`)
          await Bun.write(path.join(dirpath, `${"f".repeat(140)}${i}.txt`), "x")
        }
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const list = await ListTool.init()
        const result = await list.execute({ path: tmp.path }, ctx)
        expect(result.output).toContain("The tool call succeeded but the output was truncated")
        expect((result.metadata as any).outputPath).toBeTruthy()
      },
    })
  })
})
