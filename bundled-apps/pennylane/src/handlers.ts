// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Handler barrel — re-exports every tool/event/job handler the manifest
// references, by exact export name. build-roundtrip.test.ts pins this set.
//
// Each tool handler is `(params, ctx)` where ctx is the precise `PennylaneToolCtx`
// (no `any`): the manifest declares the param JSON-schema, so we type params to
// the per-tool input shape and let the read/upload functions do the work. Job
// handlers are kernel-shaped `(payload, ctx)`.

import type { PennylaneToolCtx } from "./ctx"
import { probeWebhookUpstream } from "./einvoicing/probe-webhook-upstream"
import {
  cashPosition,
  customerInvoicesList,
  homeLoad,
  pnlSummary,
  runwayEstimate,
  spendByCategory,
  supplierInvoiceGet,
  supplierInvoicesList,
  transactionsList,
  trialBalanceGet,
} from "./reads"
import { type RefreshSnapshotsCtx, refreshSnapshotsJob } from "./snapshot"
import type { Filter } from "./types"
import { minorAmountsRefusal, supplierInvoiceUpload, type UploadInput } from "./upload"

type Ctx = PennylaneToolCtx
type ListParams = { cursor?: string; limit?: number; filter?: Filter[] }

// — read tools (handler name = manifest `handler` value) —
export const supplierInvoicesListHandler = (params: ListParams, ctx: Ctx) =>
  supplierInvoicesList(ctx, params)
export const supplierInvoiceGetHandler = (params: { id: string }, ctx: Ctx) =>
  supplierInvoiceGet(ctx, params)
export const customerInvoicesListHandler = (params: ListParams, ctx: Ctx) =>
  customerInvoicesList(ctx, params)
export const trialBalanceGetHandler = (params: { period?: string }, ctx: Ctx) =>
  trialBalanceGet(ctx, params)
export const pnlSummaryHandler = (params: { period?: string }, ctx: Ctx) => pnlSummary(ctx, params)
export const cashPositionHandler = (_params: Record<string, never>, ctx: Ctx) =>
  cashPosition(ctx, {})
export const transactionsListHandler = (params: ListParams, ctx: Ctx) =>
  transactionsList(ctx, params)
export const spendByCategoryHandler = (params: { period?: string }, ctx: Ctx) =>
  spendByCategory(ctx, params)
export const runwayEstimateHandler = (_params: Record<string, never>, ctx: Ctx) =>
  runwayEstimate(ctx, {})
export const homeLoadHandler = (_params: Record<string, never>, ctx: Ctx) => homeLoad(ctx, {})

// — gated write (handler name = tool name) —
export const supplier_invoice_upload = (params: UploadInput, ctx: Ctx) =>
  supplierInvoiceUpload(ctx, params)
/** An amount that cannot be read is refused before a bill's approval parks. */
export const supplier_invoice_upload_preflight = (params: UploadInput) => {
  const refused = minorAmountsRefusal(params)
  return refused ? { error: { code: "invalid_amount", message: refused } } : { ok: true }
}

// — connection events —
export { onConnectionDisconnected, onConnectionEstablished } from "./connection"

// — refresh job (kernel-shaped `(payload, ctx)`) —
export const refreshSnapshotsJobHandler = (
  payload: Record<string, unknown> | undefined,
  ctx: RefreshSnapshotsCtx,
) => refreshSnapshotsJob(ctx, payload ?? {})

// — webhook upstream probe (named by `webhookHealth.probe`): evidence for the webhook health check —
export const probeWebhookUpstreamJob = (_payload: unknown, ctx: Ctx) => probeWebhookUpstream(ctx)

// — einvoicing-pa@1 provider ops (contractOnly; reached through the kernel contract dispatch) —
export {
  einvoicingAdvance,
  einvoicingBook,
  einvoicingFind,
  einvoicingFindBooking,
  einvoicingReceivedFile,
  einvoicingReceivedGet,
  einvoicingReceivedList,
  einvoicingReceivedSetStatus,
  einvoicingRegistrationStatus,
  einvoicingStatus,
  einvoicingStatusChanges,
  einvoicingSubmit,
} from "./einvoicing/ops"
// — e-invoicing webhooks: verifier, handler, gated setup —
export { einvoicingWebhookHandler, verifyEinvoicingWebhook } from "./einvoicing/webhooks"
// — gated-tool approval summarizers —
export * from "./summarizers"

import { webhooksSetup } from "./einvoicing/webhooks"
export const webhooks_setup = (params: { callback_base_url?: string }, ctx: Ctx) =>
  webhooksSetup(params, ctx as Parameters<typeof webhooksSetup>[1])
