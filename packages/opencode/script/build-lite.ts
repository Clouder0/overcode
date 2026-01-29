#!/usr/bin/env bun

// Hermetic workspace build.
//
// This repo's release artifacts are built by `./script/build.ts`.
// Turbo's `build` task runs frequently (via other packages' test/build
// dependencies), so keep this fast and side-effect free.

console.log("overcode-ai build (workspace): no-op")
