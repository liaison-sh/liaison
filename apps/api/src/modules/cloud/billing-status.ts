// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org's billing status as the control plane last pushed it (managed
// edition): what the suspension gate (suspension.ts) and the metered-usage
// refusal (payment-required.ts) read on every request, job and paid call.
//
// A short per-process cache: the push handler of this process drops the org's
// entry once its push commits (billing.ts), every other process sees the new
// status within STATUS_TTL_MS. A self-hosted instance answers null without a
// query, so nothing here costs it anything.

import type { CloudBillingStatus } from "@liaison/control-plane-contract"
import { eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { orgBillingState } from "~/db/schema/kernel"
import { isManagedEdition } from "~/lib/edition"

export interface OrgBillingStatus {
  status: CloudBillingStatus
  /** While suspended: until when admins keep export and Billing (ISO). */
  accessUntil: string | null
  /** When the control plane closed the org (ISO). */
  closedAt: string | null
  /** The address the suspended page shows; null when Control sent none. */
  contact: string | null
}

/** How long another process may serve a status the push changed. */
export const STATUS_TTL_MS = 5_000

const cache = new Map<string, { at: number; value: OrgBillingStatus | null }>()

/**
 * The org's pushed billing status, or null: on a self-hosted instance (no
 * query), and before the first push (an org Control has not billed yet is served).
 */
export async function orgBillingStatus(orgId: string): Promise<OrgBillingStatus | null> {
  if (!isManagedEdition()) return null
  const hit = cache.get(orgId)
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value
  const [row] = await withPrivilegedDb(orgId, "billing-status-read", (tx) =>
    tx
      .select({
        status: orgBillingState.status,
        accessUntil: orgBillingState.accessUntil,
        closedAt: orgBillingState.closedAt,
        contact: orgBillingState.billingContact,
      })
      .from(orgBillingState)
      .where(eq(orgBillingState.orgId, orgId))
      .limit(1),
  )
  const value: OrgBillingStatus | null = row
    ? {
        status: row.status as CloudBillingStatus,
        accessUntil: row.accessUntil ? row.accessUntil.toISOString() : null,
        closedAt: row.closedAt ? row.closedAt.toISOString() : null,
        contact: row.contact,
      }
    : null
  if (cache.size > 10_000) cache.clear()
  cache.set(orgId, { at: Date.now(), value })
  return value
}

/** Drop one org's cached status (its push committed in this process). */
export function invalidateOrgBillingStatus(orgId: string): void {
  cache.delete(orgId)
}

/** Drop every cached status (tests). */
export function clearOrgBillingStatusCache(): void {
  cache.clear()
}

/** Metered managed usage is refused in these statuses. */
export function paymentRequiredFor(status: OrgBillingStatus | null): boolean {
  return (
    status !== null &&
    (status.status === "past_due" || status.status === "suspended" || status.status === "closed")
  )
}

/**
 * Suspended or closed (any part of the window): the org's jobs are skipped and
 * its webhooks dropped. False, without a query, on a self-hosted instance.
 */
export async function orgSuspendedOrClosed(orgId: string): Promise<boolean> {
  const s = await orgBillingStatus(orgId)
  return s !== null && (s.status === "suspended" || s.status === "closed")
}
