// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * CLI environment marker — a side-effect-only module imported FIRST by the CLI
 * entrypoint (`cli/index.ts`), before any module that transitively imports
 * `~/lib/logger`.
 *
 * Setting `LIAISON_CLI=1` here (rather than in `index.ts`'s body) matters because
 * ES module imports are hoisted and evaluated depth-first in source order: a bare
 * assignment in `index.ts`'s body would run AFTER its sibling imports have already
 * evaluated the logger module (which reads `process.env.LIAISON_CLI` at module
 * load to decide sync vs async fd-2 destination). Making this the first import
 * guarantees the flag is set before the logger initializes, so the CLI's root
 * logger flushes synchronously before the hard `process.exit()` — while the
 * server (which never imports this) keeps its non-blocking async logger.
 *
 * The `bin/liaison` shim also exports `LIAISON_CLI=1` for the container-exec path;
 * this module covers the canonical `bun run … cli/index.ts` invocation.
 */
process.env.LIAISON_CLI = "1"
