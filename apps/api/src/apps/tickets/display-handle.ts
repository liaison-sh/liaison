// SPDX-License-Identifier: FSL-1.1-ALv2
// Ticket DISPLAY handles (`ticket-<CODE>-<n>`).
//
// The stored handle (`app_tickets.tickets.handle`) is minted once by
// nextHandle as `ticket-<n>` and never rewritten. What people, agents and
// customers see is computed: when the org segments its ids by one field
// (settings.tickets.idSegment = {by, codes}) and the ticket's CURRENT value of
// that field has a code, the display is `ticket-<CODE>-<n>`; otherwise it is
// the stored form. Reclassifying a ticket therefore changes its segment and
// never its number, and every input form (`ticket-<n>`, `ticket-<ANY>-<n>`,
// any case) resolves by that number.
//
// The config lives on kernel.organizations, which refuses RLS reads, so it is
// always read through withPrivilegedDb (a short nested read, the privileged
// pool's purpose), whatever context the caller runs in, or on the caller's
// own privileged transaction when it passes one (privileged-read.ts).
import {
  displayTicketHandle,
  parseTicketHandleNumber,
  readTicketIdSegment,
  stripTicketHandleTags,
  type TicketIdSegment,
  type TicketSegmentFields,
  ticketIdSegmentDefault,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { onPrivilegedDb } from "~/apps/tickets/privileged-read"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { UUID_RE } from "~/lib/uuid"

type SqlClient = RlsClient | RlsTx | PrivilegedDb

export type { TicketIdSegment }
export { parseTicketHandleNumber }

/** The org's segment config ("not segmenting" when unset or malformed). */
export async function loadSegmentConfig(
  orgId: string,
  privilegedTx?: PrivilegedDb,
): Promise<TicketIdSegment> {
  // Not an org id (a unit test's synthetic "org-1"): nothing to read.
  if (!UUID_RE.test(orgId)) return { ...ticketIdSegmentDefault, codes: {} }
  return onPrivilegedDb(orgId, "tickets-id-segment", privilegedTx, async (tx) => {
    const row = extractRows<{ seg: unknown }>(
      await tx.execute(drizzleSql`
        SELECT settings->'tickets'->'idSegment' AS seg
        FROM ${kernelRel("organizations")}
        WHERE id = ${orgId}
        LIMIT 1
      `),
    )[0]
    return row ? readTicketIdSegment(row.seg) : { ...ticketIdSegmentDefault, codes: {} }
  })
}

/**
 * Store the org's segment config: the tickets `idSegment.set` tool (the web
 * settings page goes through PATCH /org instead). Its own privileged
 * transaction, as the org route's: kernel.organizations refuses RLS writes,
 * and the setting is the call's only effect. Emits the org route's update
 * event, then re-indexes the org's tickets, whose search documents carry the
 * display handle. Returns how many tickets were queued for re-indexing.
 */
export async function saveSegmentConfig(
  orgId: string,
  cfg: TicketIdSegment,
  actorId: string,
): Promise<number> {
  await withPrivilegedDb(orgId, "tickets-id-segment-set", async (tx) => {
    const row = extractRows<{ settings: unknown }>(
      await tx.execute(drizzleSql`
        UPDATE ${kernelRel("organizations")}
        SET settings = jsonb_set(
              COALESCE(settings, '{}'::jsonb),
              '{tickets}',
              COALESCE(settings->'tickets', '{}'::jsonb)
                || jsonb_build_object('idSegment', ${JSON.stringify(cfg)}::jsonb),
              true
            ),
            updated_at = now()
        WHERE id = ${orgId}
        RETURNING settings
      `),
    )[0]
    if (!row) throw new Error(`organization ${orgId} not found`)
    await tx.queueEvent({
      app: "kernel",
      entity: "org",
      action: "update",
      entityId: orgId,
      orgId,
      actorId,
      data: { settings: row.settings },
    })
  })
  return reindexTicketDocuments(orgId)
}

/** The segment fields of a raw ticket row, snake_case or camelCase. */
export function segmentFieldsOf(row: Record<string, unknown>): TicketSegmentFields {
  const s = (v: unknown): string | null => (typeof v === "string" ? v : null)
  return {
    audience: s(row.audience),
    team: s(row.team),
    categoryId: s(row.category_id ?? row.categoryId),
    sourceInboxId: s(row.source_inbox_id ?? row.sourceInboxId),
  }
}

/** The display handle of one raw row that carries `handle` and the segment
 *  fields (as every `SELECT *`/projection row does). */
export function displayHandleOfRow(row: Record<string, unknown>, cfg: TicketIdSegment): string {
  return displayTicketHandle(String(row.handle ?? ""), segmentFieldsOf(row), cfg)
}

/**
 * Display handles for a set of ticket ids, read in one query under the
 * caller's client (so a ticket the caller cannot see stays absent). The config
 * is loaded once unless the caller passes it.
 */
export async function displayHandlesByIds(
  tx: SqlClient,
  orgId: string,
  ids: string[],
  cfg?: TicketIdSegment,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))]
  if (unique.length === 0) return out
  const config = cfg ?? (await loadSegmentConfig(orgId))
  const rows = extractRows<Record<string, unknown>>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, handle, audience, team,
             category_id::text AS category_id, source_inbox_id::text AS source_inbox_id
      FROM ${ticketsRel("tickets")}
      WHERE org_id = ${orgId} AND id::text IN (${drizzleSql.join(
        unique.map((id) => drizzleSql`${id}`),
        drizzleSql`, `,
      )})
    `),
  )
  for (const r of rows) out.set(String(r.id), displayHandleOfRow(r, config))
  return out
}

/** The display handle of one ticket id, or null when it is not visible. */
export async function displayHandleFor(
  tx: SqlClient,
  orgId: string,
  ticketId: string,
  cfg?: TicketIdSegment,
): Promise<string | null> {
  return (await displayHandlesByIds(tx, orgId, [ticketId], cfg)).get(ticketId) ?? null
}

/**
 * The STORED handles a caller-supplied handle may name, best match first:
 * the value itself (lowercased, as minted: an exact match wins, which keeps a
 * handle that is not `ticket-<n>` resolving), then `ticket-<n>` for its
 * number. Null when `value` is not a ticket handle at all.
 */
export function storedHandleCandidates(value: string): string[] | null {
  const v = value.trim()
  const n = parseTicketHandleNumber(v)
  if (n === null) return null
  const exact = v.toLowerCase()
  const byNumber = `ticket-${n}`
  return exact === byNumber ? [byNumber] : [exact, byNumber]
}

/**
 * The uuid of the ticket a handle names in this org, exact stored match
 * first, then by number. Null when none.
 */
export async function lookupTicketIdByHandle(
  tx: SqlClient,
  orgId: string,
  value: string,
): Promise<string | null> {
  const candidates = storedHandleCandidates(value)
  if (!candidates) return null
  const exact = candidates[0]!
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${ticketsRel("tickets")}
      WHERE org_id = ${orgId}
        AND handle IN (${drizzleSql.join(
          candidates.map((c) => drizzleSql`${c}`),
          drizzleSql`, `,
        )})
      ORDER BY (handle = ${exact}) DESC
      LIMIT 1
    `),
  )
  return rows[0]?.id ?? null
}

