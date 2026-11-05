// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Bug reports sent ONLY to the Liaison team (`bugReportsTeamOnly`, settings.ts):
// no local ticket exists, so this module keeps the two things a ticket used to
// keep.
//
//   1. The ticked attachments. They are staged as `kernel.files` rows of app
//      `kernel`, entity type `liaison_team_forward`, entity id a uuid made for
//      the report. No manifest declares that parent (`fileParent`), so the
//      generated files RLS admits no user to them: only the outbox reads them,
//      privileged, when it sends the attachment rows. `sweepTeamOnly` deletes the
//      object and the row once every outbox row naming the file has ended
//      (delivered, refused, cancelled, expired), and in any case after 8 days.
//   2. A trace of a report that never arrived. A team-only `bug-report` row that
//      ends refused, expired or cancelled raises one attention item for the
//      reporter's org admins, carrying the report text, since nobody else has
//      a copy (`liaison_team_forward:undelivered`, kernel-translations.ts).
//
// The sweep runs every minute with the outbox drain (kernel-jobs.ts), even when
// the endpoint is no longer set, so staged files never outlive their rows. With
// no endpoint no drain runs, so the sweep runs the outbox housekeeping itself:
// a report queued before the endpoint was unset still expires after 7 days and
// its notice fires, instead of waiting forever.

import { randomUUID } from "node:crypto"
import { resolveLocale, type ShippedLocale } from "@liaison/shared"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import {
  deleteObjects as defaultDeleteObjects,
  putObject as defaultPutObject,
  sanitizeFilename,
} from "~/infra/storage/object-storage"
import { appsLogger as log } from "~/lib/logger"
import { serverT } from "~/modules/i18n/server-i18n"
import { liaisonTeamEndpoint, outboxHousekeeping } from "~/modules/liaison-team/outbox"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"
import { movingOrgIds } from "~/modules/org/transfer-state/state"

const K = () => drizzleSql.raw(`"${schemaRef("kernel")}"`)

/** The `kernel.files` entity type of a staged team-only attachment. */
export const STAGED_ENTITY_TYPE = "liaison_team_forward"
/** Staged files never outlive this, whatever their rows say. */
const STAGED_MAX_AGE_MS = 8 * 24 * 3600_000
/** A staged file no row names yet (a request still running) is kept this long. */
const STAGED_UNCLAIMED_GRACE_MS = 3600_000
/** The report text an undelivered notice carries. */
const NOTICE_TEXT_CHARS = 4_000
const NOTICE_EXCERPT_CHARS = 600

export interface StorageDeps {
  putObject?: typeof defaultPutObject
  deleteObjects?: typeof defaultDeleteObjects
}

/** One ticked file to stage. */
export interface FileToStage {
  index: number
  filename: string
  mimeType: string
  bytes: Buffer
}

/**
 * Store the ticked files of one team-only report under `stageId`. Returns the
 * file id of each request index. Throws when a file cannot be stored; the
 * caller then deletes what was staged (`deleteStagedFiles`) and files nothing.
 */
