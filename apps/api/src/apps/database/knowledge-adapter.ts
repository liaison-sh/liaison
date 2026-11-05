// SPDX-License-Identifier: FSL-1.1-ALv2
//
// database-backed Knowledge source adapter.
//
// An APP-TO-APP connector: it materializes KB documents out of a database
// ALREADY connected via the `database` app, reusing that app's transport +
// db-core curated-reads catalog. It does NOT open its own `pg` client and it
// never interpolates a schema identifier into SQL — every read goes through
// two well-known curated reads the connected catalog is expected to declare:
//
//   knowledge_sync_list  { after_updated_at?, after_id?, limit }  -> id,title,updated_at,url?
//   knowledge_sync_get   { id }                                    -> id,title,body,updated_at,url?
//
// Curated reads own all SQL (schema mapping lives in the catalog, keyed to the
// deployment's real KB table). If the catalog does not declare a read, the
// adapter degrades gracefully (empty/unavailable/unsupported) rather than
// crashing — mirroring Drive's non-throwing IO contract. The only throw is the
// folderRef charset guard (defense-in-depth), matching the Drive adapter.
//
// Structural template: apps/api/src/apps/google-drive/adapter.ts.

import type { KnowledgeActor } from "~/apps/knowledge/service"
import type {
  KnowledgeFolderItem,
  KnowledgeFolderListInput,
  KnowledgeFolderListResult,
  KnowledgeSourceAdapter,
  KnowledgeSourceSearchResult,
} from "~/apps/knowledge/source-protocol"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "database-knowledge-adapter" })

const LIST_READ = "knowledge_sync_list"
const GET_READ = "knowledge_sync_get"
const PAGE_LIMIT = 200
// Non-text files are not produced by this source — every KB article is
// materialized as a markdown document body via knowledge_sync_get. text/markdown
// satisfies `isTextMime`, so the reconciler ingests these as full documents.
const MARKDOWN_MIME = "text/markdown"

interface KeysetCursor {
  updated_at: string
  id: string
}

/** Injected seam over the connected database's transport + curated-reads
 *  catalog. `runRead` wraps `transport.runRead(catalog.reads[name], name, params)`;
 *  `hasRead` is the catalog capability check. Tests inject mocks; production
 *  wiring (knowledge-read-runner.ts) resolves creds+transport+catalog. */
export interface DatabaseKnowledgeAdapterDeps {
  runRead(
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ rows: Record<string, unknown>[] }>
  hasRead(name: string): boolean
}

function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf-8").toString("base64")
}

/** Decode a base64 keyset cursor; returns null on any malformed input so a
 *  corrupt cursor restarts the scan from the top rather than throwing. */
function decodeCursor(cursor: string | undefined): KeysetCursor | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8")) as unknown
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as KeysetCursor).updated_at === "string" &&
      typeof (parsed as KeysetCursor).id === "string"
    ) {
      return parsed as KeysetCursor
    }
    return null
  } catch {
    return null
  }
}

/** Normalize a curated-read value to an ISO-8601 string, or undefined. Handles
 *  Date instances (postgres.js timestamptz) and string values alike. */
function toIso(value: unknown): string | undefined {
  if (value == null) return undefined
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function optionalString(value: unknown): string | undefined {
  return value == null ? undefined : String(value)
}

function skippedSearch(): KnowledgeSourceSearchResult {
  return {
    hits: [],
    status: {
      source: "database",
      state: "skipped",
      retryable: false,
      message: "The database source syncs KB documents; it does not serve federated search.",
      hitCount: 0,
    },
  }
}

export function createDatabaseKnowledgeAdapter(
  deps: DatabaseKnowledgeAdapterDeps,
): KnowledgeSourceAdapter {
  return {
    source: "database",

    // Folder-sync-only source: federated search is a no-op skipped envelope,
    // exactly like a connector that only materializes documents.
    async searchRemote(): Promise<KnowledgeSourceSearchResult> {
      return skippedSearch()
    },

    async fetchRemoteContent(
      input: { sourceEntityId: string },
      _actor: KnowledgeActor,
      _purpose?: string,
    ) {
      // No get read in the connected catalog -> the source cannot serve bodies.
      if (!deps.hasRead(GET_READ)) {
        return { status: "unsupported" }
      }
      let rows: Record<string, unknown>[]
      try {
        const result = await deps.runRead(GET_READ, { id: input.sourceEntityId })
        rows = result.rows
      } catch (err) {
        // Non-throwing IO contract (mirror Drive): a transport/DB failure is an
        // unavailable body, not an adapter crash. Logged for field observability.
        log.warn(
          { err, sourceEntityId: input.sourceEntityId },
          "database knowledge: fetchRemoteContent read failed",
        )
        return { status: "unavailable" }
      }
      const row = rows[0]
      if (!row) return { status: "unavailable" }
      return {
        status: "available",
        text: String(row.body),
        title: String(row.title),
        url: optionalString(row.url),
        modifiedAt: toIso(row.updated_at),
      }
    },

    async listFolder(
      input: KnowledgeFolderListInput,
      _actor: KnowledgeActor,
    ): Promise<KnowledgeFolderListResult> {
      const { folderRef, cursor } = input
      // Defense-in-depth: folderRef is a logical root, NEVER interpolated into
      // SQL (curated reads own the SQL). Still validate its charset and throw
      // on violation, mirroring the Drive adapter's guard.
      if (!/^[A-Za-z0-9_:-]{1,128}$/.test(folderRef)) {
        throw new Error(`Invalid database folderRef: ${JSON.stringify(folderRef)}`)
      }
      // No list read in the connected catalog -> degrade to empty (source
      // unavailable). Return empty items and DON'T recurse — never throw.
      if (!deps.hasRead(LIST_READ)) {
        return { items: [] }
      }

      const keyset = decodeCursor(cursor)
      let rows: Record<string, unknown>[]
      try {
        const result = await deps.runRead(LIST_READ, {
          after_updated_at: keyset?.updated_at ?? null,
          after_id: keyset?.id ?? null,
          limit: PAGE_LIMIT,
        })
        rows = result.rows
      } catch (err) {
        // Non-throwing IO contract (mirror Drive): a failed page is an empty
        // page, not a crash. The reconciler's walk terminates cleanly.
        log.warn({ err, folderRef }, "database knowledge: listFolder read failed")
        return { items: [] }
      }

      const items: KnowledgeFolderItem[] = rows.map((row) => {
        const item: KnowledgeFolderItem = {
          kind: "file",
          externalId: String(row.id),
          name: String(row.title),
          parentExternalId: folderRef,
          mimeType: MARKDOWN_MIME,
        }
        const modifiedAt = toIso(row.updated_at)
        if (modifiedAt) item.modifiedAt = modifiedAt
        const url = optionalString(row.url)
        if (url) item.url = url
        return item
      })

      const result: KnowledgeFolderListResult = { items }
      // Full page -> more rows may remain; emit a keyset cursor from the last
      // row. Short page -> the scan is exhausted; omit nextCursor.
      if (rows.length === PAGE_LIMIT) {
        const last = rows[rows.length - 1]!
        result.nextCursor = encodeCursor({
          updated_at: toIso(last.updated_at) ?? "",
          id: String(last.id),
        })
      }
      return result
    },
  }
}