/**
 * The CURRENT display handle for each handle form in `refs` (`ticket-1`,
 * `ticket-B2B-1`, any case), keyed by the input string: one config read and
 * one query for the whole set, exact stored match first, then by number. A
 * ref naming no ticket the caller can see is absent from the map.
 */
export async function currentDisplayHandlesForRefs(
  tx: SqlClient,
  orgId: string,
  refs: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const wanted = new Map<string, string[]>()
  for (const ref of new Set(refs)) {
    const candidates = typeof ref === "string" ? storedHandleCandidates(ref) : null
    if (candidates) wanted.set(ref, candidates)
  }
  if (wanted.size === 0) return out
  const all = [...new Set([...wanted.values()].flat())]
  const cfg = await loadSegmentConfig(orgId)
  const rows = extractRows<Record<string, unknown>>(
    await tx.execute(drizzleSql`
      SELECT handle, audience, team,
             category_id::text AS category_id, source_inbox_id::text AS source_inbox_id
      FROM ${ticketsRel("tickets")}
      WHERE org_id = ${orgId} AND handle IN (${drizzleSql.join(
        all.map((h) => drizzleSql`${h}`),
        drizzleSql`, `,
      )})
    `),
  )
  const byStored = new Map(rows.map((r) => [String(r.handle), r] as const))
  for (const [ref, candidates] of wanted) {
    const row = candidates.map((c) => byStored.get(c)).find((r) => r !== undefined)
    if (row) out.set(ref, displayHandleOfRow(row, cfg))
  }
  return out
}

