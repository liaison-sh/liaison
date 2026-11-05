// SPDX-License-Identifier: FSL-1.1-ALv2

import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"

/**
 * In-code enrichment registry for searchable entities. `searchable-entities.ts`
 * stays pure manifest-parsed data (no function slots on
 * `SearchableEntityRegistration` itself); this map is the "analogous to
 * KERNEL_BUILTINS" attachment point the spec calls for — a first-party app
 * registers an async hook keyed by `app:entityType` here, and the shared
 * doc-builder (`doc-builder.ts`) consults it when building a document.
 *
 * A hook returns EXTRA searchable text appended into the document's `body`
 * (joined with a newline after any manifest-mapped body value) — the 4-slot
 * searchable-attribute set (title/handle/label_secondary/body) stays frozen;
 * enrichment only ever contributes to `body`.
 *
 * Failures THROW — the caller (the indexer job / full reindex) must let a
 * failed enrichment read fail the job so BullMQ retries, exactly like any
 * other upsert failure. Never swallow an enrichment error here.
 */
export type EnrichmentHelpers = {
  orgId: string
  /**
   * Run a read under the same privileged (BYPASSRLS), org-scoped context
   * `readRowForUpsert` already uses. The document's visibility is enforced at
   * QUERY time by the permission filter, not by this read — this just needs
   * to see the row regardless of the indexing job's caller.
   */
  withPrivilegedRead: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
  /**
   * Invariant K, answered ONCE per document by the doc builder (mail only):
   * the row's mailbox is sealed and nothing derived from it may carry content.
   * A hook that sees `true` contributes no text. Absent when the caller did not
   * compute it (a hook then asks itself).
   */
  contentSuppressed?: boolean
}

/**
 * Structured enrichment result. `bodyExtra` is appended into the document's
 * `body` (newline-joined). `dedupeKey` groups documents that are facets of the
 * SAME logical thing (e.g. per-reply ticket fragments of one email
 * conversation): human-facing search surfaces collapse docs sharing a
 * dedupeKey to the single best-ranked hit via Meili's `distinct` search
 * parameter. Omitted/null dedupeKey means "this document dedupes with
 * nothing" (the document then carries no `dedupe_key` at all, which Meili's
 * `distinct` never collapses).
 */
export type SearchEnrichmentResult = {
  bodyExtra?: string | null
  dedupeKey?: string | null
  /** Replaces the manifest-mapped `handle` when the shown handle is computed
   *  (a ticket's display handle `ticket-B2B-12`, whose stored form goes in
   *  `bodyExtra` so both stay searchable). */
  handle?: string | null
}

export type SearchEnrichmentHook = (
  row: Record<string, unknown>,
  helpers: EnrichmentHelpers,
) => Promise<string | SearchEnrichmentResult | null>

const registry = new Map<string, SearchEnrichmentHook>()

function key(app: string, entityType: string): string {
  return `${app}:${entityType}`
}

/**
 * Register an enrichment hook for `app:entityType`. Call once at process
 * boot (module-level side effect from the owning app's boot wiring) — see
 * `apps/tickets/search-enrichment.ts` for the concrete tickets registration
 * and `infra/boot-phase10.ts` for where it is invoked.
 */
export function registerSearchEnrichment(
  app: string,
  entityType: string,
  hook: SearchEnrichmentHook,
): void {
  registry.set(key(app, entityType), hook)
}

/** Look up a registered enrichment hook, or `undefined` if none is registered. */
export function lookupSearchEnrichment(
  app: string,
  entityType: string,
): SearchEnrichmentHook | undefined {
  return registry.get(key(app, entityType))
}

/**
 * Build the {@link EnrichmentHelpers} passed to a hook for a given org. Split
 * out so `doc-builder.ts` and tests can construct it identically.
 */
export function buildEnrichmentHelpers(orgId: string): EnrichmentHelpers {
  return {
    orgId,
    withPrivilegedRead: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const SearchEnrichmentTestAccess = {
  /** Test-only: clear every registered hook so test files don't leak state. */
  reset(): void {
    registry.clear()
  },
}
