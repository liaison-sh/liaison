// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"

/**
 * The person (member) side of the data-subject export: everything the org
 * holds about ONE member of the organization as a person. The caller has
 * already been authorized (the member themself, or a holder of the data-subject
 * authority), see `data-subject-export-tool.ts`.
 *
 * Two kinds of section:
 *  - `caller`: rows that sit inside conversations and records other people
 *    share (messages, threads, uploaded files). Read under the CALLER's RLS, so
 *    the bundle never carries a conversation the caller could not open.
 *  - `subject`: rows that are about the member alone (preferences, routines,
 *    approvals, audit entries, connected accounts). Read privileged and filtered
 *    strictly on the member's id; RLS would hide most of them from the member
 *    themself (the audit log, for one), which is exactly what an access request
 *    asks for.
 *
 * Every section selects named columns only. Tokens, password and TOTP hashes,
 * encrypted credentials and key material are never selected, and free-form
 * JSON (settings, preferences, audit changes) goes through `withoutSecrets`.
 *
 * EXTENSION POINT: a new kind of per-person record (away ranges, for one) is
 * one more entry in `MEMBER_SECTIONS`. It then appears in every member bundle
 * with its note, its rows and its count, and nothing else changes.
 */

/** Rows per section. A section that reaches it says so (`truncated`). */
export const MEMBER_SECTION_ROW_CAP = 1000

export interface MemberSectionCtx {
  orgId: string
  subjectUserId: string
}

export interface MemberSection {
  key: string
  /** One plain sentence saying what the section holds, written into the bundle. */
  note: string
  via: "caller" | "subject"
  /** Reads at most `limit` rows. `db` is the caller's RLS client or a privileged tx, per `via`. */
  read: (
    db: RlsClient | PrivilegedDb,
    ctx: MemberSectionCtx,
    limit: number,
  ) => Promise<Record<string, unknown>[]>
}

export interface MemberSectionResult {
  note: string
  rows: Record<string, unknown>[]
  truncated: boolean
}

const SECRET_KEY_RE =
  /secret|token|password|passwd|hash|credential|cipher|encrypted|recovery|api[_-]?key|private[_-]?key|totp|otp|nonce|wrapped/i

/** A copy of `value` with every object key that names a secret dropped, at any depth. */
export function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets)
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) continue
      out[k] = withoutSecrets(v)
    }
    return out
  }
  return value
}

function iso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

/** Dates as ISO strings, JSON through `withoutSecrets`. */
function clean(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? iso(v) : withoutSecrets(v)
  }
  return out
}

async function rows(db: RlsClient | PrivilegedDb, query: SQL): Promise<Record<string, unknown>[]> {
  return extractRows<Record<string, unknown>>(await db.execute(query)).map(clean)
}

const K = () => drizzleSql.raw(schemaRef("kernel"))

