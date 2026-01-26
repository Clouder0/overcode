#!/usr/bin/env bun

// CLI-only publish entrypoint for the fork.
// Intentionally does not publish SDK/plugin/registries.
await import("../packages/opencode/script/publish.ts")
