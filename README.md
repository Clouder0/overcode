# Overcode

Overcode is a power-user fork of [OpenCode](https://github.com/sst/opencode) focused on async-first agent orchestration and a terminal-first workflow.

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

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
