// SPDX-License-Identifier: FSL-1.1-ALv2
// Audience — is the person on the other side a PARTNER or an END CUSTOMER.
//
// `team` says WHICH shopping centre a ticket belongs to. `audience` says which
// side of it wrote. The two are independent, and that is not a design opinion:
// measured on the migrated corpus 2026-07-30, the same centre carries tickets
// of both kinds — `B'EST` 231 b2b / 207 b2c, `La Vache Noire` 6 / 406,
// `Place des Halles` 13 / 191. One field cannot answer both questions, which is
// why this one exists rather than a convention inside `team`.
//
// WHY AN ENUM AND NOT FREE TEXT
//
// `team` is free text, and that produced sixteen near-duplicate labels the
// database was happy to accept (`Okabé` vs `SGM - Okabé`, `SOLARIS` vs
// `Solaris Center`), splitting desks' history until someone noticed and merged
// them by hand. This set is closed and always will be: two values, enforced by
// a CHECK constraint, so the eleventh spelling is impossible rather than merely
// discouraged.
//
// NULL IS A REAL STATE, NOT A GAP TO FILL
//
// Mail arriving at the shared address carries nothing that says which side sent
// it. An unclassified ticket must stay visibly unclassified and be triaged,
// exactly like an unrouted one — guessing is how a partner's escalation ends up
// filed as a member complaint.
import { sql as drizzleSql } from "drizzle-orm"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"

type SqlClient = RlsClient | RlsTx | PrivilegedDb

/** The closed set. Mirrors the manifest enum on `tickets.audience`. */
export const AUDIENCES = ["b2b", "b2c"] as const
export type Audience = (typeof AUDIENCES)[number]

export function isAudience(v: unknown): v is Audience {
  return typeof v === "string" && (AUDIENCES as readonly string[]).includes(v)
}

export interface AudienceError {
  error: { code: "invalid_params" | "not_found"; message: string; retryable: false }
}

/**
 * Set (or clear) one ticket's audience. `null` clears — see the NULL note above.
 */
export async function setAudience(
  tx: SqlClient,
  orgId: string,
  ticketId: string,
  audience: Audience | null,
): Promise<{ ticketId: string; audience: Audience | null } | AudienceError> {
  if (audience !== null && !isAudience(audience)) {
    return {
      error: {
        code: "invalid_params",
        message: `audience must be one of ${AUDIENCES.join(", ")}, or null to clear`,
        retryable: false,
      },
    }
  }
  const updated = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("tickets")}
      SET audience = ${audience}, updated_at = now()
      WHERE id = ${ticketId}::uuid AND org_id = ${orgId}
      RETURNING id
    `),
  )
  if (updated.length === 0) {
    return { error: { code: "not_found", message: "ticket not visible", retryable: false } }
  }
  return { ticketId, audience }
}

export interface AudienceCount {
  audience: Audience | null
  count: number
}

/** How the org's tickets currently split. `null` is included on purpose: the
 *  size of the unclassified pile is the number worth watching. */
export async function audienceBreakdown(tx: SqlClient, orgId: string): Promise<AudienceCount[]> {
  const rows = extractRows<{ audience: string | null; n: string }>(
    await tx.execute(drizzleSql`
      SELECT audience, COUNT(*) AS n
      FROM ${ticketsRel("tickets")}
      WHERE org_id = ${orgId}
      GROUP BY audience
      ORDER BY audience NULLS LAST
    `),
  )
  return rows.map((r) => ({
    audience: (r.audience as Audience | null) ?? null,
    count: Number(r.n),
  }))
}

export interface BackfillResult {
  b2b: number
  b2c: number
  /** Left null — nothing in the row said which side wrote. */
  unclassified: number
  dryRun: boolean
}

/**
 * Classify the migrated corpus from its JSM key.
 *
 * The importer preserved the source desk in `external_ref` (`TPSD-1234`,
 * `LVN-56`, …). TPSD is the B2B partner desk; every other desk is an
 * end-customer one. That mapping is the migration's own record of where each
 * ticket came from, so it is evidence rather than inference — and it is the
 * only signal available, since the corpus predates this field entirely.
 *
 * Deliberately narrow: it only ever fills rows that are still NULL, so it can
 * be re-run safely and can never overwrite a human's correction. Tickets with
 * no `external_ref` (created in Liaison, or arriving by mail) are left alone —
 * their side is genuinely unknown.
 */
export async function backfillAudienceFromExternalRef(
  tx: SqlClient,
  orgId: string,
  opts: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const b2bPredicate = drizzleSql`external_ref LIKE 'TPSD-%'`
  const b2cPredicate = drizzleSql`external_ref IS NOT NULL AND external_ref NOT LIKE 'TPSD-%'`

  if (opts.dryRun) {
    const [row] = extractRows<{ b2b: string; b2c: string; rest: string }>(
      await tx.execute(drizzleSql`
        SELECT
          COUNT(*) FILTER (WHERE ${b2bPredicate}) AS b2b,
          COUNT(*) FILTER (WHERE ${b2cPredicate}) AS b2c,
          COUNT(*) FILTER (WHERE external_ref IS NULL) AS rest
        FROM ${ticketsRel("tickets")}
        WHERE org_id = ${orgId} AND audience IS NULL
      `),
    )
    return {
      b2b: Number(row?.b2b ?? 0),
      b2c: Number(row?.b2c ?? 0),
      unclassified: Number(row?.rest ?? 0),
      dryRun: true,
    }
  }

  const b2b = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("tickets")} SET audience = 'b2b', updated_at = now()
      WHERE org_id = ${orgId} AND audience IS NULL AND ${b2bPredicate}
      RETURNING id
    `),
  ).length
  const b2c = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("tickets")} SET audience = 'b2c', updated_at = now()
      WHERE org_id = ${orgId} AND audience IS NULL AND ${b2cPredicate}
      RETURNING id
    `),
  ).length
  const [rest] = extractRows<{ n: string }>(
    await tx.execute(drizzleSql`
      SELECT COUNT(*) AS n FROM ${ticketsRel("tickets")}
      WHERE org_id = ${orgId} AND audience IS NULL
    `),
  )
  return { b2b, b2c, unclassified: Number(rest?.n ?? 0), dryRun: false }
}
