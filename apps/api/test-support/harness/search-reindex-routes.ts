// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Synchronous full-reindex endpoint for the test / chaos harness.
//
// The production search-indexing path is ASYNC: a kernel event → the durable
// `search-indexer` consumer → a BullMQ `search-index-upsert` job → the worker →
// Meili. Under a heavy seed's event backlog that pipeline lags ~1-2 minutes, so a
// scenario started right after seeding RACES the indexer and intermittently finds
// zero hits (observed flake: a knowledge-grounded scenario green on one run, then
// "absent from the searchable index" on the next).
//
// This endpoint runs `runReindex()` IN-PROCESS and upserts every searchable entity
// straight to Meili before returning, so the harness can make search deterministic
// by calling it once after seeding. It is automatically scoped to the cloned chaos
// schema: the api process carries `SCHEMA_PREFIX`, and `runReindex` resolves table /
// org references through the prefix-aware `schemaRef`, so it reindexes exactly the
// run's org(s) — no schema-prefix argument needed.
//
// Mounted only when `qaSeedRoutesEnabled` (NODE_ENV=test or ENABLE_QA_SEED_ROUTES);
// the env validator refuses to boot that flag in production.
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { runReindex } from "~/modules/search/reindex"

export const searchReindexTestRoutes = new Hono<AppEnv>()

// POST /api/_test/search/reindex — synchronously reindex every searchable entity in
// the (schema-prefixed) world to Meili. Returns the org + doc counts indexed.
searchReindexTestRoutes.post("/reindex", async (c) => {
  const result = await runReindex()
  return c.json({ data: result })
})
