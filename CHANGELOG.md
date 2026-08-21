# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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