// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The end of a managed subscription, enforced on the cell from the billing
// status Control pushes (spec S26, A10, A43, D17, D24). Managed edition only:
// every function returns at once on a self-hosted instance (billing-status.ts
// answers null without a query).
//
//  - `past_due` (first failed renewal, D17): metered usage on the platform key
//    is refused with 402 `payment_required` (`assertPaymentNotRequired`); the
//    rest of the app stays usable.
//  - `suspended` with `accessUntil` ahead: an org admin's SESSION may sign in,
//    refresh, read itself, use Billing and the export routes
//    (`SUSPENDED_ADMIN_PATHS`); every other request of the org, members always,
//    every agent, MCP, device-flow or websocket credential, and an admin
//    session on a host that is not the org's own, get 403 `org_suspended`
//    `{code, accessUntil, contact}`. A live socket closes with
//    ORG_SUSPENDED_WS_CLOSE.
//  - `closed`, or `suspended` past `accessUntil`: every user credential is
//    refused, admins included.
//
// The gate applies to user credentials only (P3R-8): the signed `/api/cloud/*`
// calls, `/health`, `/diag`, `/webhooks/_cell/*` never pass through it. The
// public tickets routes (create, attachments, CSAT) answer the same 403
// (`assertOrgTakesPublicWrites`). Provider webhooks are answered 200 and
// dropped (webhooks/routes.ts), org jobs are
// skipped with their schedulers kept (infra/jobs/jobs.ts), both through
// `orgSuspendedOrClosed` (billing-status.ts).
//
// The sites mirror the demo-expiry enforcement (modules/demo/demo-expiry.ts):
// `authMiddleware`, `createSession` (sign-in and refresh), the websocket ticket
// and re-check, and the MCP token mint, refresh and resolve.

import {
  ORG_SUSPENDED_CODE,
  ORG_SUSPENDED_WS_CLOSE,
  type OrgSuspendedError as OrgSuspendedBody,
  PAYMENT_REQUIRED_CODE,
} from "@liaison/shared"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { rootLogger } from "~/lib/logger"
import { requestHostBinding } from "~/lib/org-host"
import { hasScope } from "~/modules/permissions/permissions"
import { type OrgBillingStatus, orgBillingStatus, paymentRequiredFor } from "./billing-status"

const log = rootLogger.child({ module: "cloud-suspension" })

/** The scope that makes a session an org admin for the suspension gate. */
export const SUSPENDED_ADMIN_SCOPE = "kernel:org:admin"

/** What a status leaves of the org: everything, admins' export and Billing, or nothing. */
export type OrgAccess = "served" | "admins" | "refused"

export function orgAccessOf(status: OrgBillingStatus | null, now = Date.now()): OrgAccess {
  if (status === null) return "served"
  if (status.status === "closed") return "refused"
  if (status.status !== "suspended") return "served"
  // A Control that sent no date leaves the admins their window (fail toward export).
  if (status.accessUntil === null) return "admins"
  return now < Date.parse(status.accessUntil) ? "admins" : "refused"
}

/** The org's access now; "served" on a self-hosted instance (no query). */
export async function orgAccess(orgId: string): Promise<OrgAccess> {
  return orgAccessOf(await orgBillingStatus(orgId))
}

/** The 403 of a suspended or closed org; the body is `{ error: OrgSuspendedError }`. */
export class OrgSuspendedError extends HTTPException {
  readonly code = ORG_SUSPENDED_CODE
  readonly errorFields: Pick<OrgSuspendedBody, "accessUntil" | "contact">
  constructor(status: OrgBillingStatus | null) {
    super(403, { message: "This workspace is suspended." })
    const refused = orgAccessOf(status) === "refused"
    this.errorFields = {
      accessUntil: refused ? null : (status?.accessUntil ?? null),
      contact: status?.contact ?? null,
    }
  }
}

/** The 402 of metered usage while the org is past due, suspended or closed (D17). */
export class PaymentRequiredError extends Error {
  readonly status = 402
  readonly code = PAYMENT_REQUIRED_CODE
  constructor() {
    super("Usage is paused until the open invoice is paid. An admin can pay it in Billing.")
    this.name = "PaymentRequiredError"
  }
}

