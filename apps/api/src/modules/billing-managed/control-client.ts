// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The synchronous cell→control-plane call behind the managed Billing page
// (spec S17): one signed v2 message to the control plane's `cell-billing`
// webhook, answered in the same request.
//
// The message is signed with this server's provisioned instance key (the same
// identity the outbox uses, modules/liaison-team/identity.ts) and carries the
// browser's request id, which the control plane uses as its idempotency key:
// the same id sent twice gets the first outcome back, never a second charge.
// Anything but a well-formed reply (no identity, no endpoint, network error,
// timeout, a non-200, a body that is not the type's reply) is
// `BillingUnavailableError`, which the routes answer as 503
// `billing_unavailable`. A refusal the control plane chose (`{ok:false, code}`)
// is a reply, returned as is.

import { randomUUID } from "node:crypto"
import {
  CELL_BILLING_ENDPOINT,
  type CellBillingData,
  type CellBillingMessageType,
  type CellBillingReply,
  cellBillingMessageSchemas,
  cellBillingReplySchemas,
  INSTANCE_HEADER,
  SIGNATURE_HEADER,
} from "@liaison/control-plane-contract"
import { signBody } from "@liaison/control-plane-contract/node"
import { withSystemDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { decryptInstanceKey, readIdentity } from "~/modules/liaison-team/identity"
import { liaisonTeamEndpoint } from "~/modules/liaison-team/outbox"

/** A billing call waits at most this long (a payment confirmation included). */
export const BILLING_CALL_TIMEOUT_MS = 20_000
/** The biggest reply read (an invoice PDF in base64 sits under it). */
const MAX_REPLY_BYTES = 16 * 1024 * 1024

export class BillingUnavailableError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "BillingUnavailableError"
  }
}

export interface BillingCallOptions {
  fetch?: typeof fetch
  now?: Date
}

/** Test seam: replace the transport for every call (null restores `fetch`). */
let fetchOverride: typeof fetch | null = null
export const BillingClientTestAccess = {
  setFetch(f: typeof fetch | null): void {
    fetchOverride = f
  },
}

export async function callControlBilling<T extends Exclude<CellBillingMessageType, "usage.report">>(
  type: T,
  data: CellBillingData<T>,
  opts: BillingCallOptions = {},
): Promise<CellBillingReply<T>> {
  const endpoint = liaisonTeamEndpoint()
  if (!endpoint) throw new BillingUnavailableError("no control plane endpoint")
  const identity = await withSystemDb("billing-managed:identity", (db) => readIdentity(db))
  if (identity?.state !== "registered") {
    throw new BillingUnavailableError("no registered identity")
  }
  const key = decryptInstanceKey(identity)
  if (!key) throw new BillingUnavailableError("instance key unreadable")

  const now = opts.now ?? new Date()
  const envelope = {
    v: 2 as const,
    type,
    messageId: randomUUID(),
    instanceId: identity.instanceId,
    ts: new Date(now.getTime() + identity.clockOffsetMs).toISOString(),
    data,
  }
  const local = cellBillingMessageSchemas[type].safeParse(envelope)
  if (!local.success) {
    // A bug on this side: never sent.
    log.error({ type, error: local.error.message }, "billing message refused locally")
    throw new BillingUnavailableError("invalid local message")
  }
  const rawBody = JSON.stringify(envelope)
  const doFetch = opts.fetch ?? fetchOverride ?? fetch
  let status: number
  let text: string
  try {
    const res = await doFetch(`${endpoint}/${CELL_BILLING_ENDPOINT}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `liaison/${env.LIAISON_VERSION}`,
        [INSTANCE_HEADER]: identity.instanceId,
        [SIGNATURE_HEADER]: signBody(key, rawBody),
      },
      body: rawBody,
      signal: AbortSignal.timeout(BILLING_CALL_TIMEOUT_MS),
      redirect: "manual",
    })
    status = res.status
    const length = Number(res.headers.get("content-length") ?? "0")
    if (length > MAX_REPLY_BYTES) throw new Error("reply too large")
    text = await res.text()
    if (text.length > MAX_REPLY_BYTES) throw new Error("reply too large")
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn({ type, requestId: data.requestId, reason }, "billing call failed")
    throw new BillingUnavailableError(`network: ${reason}`)
  }
  if (status !== 200) {
    log.warn({ type, requestId: data.requestId, status }, "billing call refused")
    throw new BillingUnavailableError(`status ${status}`)
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new BillingUnavailableError("reply is not JSON")
  }
  const inner = (body as { data?: unknown } | null)?.data
  const parsed = cellBillingReplySchemas[type].safeParse(inner)
  if (!parsed.success) {
    log.warn({ type, requestId: data.requestId }, "billing reply does not match the contract")
    throw new BillingUnavailableError("malformed reply")
  }
  return parsed.data as CellBillingReply<T>
}