export async function stageForwardFiles(
  orgId: string,
  stageId: string,
  toStage: FileToStage[],
  deps: StorageDeps = {},
): Promise<Map<number, string>> {
  const put = deps.putObject ?? defaultPutObject
  const ids = new Map<number, string>()
  for (const [ordinal, file] of toStage.entries()) {
    const fileId = randomUUID()
    const safeName = sanitizeFilename(file.filename)
    const storageKey = `orgs/${orgId}/liaison-team/forward/${stageId}/${fileId}/${safeName}`
    // The row first, so a crash between the two leaves a row the sweep finds,
    // never an object nothing names.
    await withPrivilegedDb(orgId, "liaison-team:stage-forward-file", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${K()}.files
          (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
           storage_key, uploaded_by, disposition, ordinal)
        VALUES (${fileId}::uuid, ${orgId}::uuid, 'kernel', ${STAGED_ENTITY_TYPE}, ${stageId},
                ${safeName}, ${file.mimeType}, ${file.bytes.byteLength}, ${storageKey},
                NULL, 'attachment', ${ordinal})`),
    )
    await put({ key: storageKey, body: file.bytes, contentType: file.mimeType })
    ids.set(file.index, fileId)
  }
  return ids
}

/** Delete every file staged under `stageId` (objects, then rows). Never throws. */
export async function deleteStagedFiles(
  orgId: string,
  stageId: string,
  deps: StorageDeps = {},
): Promise<void> {
  try {
    const rows = extractRows<{ id: string; storage_key: string }>(
      await withPrivilegedDb(orgId, "liaison-team:unstage-forward-files", (tx) =>
        tx.execute(drizzleSql`
          SELECT id, storage_key FROM ${K()}.files
           WHERE org_id = ${orgId}::uuid AND app = 'kernel'
             AND entity_type = ${STAGED_ENTITY_TYPE} AND entity_id = ${stageId}`),
      ),
    )
    await removeFiles(rows, deps)
  } catch (err) {
    log.warn({ err, stageId }, "staged bug report files could not be deleted: the sweep retries")
  }
}

async function removeFiles(
  rows: Array<{ id: string; storage_key: string }>,
  deps: StorageDeps,
): Promise<void> {
  if (rows.length === 0) return
  await (deps.deleteObjects ?? defaultDeleteObjects)(rows.map((r) => r.storage_key))
  const ids = rows.map((r) => r.id)
  await withSystemDb("liaison-team:delete-staged-files", (tx) =>
    tx.execute(drizzleSql`
      DELETE FROM ${K()}.files
       WHERE app = 'kernel' AND entity_type = ${STAGED_ENTITY_TYPE}
         AND id = ANY(${`{${ids.join(",")}}`}::uuid[])`),
  )
}

export interface SweepResult {
  filesDeleted: number
  noticesRaised: number
}

/** One sweep at `now`: delete finished staged files, then raise the undelivered notices. */
export async function sweepTeamOnly(
  now: Date = new Date(),
  deps: StorageDeps = {},
): Promise<SweepResult> {
  if (!liaisonTeamEndpoint()) {
    try {
      await outboxHousekeeping(now)
    } catch (err) {
      log.warn({ err }, "outbox housekeeping failed: the next sweep retries")
    }
  }
  const at = now.getTime()
  const maxAge = new Date(at - STAGED_MAX_AGE_MS).toISOString()
  const grace = new Date(at - STAGED_UNCLAIMED_GRACE_MS).toISOString()
  // An org being moved keeps its staged files as they are until the move ends.
  // A file is done when no row still to be sent names it, and either some row
  // named it (all ended) or nothing claimed it within the grace. A row's data is
  // purged 7 days after it ended, so the 8-day cap also covers a lost reference.
  // The sweep covers the select and the delete of that one page of files.
  const filesDeleted = await sweepSkippingMoving(async (notMoving) => {
    const done = extractRows<{ id: string; storage_key: string }>(
      await withSystemDb("liaison-team:sweep-staged-files", (tx) =>
        tx.execute(drizzleSql`
        SELECT f.id, f.storage_key FROM ${K()}.files f
         WHERE f.app = 'kernel' AND f.entity_type = ${STAGED_ENTITY_TYPE}
           AND ${notMoving(drizzleSql.raw("f.org_id"))}
           AND (f.created_at < ${maxAge}::timestamptz
                OR (NOT EXISTS (
                      SELECT 1 FROM ${K()}.control_plane_outbox o
                       WHERE o.type = 'bug-report-attachment'
                         AND o.data->>'fileId' = f.id::text
                         AND o.status IN ('pending', 'sending'))
                    AND (f.created_at < ${grace}::timestamptz
                         OR EXISTS (
                           SELECT 1 FROM ${K()}.control_plane_outbox o
                            WHERE o.type = 'bug-report-attachment'
                              AND o.data->>'fileId' = f.id::text))))
         LIMIT 200`),
      ),
    )
    try {
      await removeFiles(done, deps)
      return done.length
    } catch (err) {
      log.warn({ err, files: done.length }, "staged bug report files could not be deleted")
      return 0
    }
  })
  return { filesDeleted, noticesRaised: await raiseUndeliveredNotices(now) }
}

interface EndedRow {
  id: string
  message_id: string
  status: string
  last_error: string | null
  data: { report?: { description?: unknown }; local?: { orgId?: unknown } }
}

/** The notice's summary, in the org's language. */
export function undeliveredSummary(locale: ShippedLocale, description: string): string {
  const text = description.replace(/\s+/g, " ").trim()
  const excerpt =
    text.length > NOTICE_EXCERPT_CHARS ? `${text.slice(0, NOTICE_EXCERPT_CHARS)}…` : text
  return serverT(locale, "kernel.bugReport.undeliveredNotice", { excerpt })
}

async function orgLocale(orgId: string): Promise<ShippedLocale> {
  const [row] = await withSystemDb("liaison-team:notice-locale", (db) =>
    db
      .select({ locale: organizations.defaultLocale })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  return resolveLocale(row?.locale ?? null)
}

/**
 * One attention item per team-only report that ended undelivered, for the org
 * admins of the reporter's org, then the row is marked so it is told once.
 */
async function raiseUndeliveredNotices(now: Date): Promise<number> {
  const ended = extractRows<EndedRow>(
    await withSystemDb("liaison-team:undelivered-team-only", (tx) =>
      tx.execute(drizzleSql`
        SELECT id, message_id, status, last_error, data FROM ${K()}.control_plane_outbox
         WHERE type = 'bug-report' AND status IN ('refused', 'cancelled', 'expired')
           AND data->'local'->>'teamOnly' = 'true'
           AND data->'local'->>'noticedAt' IS NULL
         ORDER BY updated_at LIMIT 50`),
    ),
  )
  let raised = 0
  // A notice for an org being moved waits for the move to end (unnoticed rows are rescanned).
  const moving = new Set(await movingOrgIds())
  for (const row of ended) {
    const orgId = typeof row.data.local?.orgId === "string" ? row.data.local.orgId : null
    if (orgId && moving.has(orgId)) continue
    const description =
      typeof row.data.report?.description === "string" ? row.data.report.description : ""
    if (orgId) {
      try {
        const summary = undeliveredSummary(await orgLocale(orgId), description)
        await withSystemDb("liaison-team:undelivered-notice", (db) =>
          db.queueEvent({
            app: "kernel",
            entity: "liaison_team_forward",
            action: "undelivered",
            entityId: row.message_id,
            orgId,
            actorType: "system",
            actorId: null,
            timestamp: now.toISOString(),
            data: {
              summary,
              reportText: description.slice(0, NOTICE_TEXT_CHARS),
              outcome: row.status,
              reason: row.last_error ?? row.status,
              settingsRoute: "/settings/system",
            },
          }),
        )
        raised++
      } catch (err) {
        // An org deleted since: nobody is left to tell. Marked anyway, so the
        // sweep never loops on it.
        log.warn({ err, messageId: row.message_id }, "undelivered bug report notice not raised")
      }
    }
    await withSystemDb("liaison-team:undelivered-noticed", (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${K()}.control_plane_outbox
           SET data = jsonb_set(data, '{local,noticedAt}', to_jsonb(${now.toISOString()}::text))
         WHERE id = ${row.id}::uuid`),
    )
  }
  return raised
}
