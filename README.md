# Overcode

Overcode is a power-user fork of [OpenCode](https://github.com/sst/opencode) focused on async-first agent orchestration and a terminal-first workflow.

- Async subagents (parallel workers)
- Inter-agent messaging (send/wait primitives)
- TUI enhancements for navigating nested sessions

Fork-specific documentation lives in `over_docs/README.md`.

## Installation

The Overcode CLI is published to npm as `overcode-ai`.
Installing it provides the `overcode` command.

```bash
# Stable
npm i -g overcode-ai@latest

# Canary (previews)
npm i -g overcode-ai@canary

overcode --version
```

Alternative package managers:

```bash
bun install -g overcode-ai@latest
pnpm install -g overcode-ai@latest
yarn global add overcode-ai@latest
```

Note: This fork currently only documents npm-based installation. Upstream installation methods (curl script, Homebrew, Scoop, etc.) are not maintained here.

## Releases

- Npm dist-tags: `latest` (stable) and `canary` (preview)
- Git tags in this fork use `overcode-ai-vX.Y.Z` to avoid colliding with upstream `vX.Y.Z` tags

## Relationship to upstream

This repository is a fork. OpenCode is the upstream project; Overcode cherry-picks upstream fixes as needed.
