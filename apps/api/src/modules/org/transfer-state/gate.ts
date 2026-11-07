// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The refusals of an org that is moving (state.ts), one per kind of entry point:
//  - a request of the org (authMiddleware, the MCP middleware): `draining`
//    refuses the routes that start an agent turn; `frozen` refuses every
//    mutating method and serves reads; `incoming` and `moved` refuse
//    everything. The refusal is 503 `{ error: { code: "org_moving",
//    retryAfterSeconds } }` with `Retry-After`.
//  - an inbound webhook or an OAuth callback (unauthenticated, keyed by the
//    org id): refused (503, the provider retries) unless `draining`.
//  - an agent turn started by anything else (a mention, a reminder, an
//    approval result): refused unless `draining`, whose drain waits for it.
// Jobs and outbox events are not refused here: the dispatch defers them
// (infra/jobs/jobs.ts, infra/events/outbox-worker.ts).
//
// Nothing changes for an org that is not moving: one Map lookup in a snapshot
// refreshed at most once a second per process.

import { ORG_MOVING_CODE, ORG_MOVING_RETRY_AFTER_SECONDS } from "@liaison/shared"
import { HTTPException } from "hono/http-exception"
import { rootLogger } from "~/lib/logger"
import {
  beginOrgActivity,
  type OrgTransferRecord,
  type OrgTransferState,
  orgTransferStateOf,
  refusesReads,
  refusesWrites,
} from "./state"

const log = rootLogger.child({ module: "org-transfer-gate" })

/** The 503 of a moving org; the body is `{ error: OrgMovingError }`. */
export class OrgMovingError extends HTTPException {
  readonly code = ORG_MOVING_CODE
  readonly errorFields = { retryAfterSeconds: ORG_MOVING_RETRY_AFTER_SECONDS }
  /** Read by the error handler: sent as `Retry-After`. */
  readonly retryAfterSeconds = ORG_MOVING_RETRY_AFTER_SECONDS
  constructor(readonly state: OrgTransferState) {
    super(503, { message: "This workspace is moving to another server. Retry in a few seconds." })
  }
}

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"])

export function isMutatingMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase())
}

/**
 * The routes that start an agent turn from a request: the agent panel's chat,
 * a thread message (which may mention an agent), a new thread or DM (which
 * may carry the first message). Refused while the org drains so its live
 * turns run down.
 */
export function startsAgentTurn(method: string, path: string): boolean {
  if (method.toUpperCase() !== "POST") return false
  if (path === "/api/agent/chat") return true
  if (path === "/api/threads" || path === "/api/threads/" || path === "/api/threads/dm") return true
  return /^\/api\/threads\/[^/]+\/messages\/?$/.test(path)
}

/** Whether a request of an org in `record` is refused. */
export function requestRefused(
  record: OrgTransferRecord | null,
  method: string,
  path: string,
): boolean {
  if (record === null) return false
  if (refusesReads(record.state)) return true
  if (refusesWrites(record.state)) return isMutatingMethod(method)
  return startsAgentTurn(method, path)
}

/** The request gate (authMiddleware, MCP): throws `OrgMovingError` when refused. */
export async function assertOrgRequestAllowed(
  orgId: string,
  method: string,
  path: string,
): Promise<void> {
  const record = await orgTransferStateOf(orgId)
  if (!requestRefused(record, method, path)) return
  log.info({ orgId, state: record!.state, method, path }, "request refused: the org is moving")
  throw new OrgMovingError(record!.state)
}

/**
 * A write that reaches the org without a session (an inbound webhook, an OAuth
 * callback, a public form): throws `OrgMovingError` unless the org is not
 * moving or only draining.
 */
export async function assertOrgAcceptsWrites(orgId: string): Promise<void> {
  const record = await orgTransferStateOf(orgId)
  if (record === null || !refusesWrites(record.state)) return
  log.info({ orgId, state: record.state }, "write refused: the org is moving")
  throw new OrgMovingError(record.state)
}

/**
 * Run a write of the org as live work: counted first (a freeze landing meanwhile
 * sees it in the quiesce), then refused with `OrgMovingError` while the org is
 * frozen, incoming or moved.
 */
export async function withOrgWrite<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  const end = beginOrgActivity(orgId, "writes")
  try {
    await assertOrgAcceptsWrites(orgId)
    return await fn()
  } finally {
    end()
  }
}

/**
 * An agent turn about to start (any path): refused once the org is frozen,
 * incoming or moved. A draining org still runs it (its drain waits for it).
 */
export async function assertOrgStartsTurns(orgId: string): Promise<void> {
  await assertOrgAcceptsWrites(orgId)
}
