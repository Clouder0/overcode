import { describe, expect, test } from "bun:test"
import path from "path"
import { promptQueueFilePath } from "../../src/cli/cmd/tui/component/prompt/queue-file"

describe("prompt queue file path", () => {
  test("scopes queue file by process id", () => {
    const state = "/tmp/opencode-state"
    const one = promptQueueFilePath({ state, pid: 111 })
    const two = promptQueueFilePath({ state, pid: 222 })

    expect(one).not.toBe(two)
    expect(one).toBe(path.join(state, "prompt-queue.111.jsonl"))
    expect(two).toBe(path.join(state, "prompt-queue.222.jsonl"))
  })
})