/** Strip every `[#ticket-<n>]` / `[#ticket-<SEG>-<n>]` tag naming the same
 *  ticket number (shared, so render.ts stays free of DB imports). */
export const stripHandleTags = stripTicketHandleTags

/**
 * Carry a team's segment code across a team rename (teams.ts renameTeam).
 * Only when the org segments by team (codes are keyed by the team NAME).
 * Onto a name that already has a code: the target keeps its code and the
 * source's is dropped (codes stay unique). Otherwise the code moves.
 *
 * Runs on the RENAME'S OWN transaction, so the code move commits with the
 * rename and rolls back with it: on a separate privileged connection it
 * committed on its own, and a rename that failed afterwards still moved the
 * code. `kernel.organizations` refuses RLS writes (A3) and a request
 * transaction cannot elevate, so the move is
 * `kernel.tickets_move_team_segment_code` (migration 0178), a SECURITY DEFINER
 * function that edits only the codes of the transaction's org, keyed as
 * `readTicketIdSegment` reads them.
 */
export async function moveTeamSegmentCode(
  tx: SqlClient,
  orgId: string,
  from: string,
  to: string,
): Promise<void> {
  await tx.execute(
    drizzleSql`SELECT ${kernelRel("tickets_move_team_segment_code")}(${orgId}::uuid, ${from}, ${to})`,
  )
}

/**
 * Replace each row's stored `handle` by its display handle, keyed by the
 * ticket id `idOf` returns. One config read; when the org does not segment,
 * the rows come back untouched with no further query.
 */
export async function applyDisplayHandles<T extends { handle: string }>(
  tx: SqlClient,
  orgId: string,
  rows: T[],
  idOf: (row: T) => string,
): Promise<T[]> {
  if (rows.length === 0) return rows
  const cfg = await loadSegmentConfig(orgId)
  if (cfg.by === "none") return rows
  const map = await displayHandlesByIds(tx, orgId, rows.map(idOf), cfg)
  return rows.map((r) => ({ ...r, handle: map.get(idOf(r)) ?? r.handle }))
}

/**
 * Re-index ticket search documents whose DISPLAY handle may have changed
 * without an entity event: every ticket of the org when the id-segment
 * setting changes, or the given ids (an inbox move). Enqueued, never inline.
 */
export async function reindexTicketDocuments(orgId: string, ticketIds?: string[]): Promise<number> {
  const ids =
    ticketIds ??
    (await withPrivilegedDb(orgId, "tickets-id-segment-reindex", async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id FROM ${ticketsRel("tickets")} WHERE org_id = ${orgId}
        `),
      ).map((r) => r.id),
    ))
  const { enqueueIndexerUpsert } = await import("~/modules/search/indexer")
  const eventId = `id-segment-${Date.now()}`
  for (const id of ids) await enqueueIndexerUpsert(orgId, "tickets", "ticket", id, eventId)
  return ids.length
}
