// SPDX-License-Identifier: FSL-1.1-ALv2
import { lookupTicketIdByHandle, storedHandleCandidates } from "~/apps/tickets/display-handle"
import type { PrivilegedDb, RlsClient, RlsTx } from "~/db"
import { UUID_RE } from "~/lib/uuid"

type SqlClient = RlsClient | RlsTx | PrivilegedDb

/** The tool-error shape every tickets surface already returns. */
export type TicketRefError = { code: string; message: string; retryable: boolean }

export type TicketRefResult = { ok: true; ticketId: string } | { ok: false; error: TicketRefError }
/** The canonical (lowercase) handle when `value` is a ticket handle in any
 *  display form (`ticket-<n>`, `ticket-<SEG>-<n>`, any case), else null.
 *  Resolution goes by the NUMBER (display-handle.ts), so a stale segment
 *  still finds its ticket. */
export function asTicketHandle(value: string): string | null {
  return storedHandleCandidates(value) ? value.trim().toLowerCase() : null
}

/**
 * Turn whatever a caller passed as `ticketId` into the row's uuid.
 *
 * Every tickets query binds the id straight into a `uuid` column, so a handle
 * (`ticket-123`) reached Postgres as `invalid input syntax for type uuid` and
 * surfaced as a 500 plus an error-level log rather than a tool error. Agents
 * only ever SEE the handle, so both forms are accepted here and anything that
 * is neither is refused as `invalid_params` before it can reach the driver.
 *
 * Handle lookups are scoped by org_id (and run under the caller's RLS client),
 * so a handle can never resolve across an org boundary.
 */
export async function resolveTicketRef(
  tx: SqlClient,
  orgId: string,
  raw: unknown,
): Promise<TicketRefResult> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      ok: false,
      error: { code: "invalid_params", message: "ticketId required", retryable: false },
    }
  }
  const value = raw.trim()
  if (UUID_RE.test(value)) return { ok: true, ticketId: value }
  const handle = asTicketHandle(value)
  if (!handle) {
    return {
      ok: false,
      error: {
        code: "invalid_params",
        message: `ticketId must be a ticket uuid or a ticket handle (ticket-<number> or ticket-<CODE>-<number>), got: ${value}`,
        retryable: false,
      },
    }
  }
  // Exact stored match first (a handle that is not `ticket-<n>` keeps
  // resolving), then by number: `ticket-B2C-12` finds the ticket stored as
  // `ticket-12` whatever its segment is now.
  const id = await lookupTicketIdByHandle(tx, orgId, handle)
  if (!id) {
    return {
      ok: false,
      error: { code: "not_found", message: `no ticket with handle ${value}`, retryable: false },
    }
  }
  return { ok: true, ticketId: id }
}

/** Same contract for a plain uuid param (messageId and friends): refuse a
 *  non-uuid with a typed error instead of letting the driver throw. */
export function requireUuid(raw: unknown, name: string): TicketRefResult {
  if (typeof raw === "string" && UUID_RE.test(raw.trim())) {
    return { ok: true, ticketId: raw.trim() }
  }
  return {
    ok: false,
    error: { code: "invalid_params", message: `${name} must be a uuid`, retryable: false },
  }
}