export const MEMBER_SECTIONS: MemberSection[] = [
  {
    key: "preferences",
    note: "The member's own settings: notifications digest, work hours, time zone, language, theme and writing preferences.",
    via: "subject",
    read: (db, ctx) =>
      rows(
        db,
        drizzleSql`
        SELECT digest_cadence, work_hours_start::text AS work_hours_start,
               work_hours_end::text AS work_hours_end, work_days, timezone, language, theme,
               magic_wand_instructions, dictation_auto_clean, home_card_layout
        FROM ${K()}.user_preferences
        WHERE user_id = ${ctx.subjectUserId}`,
      ),
  },
  {
    key: "roles",
    note: "The roles the member holds in this organization.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT r.name, r.description
        FROM ${K()}.user_roles ur
        JOIN ${K()}.roles r ON r.id = ur.role_id
        WHERE ur.org_id = ${ctx.orgId} AND ur.user_id = ${ctx.subjectUserId}
        ORDER BY r.name
        LIMIT ${limit}`,
      ),
  },
  {
    key: "messages",
    note: "Messages the member wrote, in conversations the requester can open.",
    via: "caller",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, thread_id::text AS thread_id, content,
               parent_message_id::text AS parent_message_id, created_at, edited_at
        FROM ${K()}.messages
        WHERE org_id = ${ctx.orgId} AND author_id = ${ctx.subjectUserId}
          AND author_type = 'user' AND deleted_at IS NULL
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "threads",
    note: "Conversations the member started, as far as the requester can open them.",
    via: "caller",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, handle, title, type, topic, description, created_at
        FROM ${K()}.threads
        WHERE org_id = ${ctx.orgId} AND created_by = ${ctx.subjectUserId}
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "files",
    note: "Files the member uploaded that the requester can open: their details and where to download them. The file contents are not copied into this export.",
    via: "caller",
    read: async (db, ctx, limit) =>
      (
        await rows(
          db,
          drizzleSql`
          SELECT id::text AS id, filename, mime_type, size_bytes::text AS size_bytes, app,
                 entity_type, entity_id, created_at
          FROM ${K()}.files
          WHERE org_id = ${ctx.orgId} AND uploaded_by = ${ctx.subjectUserId}
          ORDER BY created_at
          LIMIT ${limit}`,
        )
      ).map(({ size_bytes, ...r }) => ({
        ...r,
        size_bytes: Number(size_bytes ?? 0),
        links: {
          metadata: `/api/files/${r.id as string}/metadata`,
          download: `/api/files/${r.id as string}/download-url`,
        },
      })),
  },
  {
    key: "approvals",
    note: "Approval requests the member made or decided: which action, its status and when. What each request would have done is not included, as it is usually about other people.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, handle, tool_name, status,
               (requested_by = ${ctx.subjectUserId}) AS requested_by_member,
               (decided_by = ${ctx.subjectUserId}) AS decided_by_member,
               CASE WHEN decided_by = ${ctx.subjectUserId} THEN reason END AS reason,
               thread_id::text AS thread_id, created_at, decided_at
        FROM ${K()}.approval_requests
        WHERE org_id = ${ctx.orgId}
          AND (requested_by = ${ctx.subjectUserId} OR decided_by = ${ctx.subjectUserId})
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "routines",
    note: "Routines the member owns: what each does and when it runs.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, name, description, kind, cron, timezone, run_at, event, app_name,
               prompt, visibility, enabled, status, last_run_at, last_run_status, created_at
        FROM ${K()}.routines
        WHERE org_id = ${ctx.orgId} AND owner_user_id = ${ctx.subjectUserId}
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "auditEntries",
    note: "Audit log entries about the member or recording what they did. The recorded changes are included only for entries about the member themself.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, timestamp, actor_type::text AS actor_type, app, entity_type,
               entity_id, action,
               (actor_id = ${ctx.subjectUserId} OR requester_user_id = ${ctx.subjectUserId})
                 AS by_member,
               CASE WHEN entity_type = 'user' AND entity_id = ${ctx.subjectUserId}::text
                    THEN changes END AS changes
        FROM ${K()}.audit_log
        WHERE org_id = ${ctx.orgId}
          AND (actor_id = ${ctx.subjectUserId}
               OR requester_user_id = ${ctx.subjectUserId}
               OR (entity_type = 'user' AND entity_id = ${ctx.subjectUserId}::text))
        ORDER BY timestamp
        LIMIT ${limit}`,
      ),
  },
  {
    key: "connectedAccounts",
    note: "Accounts the member connected (mail, calendar and other services): which account and its state. Access tokens and credentials are never exported.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, app_name, connection_name, provider_type, identifier, display_name,
               status, status_message, created_at, updated_at, disconnected_at
        FROM ${K()}.connected_accounts
        WHERE org_id = ${ctx.orgId} AND owner_type = 'user' AND owner_id = ${ctx.subjectUserId}
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "signInAccounts",
    note: "Outside sign-in accounts linked to the member (Google and others): provider and address.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, provider_id::text AS provider_id, external_email, created_at
        FROM ${K()}.oauth_accounts
        WHERE org_id = ${ctx.orgId} AND user_id = ${ctx.subjectUserId}
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "connectedApps",
    note: "Outside AI clients the member connected to Liaison: name, last use and whether it was revoked.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, client_id, label, last_used_at, revoked_at, created_at
        FROM ${K()}.mcp_connections
        WHERE org_id = ${ctx.orgId} AND user_id = ${ctx.subjectUserId}
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
]

/** Reads every section: the `caller` ones on `callerDb`, the `subject` ones in one privileged transaction. */
export async function readMemberSections(
  callerDb: RlsClient,
  ctx: MemberSectionCtx,
  sections: readonly MemberSection[] = MEMBER_SECTIONS,
): Promise<Record<string, MemberSectionResult>> {
  const out: Record<string, MemberSectionResult> = {}
  const take = async (s: MemberSection, db: RlsClient | PrivilegedDb) => {
    const got = await s.read(db, ctx, MEMBER_SECTION_ROW_CAP + 1)
    out[s.key] = {
      note: s.note,
      rows: got.slice(0, MEMBER_SECTION_ROW_CAP),
      truncated: got.length > MEMBER_SECTION_ROW_CAP,
    }
  }
  for (const s of sections) if (s.via === "caller") await take(s, callerDb)
  const subjectSections = sections.filter((s) => s.via === "subject")
  if (subjectSections.length > 0) {
    const { withPrivilegedDb } = await import("~/db/privileged")
    await withPrivilegedDb(ctx.orgId, "data_subject_export member sections", async (tx) => {
      for (const s of subjectSections) await take(s, tx)
    })
  }
  // Keep the declared order in the file, whatever order they were read in.
  return Object.fromEntries(sections.map((s) => [s.key, out[s.key] as MemberSectionResult]))
}
