// SPDX-License-Identifier: FSL-1.1-ALv2
// Teams — the ticket `team` column as a first-class, browsable dimension.
//
// `team` is free text on the ticket, set by whoever files it: an inbox's
// default_team, an API caller's `team` field, or a human in the composer. There
// is no teams TABLE, so "which teams exist" can only ever be answered by asking
// the tickets themselves. That single fact drives everything here.
//
// WHY THIS FILE EXISTS AT ALL
//
// Two callers already needed the same answer and were about to compute it two
// ways: backlogHealth validates its `team` filter against the live set (a bad
// filter must fail loudly rather than return an authoritative-looking zero), and
// the inbox filter bar has to populate a menu. Two DISTINCT queries would drift
// the moment one grew a predicate — a team offered in the menu but rejected by
// the aggregate is worse than no menu at all. `listTeams` is the one answer.
//
// FREE TEXT MEANS TYPOS ARE STRUCTURAL, NOT EXCEPTIONAL
//
// Nothing constrains the string, so a desk accumulates near-duplicates the way
// any free-text dimension does: a leading space, a case difference, a prefix one
// integration adds and another doesn't. Each variant silently splits a team's
// history in two. `renameTeam` is the repair — org-wide, one statement, and it
// deliberately ALLOWS renaming onto an existing team, because merging two
// spellings is the common case, not an error to guard against.
import { sql as drizzleSql } from "drizzle-orm"
import { moveTeamSegmentCode } from "~/apps/tickets/display-handle"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"

type SqlClient = RlsClient | RlsTx | PrivilegedDb

export interface TeamRow {
  team: string
  /** Tickets not closed and not merged away — what a person would call "live". */
  openCount: number
  /** Every ticket ever tagged with this team, closed included. */
  totalCount: number
}

export interface RenameTeamInput {
  from: string
  to: string
  /** Count what would change and change nothing. */
  dryRun?: boolean
}

export interface RenameTeamResult {
  from: string
  to: string
  ticketsUpdated: number
  /** Inboxes whose default_team pointed at the old name and now points at the new. */
  inboxDefaultsUpdated: number
  /** True when `to` already existed, i.e. this was a merge rather than a rename. */
  merged: boolean
  dryRun: boolean
}

export interface TeamsError {
  error: {
    code: "unknown_team" | "invalid_params" | "not_found"
    message: string
    retryable: false
  }
}

/**
 * Every team that appears on this org's tickets, with live and lifetime counts.
 *
 * Runs under the caller's RLS context, so it lists the teams the caller can
 * actually SEE. For a user scoped by the `tickets:team` dimension that is a
 * strict subset, which is the point: the filter menu must never advertise a
 * team whose tickets would come back empty.
 *
 * Ordered by name so the menu is stable between reloads.
 */
export async function listTeams(tx: SqlClient, orgId: string): Promise<TeamRow[]> {
  const rows = extractRows<{ team: string; open_count: string; total_count: string }>(
    await tx.execute(drizzleSql`
      SELECT team,
             COUNT(*) FILTER (
               WHERE status <> 'closed' AND merged_into_ticket_id IS NULL
             ) AS open_count,
             COUNT(*) AS total_count
      FROM ${ticketsRel("tickets")}
      WHERE org_id = ${orgId} AND team IS NOT NULL AND team <> ''
      GROUP BY team
      ORDER BY team ASC
    `),
  )
  return rows.map((r) => ({
    team: r.team,
    openCount: Number(r.open_count),
    totalCount: Number(r.total_count),
  }))
}

/** The names alone — what a validator needs. */
export async function listTeamNames(tx: SqlClient, orgId: string): Promise<string[]> {
  return (await listTeams(tx, orgId)).map((t) => t.team)
}

/**
 * Rename a team across every ticket in the org, and re-point any inbox whose
 * `default_team` used the old name so new arrivals don't recreate it.
 *
 * `from` is matched EXACTLY, never trimmed or case-folded. Repairing a team
 * whose name is `" Acme"` means passing that leading space, and the caller
 * needs the failure when they don't — a fuzzy match here would silently rename
 * the wrong team, which is unrecoverable without a backup.
 *
 * Renaming onto a name that already exists MERGES the two. That is allowed on
 * purpose: near-duplicate spellings are exactly what this repairs.
 */
