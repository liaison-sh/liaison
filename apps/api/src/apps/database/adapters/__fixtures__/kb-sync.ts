// SPDX-License-Identifier: FSL-1.1-ALv2
//
// kb-sync — a throwaway FIXTURE catalog that declares the two well-known
// knowledge-sync curated reads (`knowledge_sync_list`, `knowledge_sync_get`)
// against an imaginary foreign KB schema. It exists ONLY to prove the
// database Knowledge source adapter runs its two curated reads through a
// REAL `validateCatalog`'d catalog (no bespoke SQL, no raw identifier
// interpolation), NOT to describe any deployment's real schema — Tessera Hub's
// own KB catalog is the deployment's concern, supplied via
// LIAISON_DATABASE_ADAPTER_PATH.
//
// Imaginary target schema (never migrated — catalog-shape fixture only):
//
//   kb.articles(id, title, body, updated_at, public_url, secret_token)
//
// `kb.articles.secret_token` is deliberately present in the imaginary schema
// but ABSENT from every read's `columns`/`grantColumns` — the same
// secret-column discipline toy-shop.ts applies by hand for a foreign schema.

import type { ReadCatalog } from "@liaison/db-core"

export const kbSyncCatalog: ReadCatalog = {
  adapter: "kb-sync",
  reads: {
    // Keyset-paginated list, ORDER BY (updated_at, id) ASC. When a cursor is
    // present the WHERE tuple-compares against (:after_updated_at, :after_id);
    // COALESCE lets the same SQL serve the first (null cursor) page too.
    knowledge_sync_list: {
      description: "List KB articles for sync, keyset-paginated by (updated_at, id) ascending.",
      domain: "knowledge",
      // `:after_updated_at::timestamptz IS NULL` (not a bare `:after_updated_at
      // IS NULL`) — the first occurrence of a named param needs an explicit
      // cast so a real prepared-statement driver (postgres.js) can infer
      // parameter $1's type from a standalone `IS NULL` comparison. Without
      // it, a real Postgres connection throws "could not determine data type
      // of parameter $1" on the first (cursor-less) page — a fake in-memory
      // transport never surfaces this since it doesn't type-check bind params.
      sql:
        "SELECT id, title, updated_at, public_url AS url FROM kb.articles " +
        "WHERE (:after_updated_at::timestamptz IS NULL OR (updated_at, id) > (:after_updated_at, :after_id)) " +
        "ORDER BY updated_at ASC, id ASC LIMIT :limit",
      params: {
        after_updated_at: {
          type: "string",
          description: "Keyset cursor: updated_at (ISO) or null",
        },
        after_id: { type: "string", description: "Keyset cursor: id or null" },
        limit: { type: "integer", description: "Page size" },
      },
      columns: ["id", "title", "updated_at", "url"],
      tables: ["kb.articles"],
      // `url` is a SELECT alias for public_url (not a real column), so the
      // columns-vs-grantColumns cross-check is relaxed via resultIsAggregate;
      // grantColumns still names every REAL column the SQL touches.
      resultIsAggregate: true,
      grantColumns: {
        "kb.articles": ["id", "title", "updated_at", "public_url"],
      },
    },
    // Fetch one article's full body by id.
    knowledge_sync_get: {
      description: "Fetch a single KB article's title + body by id.",
      domain: "knowledge",
      sql: "SELECT id, title, body, updated_at, public_url AS url FROM kb.articles WHERE id = :id",
      params: { id: { type: "string", description: "Article id" } },
      columns: ["id", "title", "body", "updated_at", "url"],
      tables: ["kb.articles"],
      // `url` is a SELECT alias for public_url; see knowledge_sync_list note.
      resultIsAggregate: true,
      grantColumns: {
        "kb.articles": ["id", "title", "body", "updated_at", "public_url"],
      },
      maxRows: 1,
    },
  },
}