/**
 * Throws `PaymentRequiredError` when the org's metered managed usage is
 * refused (D17). A no-op, without a query, on a self-hosted instance.
 */
export async function assertPaymentNotRequired(orgId: string): Promise<void> {
  if (paymentRequiredFor(await orgBillingStatus(orgId))) throw new PaymentRequiredError()
}

/** Whether the org's metered managed usage is refused now (D17). */
export async function paymentRequired(orgId: string): Promise<boolean> {
  return paymentRequiredFor(await orgBillingStatus(orgId))
}

/**
 * The routes an admin session of a suspended org keeps (spec S26): reading
 * itself, the second factor, Billing, the billing state and the exports.
 * Anything else, the websocket ticket included, is refused.
 */
export function isSuspendedAdminPath(method: string, path: string): boolean {
  const under = (p: string) => path === p || path.startsWith(`${p}/`)
  if (under("/api/billing/managed")) return true
  if (under("/api/org/export")) return true
  if (under("/api/export")) return true
  if (under("/api/auth/totp")) return true
  const read = method === "GET" || method === "HEAD"
  if (read && under("/api/billing/state")) return true
  if (read && path === "/api/users/me") return true
  return false
}

export interface GateCredential {
  orgId: string
  scopes: readonly string[]
  /** An agent's token (never an admin session). */
  agentId?: string
  /** A device-flow session (an API client, never an admin session). */
  restricted?: boolean
}

/**
 * The gate of `authMiddleware`: 403 `org_suspended` unless the org is served,
 * or it is suspended within its window and this is an admin's own session on
 * the org's own host asking for an admin path.
 */
export async function assertOrgServable(c: Context, cred: GateCredential): Promise<void> {
  const status = await orgBillingStatus(cred.orgId)
  const access = orgAccessOf(status)
  if (access === "served") return
  if (
    access === "admins" &&
    !cred.agentId &&
    !cred.restricted &&
    hasScope(SUSPENDED_ADMIN_SCOPE, [...cred.scopes]) &&
    requestHostBinding(c).kind !== "non-org" &&
    isSuspendedAdminPath(c.req.method, c.req.path)
  ) {
    return
  }
  log.info(
    { orgId: cred.orgId, status: status?.status, path: c.req.path },
    "request refused: the org is suspended",
  )
  throw new OrgSuspendedError(status)
}

/**
 * The gate of `createSession` (every sign-in and refresh): an admin may sign in
 * while the org is suspended within its window; nobody once it is refused.
 */
export async function assertOrgSessionAllowed(orgId: string, isAdmin: boolean): Promise<void> {
  const status = await orgBillingStatus(orgId)
  const access = orgAccessOf(status)
  if (access === "served" || (access === "admins" && isAdmin)) return
  log.info({ orgId, status: status?.status }, "sign-in refused: the org is suspended")
  throw new OrgSuspendedError(status)
}

/**
 * The org's unauthenticated public surfaces (the tickets form's create,
 * attachment and survey calls): 403 `org_suspended` while the org is suspended
 * or closed, any part of the window, as the authenticated routes answer.
 */
export async function assertOrgTakesPublicWrites(orgId: string): Promise<void> {
  const status = await orgBillingStatus(orgId)
  if (orgAccessOf(status) === "served") return
  log.info({ orgId, status: status?.status }, "public request refused: the org is suspended")
  throw new OrgSuspendedError(status)
}

/**
 * For credentials that are never an admin's session (websocket, MCP): whether
 * the org refuses them now, i.e. it is suspended or closed.
 */
export async function orgRefusesNonSessionCredentials(orgId: string): Promise<boolean> {
  return (await orgAccess(orgId)) !== "served"
}

/** The websocket close of a suspended org. */
export const ORG_SUSPENDED_CLOSE = { code: ORG_SUSPENDED_WS_CLOSE, reason: ORG_SUSPENDED_CODE }
