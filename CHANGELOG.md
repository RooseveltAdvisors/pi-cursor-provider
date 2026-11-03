# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.7] - 2026-11-03

### Fixed

- Tool calls now render as human-readable markers instead of raw JSON argument dumps: `⏳ [Shell] <command>` (primary argument or the vendor's description, bookkeeping fields such as `toolCallId` hidden), and completed calls were no longer dropped — `✓` markers carry the exit code, timing, and short output (stdout/content), `✗` markers carry blocked/error verdicts.
- Tool-key detection matches the `*ToolCall` suffix instead of trusting the vendor's sibling key order.

## [0.1.6] - 2026-11-03

### Changed

- Refreshed the static fallback model catalog from `agent models` output of Cursor Agent CLI v2026.10.22-27dcf5f: 270 models, grouped by family, with context-window and max-output attributes taken from the vendor's own model names.

### Fixed

- Pruned nine dead `MODEL_MAP` families (claude-sonnet/opus-4-5 and 4-6, gpt-5.2-codex and -fast, gpt-5.1-codex-max, gemini-3-pro-preview, grok-code-fast-1) whose variant ids the CLI no longer accepts; typing one of those canonical ids now passes through to the CLI instead of being translated to a rejected id.
- Repaired the lint gate: migrated `biome.json` to the 2.4.3 schema, matched the formatter's indent style to the existing 2-space files, and applied the safe autofixes.

## [0.1.5]

### Fixed

- **Linux `spawn E2BIG` on long sessions / auto-compaction**: deliver the Cursor Agent `--print` prompt on stdin instead of a single argv string. Linux rejects one argv longer than `MAX_ARG_STRLEN` (131072 bytes); large Pi transcripts (including compaction summarization) hit that limit and surface as `Auto-compaction failed: Summarization failed: spawn E2BIG`.

### Added

- Behavioral regression `npm run test:e2big` covering argv failure and stdin success above 131072 bytes.

## [0.1.2]

### Added

- **Duration and TTFT**: Assistant messages now include optional `duration` (total turn time) and `ttft` (time to first token) for display or logging.
- **Canonical model ID mapping**: You can select models by canonical IDs (e.g. `claude-sonnet-4-5`). When Pi provides a reasoning/thinking level, the provider resolves to the correct CLI model (e.g. thinking variant). Unmapped model IDs continue to work as before.
- **README model reference table**: Documented available models in a single table (Canonical ID, CLI model ID, Name, Reasoning) and noted that canonical IDs can use the thinking variant when reasoning is enabled.
- **Tooling**: `npm run lint` (Biome check), `npm run format` (Biome check --write), and `npm run typecheck` (TypeScript noEmit). Added `biome.json` and `tsconfig.json`.

## [0.1.1]

Small fixes.

## [0.1.0]

Initial release with Cursor Agent CLI provider, dynamic model discovery, and auth commands.