// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Handler barrel: every handler the manifest names, by exact export name.
import type { UpstreamProbeResult, WebhookResult } from "@liaison/app-sdk"
import { handleStripeEvent, type IngestCtx } from "./dispatch"
import { holdWhileImporting } from "./states"
import type { SyncCtx } from "./sync/common"
import { runBackfill } from "./sync/backfill"
import { onDisconnect, type PurgeCtx, purgeMirror, runCatchup, runPrune } from "./sync/maintenance"
import { runProbe } from "./sync/probe"
import { runReconcile } from "./sync/reconcile"
import { type StripeVerifyBridge, type StripeVerifyParams, type StripeVerifyResult, verifyStripeDelivery } from "./verify"

export { homeLoad } from "./sync/home"
export { connectionCheck, connectionPrecheck, settingsLoad } from "./tools/connection-check"

/** The kernel's verifier entry: the org's own secret, checked host-side (verify.ts). */
export async function stripeWebhookVerifier(
  params: StripeVerifyParams,
  bridge: StripeVerifyBridge,
): Promise<StripeVerifyResult> {
  return verifyStripeDelivery(params, bridge)
}

/** One verified event: ledger, re-fetch, mirror, events (dispatch.ts); its events held while importing (states.ts). */
export async function eventsHandler(payload: unknown, ctx: IngestCtx): Promise<WebhookResult> {
  return holdWhileImporting(payload, ctx, (c) => handleStripeEvent(payload, c))
}

/** Newer events upstream and none received for 2 hours: stalled, and the missed events played (sync/probe.ts). */
export async function probeWebhookUpstreamJob(_params: unknown, ctx: SyncCtx): Promise<UpstreamProbeResult> {
  return runProbe(ctx)
}

/** The first import, resumable per resource (sync/backfill.ts). */
export const backfillJob = (_params: unknown, ctx: SyncCtx) => runBackfill(ctx)

/** The nightly reconcile: by list and by id, never a deletion from absence (sync/reconcile.ts). */
export const reconcileJob = (_params: unknown, ctx: SyncCtx) => runReconcile(ctx)

/** Failed deliveries played again (sync/maintenance.ts). */
export const catchupRetryJob = (_params: unknown, ctx: SyncCtx) => runCatchup(ctx)

/** Ledger rows older than 30 days removed (sync/maintenance.ts). */
export const pruneWebhookDeliveriesJob = (_params: unknown, ctx: SyncCtx) => runPrune(ctx)

/** A removal of the mirror cut short, carried on (sync/maintenance.ts). */
export const purgeMirrorJob = (_params: unknown, ctx: PurgeCtx) => purgeMirror(ctx)

/** The connection was removed: every mirror row goes, invoicing documents stay. */
export async function onConnectionDisconnected(event: { data?: { appName?: unknown } | null }, ctx: PurgeCtx) {
  await onDisconnect(event, ctx)
}
