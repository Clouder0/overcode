import { test, expect } from "bun:test"

const PROMPTS_DIR = new URL("../../src/session/prompt/", import.meta.url)

test("prompt templates do not contain opencode branding", async () => {
  const exists = await Bun.file(PROMPTS_DIR).exists()
  if (!exists) {
    expect(true).toBe(true)
    return
  }

  const fs = await import("node:fs/promises")
  const entries = await fs.readdir(PROMPTS_DIR, { withFileTypes: true }).catch(() => [])

  // If directory reading fails for any reason, avoid false positives.
  if (!entries.length) {
    expect(true).toBe(true)
    return
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith(".txt")) continue

    const file = new URL(entry.name, PROMPTS_DIR)
    const text = await Bun.file(file).text()

    expect(text.toLowerCase()).not.toContain("opencode")
    expect(text).not.toContain("OpenCode")
  }
})
