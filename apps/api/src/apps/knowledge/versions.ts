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
import { kernelRel, knowledgeRel } from "~/apps/knowledge/schema-refs"
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
/** Rows kept per page; the oldest go first ({@link pruneVersions} says which never go). */
export const VERSIONS_PER_PAGE = 200
/** A version is kept this long after it was last written; an unapplied text longer. */
export const VERSIONS_KEPT_DAYS = 365

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

/**
 * Trim a page's history.
 *
 * - A version last written more than {@link VERSIONS_KEPT_DAYS} days ago goes, except an
 *   `unapplied` text: a text a person could not save is kept at any age.
 * - Then the page keeps at most {@link VERSIONS_PER_PAGE} rows, oldest first out, but two
 *   kinds of row never count against that: every `unapplied` text, and each author's
 *   newest version (an author is a person, or one agent acting for that person). So an
 *   agent or an integration looping on a page can push out only its own older rows and
 *   other authors' older rows, never a person's last text or a conflict text.
 */
export async function pruneVersions(tx: RlsClient, documentId: string): Promise<void> {
  const versions = knowledgeRel("document_versions")
  await tx.execute(sql`
    DELETE FROM ${versions}
     WHERE document_id = ${documentId}::uuid AND kind <> 'unapplied'
       AND updated_at < now() - make_interval(days => ${VERSIONS_KEPT_DAYS})`)
  await tx.execute(sql`
    DELETE FROM ${versions}
     WHERE document_id = ${documentId}::uuid
       AND id IN (
         WITH ranked AS (
           SELECT id, created_at,
                  CASE WHEN kind = 'unapplied' THEN 1
                       ELSE row_number() OVER (
                              PARTITION BY kind = 'unapplied', author_type, author_id, agent_id
                              ORDER BY created_at DESC, id DESC)
                  END AS rank
             FROM ${versions}
            WHERE document_id = ${documentId}::uuid)
         SELECT id FROM ranked
          WHERE rank > 1
          ORDER BY created_at DESC, id DESC
         OFFSET GREATEST(0, ${VERSIONS_PER_PAGE} - (SELECT count(*) FROM ranked WHERE rank = 1)))`)
}

/** A version as the history list shows it: no text. */
export interface VersionListItem {
  id: string
  kind: VersionKind
  title: string
  authorType: VersionAuthorType
  authorId: string | null
  authorName: string | null
  agentId: string | null
  revision: number | null
  baseRevision: number | null
  startedAt: string
  createdAt: string
  updatedAt: string
}

export interface VersionDetail extends VersionListItem {
  body: string
  requiredScopes: string[]
}

interface VersionDbRow {
  id: string
  kind: VersionKind
  title: string
  body?: string
  author_type: VersionAuthorType
  author_id: string | null
  author_name: string | null
  agent_id: string | null
  revision: number | null
  base_revision: number | null
  started_at: string | Date
  created_at: string | Date
  updated_at: string | Date
  required_scopes?: string[]
}

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : v)

function listItem(r: VersionDbRow): VersionListItem {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    authorType: r.author_type,
    authorId: r.author_id,
    authorName: r.author_name,
    agentId: r.agent_id,
    revision: r.revision,
    baseRevision: r.base_revision,
    startedAt: iso(r.started_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

/** The columns both readers select, under the reader's row view. */
function versionColumns(withBody: boolean) {
  return sql`
    v.id::text AS id, v.kind, v.title, v.author_type, v.author_id::text AS author_id,
    u.name AS author_name, v.agent_id::text AS agent_id, v.revision, v.base_revision,
    v.started_at, v.created_at, v.updated_at
    ${withBody ? sql`, v.body, v.required_scopes` : sql``}`
}

/** A page's history, newest first, without texts. Row security keeps it to editors. */
export async function listVersions(tx: RlsClient, documentId: string): Promise<VersionListItem[]> {
  const rows = extractRows<VersionDbRow>(
    await tx.execute(sql`
      SELECT ${versionColumns(false)}
        FROM ${knowledgeRel("document_versions")} v
        LEFT JOIN ${kernelRel("users")} u ON u.id = v.author_id
       WHERE v.document_id = ${documentId}::uuid
       ORDER BY v.created_at DESC, v.id DESC`),
  )
  return rows.map(listItem)
}

/** One version with its text, or null when it is not this page's or not readable. */
export async function getVersion(
  tx: RlsClient,
  documentId: string,
  versionId: string,
): Promise<VersionDetail | null> {
  const [row] = extractRows<VersionDbRow>(
    await tx.execute(sql`
      SELECT ${versionColumns(true)}
        FROM ${knowledgeRel("document_versions")} v
        LEFT JOIN ${kernelRel("users")} u ON u.id = v.author_id
       WHERE v.document_id = ${documentId}::uuid AND v.id = ${versionId}::uuid`),
  )
  if (!row) return null
  return { ...listItem(row), body: row.body ?? "", requiredScopes: row.required_scopes ?? [] }
}

/**
 * A text a person could not apply (a conflict left open, a draft of another tab) goes
 * to history as `unapplied`. One row per author, base revision and session: a later
 * text of that same session on that same base replaces it; any other is its own row.
 */
export async function saveUnapplied(
  tx: RlsClient,
  args: {
    orgId: string
    documentId: string
    title: string
    body: string
    baseRevision: number
    session: string | null
    authorId: string
  },
): Promise<string> {
  const versions = knowledgeRel("document_versions")
  if (args.session) {
    const [updated] = extractRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${versions}
           SET title = ${args.title}, body = ${args.body}, body_md5 = ${md5(args.body)},
               updated_at = clock_timestamp()
         WHERE id = (
           SELECT id FROM ${versions}
            WHERE document_id = ${args.documentId}::uuid AND kind = 'unapplied'
              AND author_id = ${args.authorId}::uuid AND base_revision = ${args.baseRevision}
              AND session_id = ${args.session}::uuid
            ORDER BY created_at DESC LIMIT 1)
        RETURNING id::text AS id`),
    )
    if (updated) return updated.id
  }
  const [inserted] = extractRows<{ id: string }>(
    await tx.execute(sql`
      INSERT INTO ${versions}
        (org_id, document_id, kind, title, body, body_md5, base_revision, session_id,
         author_type, author_id, started_at, created_at, updated_at, required_scopes)
      SELECT d.org_id, d.id, 'unapplied', ${args.title}, ${args.body}, ${md5(args.body)},
             ${args.baseRevision}, ${args.session}::uuid, 'user', ${args.authorId}::uuid,
             clock_timestamp(), clock_timestamp(), clock_timestamp(), d.required_scopes
        FROM ${knowledgeRel("documents")} d
       WHERE d.id = ${args.documentId}::uuid AND d.org_id = ${args.orgId}::uuid
      RETURNING id::text AS id`),
  )
  if (!inserted) throw new Error("unapplied version not stored")
  await pruneVersions(tx, args.documentId)
  return inserted.id
}
