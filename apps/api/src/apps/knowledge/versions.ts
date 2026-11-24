// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Page history (`app_knowledge.document_versions`).
 *
 * A row is a text the page had: the text one author's session produced (kind `edit`,
 * `agent` or `restore`), a `baseline` of the text before a write when the newest row
 * did not hold it, or an `unapplied` text a person could not save (a conflict left
 * open). The version is written by the same statement as the revision compare-and-swap,
 * so a save and its version land together or not at all, and the version's row
 * security (the edit right, `app_knowledge.can_edit_document`) is judged on the page as
 * it was before the write.
 *
 * One session (one mounted editor, identified by the client) of one person keeps one
 * `edit` row for 10 minutes: later saves of that session update it. Nothing coalesces
 * across sessions, an agent write is always its own row, and a save without a session
 * (an old client, the API) is always its own row.
 */
import { createHash } from "node:crypto"
import { type SQL, sql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { extractRows, type RlsClient } from "~/db"

export type VersionKind = "baseline" | "edit" | "agent" | "import" | "restore" | "unapplied"
export type VersionAuthorType = "user" | "agent" | "system"

/** Who a write is by: a person, or an agent acting for one. */
export interface VersionAuthor {
  type: VersionAuthorType
  userId: string
  agentId?: string | null
}

/** The client's editing session, from the autosave route only. */
export interface VersionSession {
  id?: string | null
  /** Open a new row even when this session's newest row could take the text. */
  fresh?: boolean
}

/** One author session's edits coalesce for this long. */
export const VERSION_COALESCE_MINUTES = 10
/** Rows kept per page; the oldest go first. */
export const VERSIONS_PER_PAGE = 200

/** The page as the writer read it, before the write. */
export interface VersionPreImage {
  title: string
  body: string
  revision: number
  createdBy: string
  updatedBy: string | null
  updatedAt: string
}

export function md5(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex")
}

interface NewestRow {
  id: string
  kind: VersionKind
  title: string
  body_md5: string
  author_id: string | null
  session_id: string | null
  recent: boolean
}

async function newestApplied(tx: RlsClient, documentId: string): Promise<NewestRow | null> {
  const [row] = extractRows<NewestRow>(
    await tx.execute(sql`
      SELECT id::text AS id, kind, title, body_md5, author_id::text AS author_id,
             session_id::text AS session_id,
             started_at > now() - make_interval(mins => ${VERSION_COALESCE_MINUTES}) AS recent
        FROM ${knowledgeRel("document_versions")}
       WHERE document_id = ${documentId}::uuid AND kind <> 'unapplied'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`),
  )
  return row ?? null
}

/**
 * Apply `setSql` to the page with the revision compare-and-swap and record the text it
 * leaves in history, in one statement. Returns whether the swap matched a row; a
 * `false` is the caller's conflict (or row security) branch, and then nothing at all
 * was written by this statement.
 *
 * With `textChanges` false (verify, sharing, a summary-only patch) no version is
 * written: history holds texts, not settings.
 */
export async function writeWithVersion(
  tx: RlsClient,
  args: {
    orgId: string
    documentId: string
    expectedRevision: number
    setSql: SQL
    pre: VersionPreImage
    textChanges: boolean
    kind: "edit" | "agent" | "restore"
    author: VersionAuthor
    session?: VersionSession
  },
): Promise<boolean> {
  const docs = knowledgeRel("documents")
  const versions = knowledgeRel("document_versions")
  const cas = sql`
    UPDATE ${docs} SET ${args.setSql}
     WHERE id = ${args.documentId}::uuid AND org_id = ${args.orgId}::uuid
       AND revision = ${args.expectedRevision}
    RETURNING id, org_id, title, body, revision, required_scopes`

  if (!args.textChanges) {
    return extractRows(await tx.execute(sql`${cas}`)).length > 0
  }

  // A baseline of the text before this write when history does not hold it yet, so
  // every text the page ever had is in a row. It is a true past text even if the swap
  // below loses (then the whole transaction is refused anyway). It sorts by when it was
  // recorded (`created_at`); `started_at` says when that text was written. A writer that
  // keeps `updated_at` (a backfill) must not sort it behind the row it follows.
  let newest = await newestApplied(tx, args.documentId)
  if (!newest || newest.body_md5 !== md5(args.pre.body) || newest.title !== args.pre.title) {
    const baselineAuthor = args.pre.updatedBy ?? args.pre.createdBy
    await tx.execute(sql`
      INSERT INTO ${versions}
        (org_id, document_id, kind, title, body, body_md5, revision, author_type, author_id,
         started_at, created_at, updated_at, required_scopes)
      SELECT d.org_id, d.id, 'baseline', ${args.pre.title}, ${args.pre.body}, ${md5(args.pre.body)},
             ${args.pre.revision}, 'user', ${baselineAuthor}::uuid,
             ${args.pre.updatedAt}::timestamptz, clock_timestamp(), clock_timestamp(),
             d.required_scopes
        FROM ${docs} d
       WHERE d.id = ${args.documentId}::uuid AND d.org_id = ${args.orgId}::uuid`)
    newest = null
  }

  const sessionId = args.session?.id ?? null
  const coalesceInto =
    newest &&
    args.kind === "edit" &&
    args.author.type === "user" &&
    newest.kind === "edit" &&
    newest.author_id === args.author.userId &&
    sessionId !== null &&
    newest.session_id === sessionId &&
    newest.recent &&
    !args.session?.fresh
      ? newest.id
      : null

  const insertFromCas = sql`
    INSERT INTO ${versions}
      (org_id, document_id, kind, title, body, body_md5, revision, base_revision, session_id,
       author_type, author_id, agent_id, started_at, created_at, updated_at, required_scopes)
    SELECT cas.org_id, cas.id, ${args.kind}, cas.title, cas.body, md5(cas.body), cas.revision,
           ${args.expectedRevision}, ${sessionId}::uuid, ${args.author.type},
           ${args.author.userId}::uuid, ${args.author.agentId ?? null}::uuid,
           clock_timestamp(), clock_timestamp(), clock_timestamp(), cas.required_scopes
      FROM cas
    RETURNING id`
  const versionSql = coalesceInto
    ? sql`
      UPDATE ${versions} v
         SET title = cas.title, body = cas.body, body_md5 = md5(cas.body), revision = cas.revision,
             required_scopes = cas.required_scopes, updated_at = clock_timestamp()
        FROM cas
       WHERE v.id = ${coalesceInto}::uuid AND v.document_id = cas.id
      RETURNING v.id`
    : insertFromCas

  const [counts] = extractRows<{ applied: number; versioned: number }>(
    await tx.execute(sql`
      WITH cas AS (${cas}), ver AS (${versionSql})
      SELECT (SELECT count(*) FROM cas)::int AS applied, (SELECT count(*) FROM ver)::int AS versioned`),
  )
  const applied = (counts?.applied ?? 0) > 0
  if (!applied) return false
  if ((counts?.versioned ?? 0) === 0) {
    // The row this session would have updated is gone (pruned): the text gets its own.
    await tx.execute(sql`
      WITH cas AS (
        SELECT id, org_id, title, body, revision, required_scopes FROM ${docs}
         WHERE id = ${args.documentId}::uuid AND org_id = ${args.orgId}::uuid)
      ${insertFromCas}`)
  }
  await pruneVersions(tx, args.documentId)
  return true
}

/** Keep the newest {@link VERSIONS_PER_PAGE} rows of a page. */
export async function pruneVersions(tx: RlsClient, documentId: string): Promise<void> {
  const versions = knowledgeRel("document_versions")
  await tx.execute(sql`
    DELETE FROM ${versions}
     WHERE document_id = ${documentId}::uuid
       AND id IN (
         SELECT id FROM ${versions}
          WHERE document_id = ${documentId}::uuid
          ORDER BY created_at DESC, id DESC
         OFFSET ${VERSIONS_PER_PAGE})`)
}