export async function renameTeam(
  tx: SqlClient,
  orgId: string,
  input: RenameTeamInput,
): Promise<RenameTeamResult | TeamsError> {
  const from = typeof input.from === "string" ? input.from : ""
  // `to` is trimmed: a rename whose TARGET has stray whitespace just creates the
  // next thing someone has to repair. `from` is never trimmed (see above).
  const to = typeof input.to === "string" ? input.to.trim() : ""
  if (from.length === 0 || to.length === 0) {
    return {
      error: {
        code: "invalid_params",
        message: "Both `from` and `to` are required, and `to` cannot be blank.",
        retryable: false,
      },
    }
  }
  if (from === to) {
    return {
      error: {
        code: "invalid_params",
        message: `\`from\` and \`to\` are both "${from}" — nothing to rename.`,
        retryable: false,
      },
    }
  }

  const known = await listTeamNames(tx, orgId)
  if (!known.includes(from)) {
    // Exact-match failure is the likeliest way to call this wrong, so name the
    // candidates instead of reporting an empty rename as success. Whitespace is
    // invisible in an error message, hence the JSON quoting.
    const near = known.filter((k) => k.trim().toLowerCase() === from.trim().toLowerCase())
    const hint =
      near.length > 0
        ? ` Did you mean ${near.map((n) => JSON.stringify(n)).join(" or ")}? Names are matched exactly, including spaces and case.`
        : ` Known teams: ${known.map((n) => JSON.stringify(n)).join(", ") || "(none)"}.`
    return {
      error: {
        code: "unknown_team",
        message: `No tickets carry the team ${JSON.stringify(from)}.${hint}`,
        retryable: false,
      },
    }
  }
  const merged = known.includes(to)

  if (input.dryRun) {
    const [counts] = extractRows<{ tickets: string; inboxes: string }>(
      await tx.execute(drizzleSql`
        SELECT
          (SELECT COUNT(*) FROM ${ticketsRel("tickets")}
            WHERE org_id = ${orgId} AND team = ${from}) AS tickets,
          (SELECT COUNT(*) FROM ${ticketsRel("inboxes")}
            WHERE org_id = ${orgId} AND default_team = ${from}) AS inboxes
      `),
    )
    return {
      from,
      to,
      ticketsUpdated: Number(counts?.tickets ?? 0),
      inboxDefaultsUpdated: Number(counts?.inboxes ?? 0),
      merged,
      dryRun: true,
    }
  }

  const updatedTickets = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("tickets")}
      SET team = ${to}, updated_at = now()
      WHERE org_id = ${orgId} AND team = ${from}
      RETURNING id
    `),
  )
  const updatedInboxes = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("inboxes")}
      SET default_team = ${to}
      WHERE org_id = ${orgId} AND default_team = ${from}
      RETURNING id
    `),
  )

  // A ticket id segmented by team (`ticket-OPS-12`) keeps its code under the
  // new name. On THIS transaction, so the code moves only if the rename
  // commits (organizations refuse RLS writes: a SECURITY DEFINER function).
  await moveTeamSegmentCode(tx, orgId, from, to)

  return {
    from,
    to,
    ticketsUpdated: updatedTickets.length,
    inboxDefaultsUpdated: updatedInboxes.length,
    merged,
    dryRun: false,
  }
}

/**
 * Set (or clear) one ticket's team. The per-ticket half of the dimension, and
 * the tool the generic bulk machinery dispatches per item.
 *
 * The value is free text by design — a team is whatever the org calls it, and
 * requiring pre-registration would mean a new desk cannot file its first
 * ticket. It IS trimmed, because trailing whitespace is never intended and is
 * exactly how the near-duplicates renameTeam repairs get created.
 */
export async function setTeam(
  tx: SqlClient,
  orgId: string,
  ticketId: string,
  team: string | null,
): Promise<{ ticketId: string; team: string | null } | TeamsError> {
  const next = typeof team === "string" && team.trim().length > 0 ? team.trim() : null
  const updated = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("tickets")}
      SET team = ${next}, updated_at = now()
      WHERE id = ${ticketId}::uuid AND org_id = ${orgId}
      RETURNING id
    `),
  )
  if (updated.length === 0) {
    return {
      error: { code: "not_found", message: "ticket not visible", retryable: false },
    }
  }
  return { ticketId, team: next }
}
