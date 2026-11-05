// SPDX-License-Identifier: FSL-1.1-ALv2
import { MeiliSearch } from "meilisearch"
import { env } from "~/lib/env"

const CANONICAL_INDEX = "liaison_search"

/**
 * Per-HTTP-request timeout for every MeiliSearch call. The client aborts the
 * underlying fetch (via AbortController) when it elapses, so it both bounds a
 * genuinely hung Meili and cleanly cancels the request — unlike a `Promise.race`
 * wrapper, which leaks the in-flight request.
 *
 * A normal query resolves in tens of milliseconds; under heavy load (CI, a
 * concurrent boot reindex, CPU contention) it can take a few seconds. The
 * budget is deliberately generous because a slow-but-working response must NOT
 * be misreported as "search unavailable". A real outage (Meili process down)
 * fails fast at the TCP layer and is unaffected by this value.
 */
const MEILI_REQUEST_TIMEOUT_MS = 10_000

let client: MeiliSearch | null = null

/**
 * Returns the singleton MeiliSearch client.
 *
 * In dev MEILISEARCH_API_KEY may be empty — Meili allows anonymous access in
 * development mode. The production env superRefine guards against missing keys.
 */
export function getMeili(): MeiliSearch {
  if (!client) {
    client = new MeiliSearch({
      host: env.MEILISEARCH_HOST,
      apiKey: env.MEILISEARCH_API_KEY || undefined,
      timeout: MEILI_REQUEST_TIMEOUT_MS,
    })
  }
  return client
}

let vectorStoreOn: Promise<void> | null = null

/**
 * Switch on Meilisearch's `vectorStore` experimental feature, once per process.
 *
 * Every search or document read that passes `retrieveVectors` needs it, and
 * Meili rejects such a request outright while it is off. It used to be switched
 * on only where the memory embedder is declared, the first time a message was
 * indexed with an embedding, so a Meilisearch that had never indexed one (a
 * fresh container, an instance with no embedding provider) failed every memory
 * transcript search, which then came back empty. The PATCH is idempotent; a
 * failure is not remembered, so the next caller tries again.
 */
export function ensureMeiliVectorStore(): Promise<void> {
  if (!vectorStoreOn) {
    vectorStoreOn = getMeili()
      .httpRequest.patch({ path: "experimental-features", body: { vectorStore: true } })
      .then(() => undefined)
      .catch((err: unknown) => {
        vectorStoreOn = null
        throw err
      })
  }
  return vectorStoreOn
}

/**
 * Effective name of the canonical search index, prefixed when MEILI_INDEX_PREFIX
 * is set (used to isolate test or per-deployment indexes).
 */
export function effectiveIndexName(): string {
  return `${env.MEILI_INDEX_PREFIX ?? ""}${CANONICAL_INDEX}`
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const MeiliClientTestAccess = {
  /** Test-only reset to drop the singleton between mocked-env runs. */
  reset(): void {
    client = null
    vectorStoreOn = null
  },
}
