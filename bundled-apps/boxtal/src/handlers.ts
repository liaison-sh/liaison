// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Handler barrel — re-exports every tool/webhook/event/search handler the
// manifest references, by the exact export name. The freeze resolves
// handlers.ts as the Bun.build entrypoint; a missing/renamed export fails at
// install, so build-roundtrip.test.ts pins this set (Task 20).
//
// Each handler is `(params, ctx)` where ctx is the precise `BoxtalToolCtx`
// (no `any`): the manifest declares the param JSON-schema, so we type params to
// the per-tool input shape and let the orchestrator functions do the work.

import { type PrepSetAddressChoiceInput, prepSetAddressChoice, prepSetAddressChoicePreflight as prepSetAddressChoicePreflightImpl } from "./address-choice"
import {
  localProductUpsert,
  type PackUpsertInput,
  packagesList,
  packDelete,
  packUpsert,
  type ProductProfileInput,
  productProfileUpsert,
} from "./catalog"
import {
  deleteProfile,
  type LinkInput,
  linkVariant,
  type MergeInput,
  mergeProfiles,
  unlinkVariant,
  type VariantRef,
} from "./profiles"
import {
  cancelShipment,
  cancelShipmentPreflight,
  createShipment,
  importLabelDocument,
  pollCreateShipmentOutput,
  createShipmentPreflight,
  type CreateShipmentInput,
  quote,
  type SetPackageOverride,
  shipmentDraftCreate,
  shipmentDraftSetCustomsPersist,
  shipmentDraftSetPackagePersist,
} from "./shipment"
import {
  getDocuments,
  getShipment,
  listContentCategories,
  track,
} from "./reads"
import { claimOpen, claimOpenPreflight, type ClaimOpenInput } from "./claims"
import { printPack, type PrintPackInput } from "./print-pack"
import { printRecordGet } from "./print-record"
import { orderPrintRecordGet } from "./customs-documents"
import { readySetPacked, type ReadySetPackedInput } from "./packed"
import { printPackBatch, type PrintPackBatchInput } from "./print-pack-batch"
import {
  attentionRuleDelete,
  attentionRulesList,
  attentionRuleUpsert,
  type AttentionRuleUpsertInput,
} from "./attention-store"
import {
  prepExclude,
  type PrepExcludeInput,
  prepList,
  type PrepListInput,
  prepRestore,
  prepSelectOffer,
  type PrepSelectOfferInput,
  prepSetCategory,
  type PrepSetCategoryInput,
  prepSync,
  type PrepSyncInput,
  prepAddShipment,
  type PrepAddShipmentInput,
  prepDocumentPdf,
  type PrepDocumentPdfInput,
  prepOrderPrefill,
  type PrepOrderPrefillInput,
  prepSetStatus,
  type PrepSetStatusInput,
  prepSetValidated,
  type PrepSetValidatedInput,
} from "./prep"
import { importShipments, type ImportShipmentsInput } from "./import"
import { prepSetNote, type PrepSetNoteInput } from "./staff-note"
import { exceptionsList, queueCounts, readyList, returnsList, stuckList, toPrepareList } from "./queues"
import { quoteBatch, type QuoteBatchInput } from "./quote-batch"
import {
  type CarrierAllowlistInput,
  settingsCarrierAllowlistGet,
  settingsCarrierAllowlistSet,
  type SenderAddressInput,
  settingsSenderAddressGet,
  settingsSenderAddressSet,
  settingsLabelFormatGet,
  settingsLabelFormatSet,
  settingsFormGet,
  settingsFormSet,
  settingsSenderFormGet,
  type SettingsFormInput,
  type ProductCodesInput,
  settingsProductCodesGet,
  settingsProductCodesSet,
  type PackagingPolicyInput,
  settingsPackagingPolicyGet,
  settingsPackagingPolicySet,
} from "./settings"
import { storedShortCode, syncAfterProfileWrite } from "./product-attributes"
import { unlinkedOrdersList } from "./unlinked"
import type { BoxtalToolCtx } from "./ctx"
import type { CotationInput } from "./lib/boxtal-v1-client"
import type { CustomsPatch } from "./customs"

/** Reads-only handlers take a narrower ctx; widen via the shared tool ctx. */
import {
  type SettleOrphanInput,
  settleOrphanedCreate,
  settleOrphanedCreatePreflight,
} from "./reconcile-tracking"

type Ctx = BoxtalToolCtx

// — catalog tools —
// CatalogCtx is `{ db }`; BoxtalToolCtx's `db` is the same `DbClient`, so a
// structural narrow (not a cast) suffices — pass ctx directly.
export const packagesListHandler = (_params: Record<string, never>, ctx: Ctx) =>
  packagesList(ctx, {})
// A profile write copies the codes it touched onto the products' SKUs (the kernel's
// provider-neutral product attributes, product-attributes.ts), best effort. It overwrites only
// when the stored code actually changed (re-sending the same code leaves a code set elsewhere).
export const productProfileUpsertHandler = async (params: ProductProfileInput, ctx: Ctx) => {
  const before = params.short_code !== undefined ? await storedShortCode(ctx.db, params) : null
  const res = await productProfileUpsert(ctx, params)
  const changed = params.short_code !== undefined && (params.short_code || null) !== before
  const product_codes = await syncAfterProfileWrite(ctx, [res.id], changed ? "overwrite" : "fill")
  return { ...res, product_codes }
}
export const packUpsertHandler = (params: PackUpsertInput, ctx: Ctx) =>
  packUpsert(ctx, params)
export const packDeleteHandler = (params: { id: string }, ctx: Ctx) =>
  packDelete(ctx, params)
export const localProductUpsertHandler = (params: { sku: string; label: string }, ctx: Ctx) =>
  localProductUpsert(ctx, params)
export const productProfileLinkHandler = async (params: LinkInput, ctx: Ctx) => {
  const res = await linkVariant(ctx, params)
  if (!res.ok || res.preview) return res
  return { ...res, product_codes: await syncAfterProfileWrite(ctx, [res.profile_id], "fill") }
}
export const productProfileUnlinkHandler = (params: VariantRef, ctx: Ctx) => unlinkVariant(ctx, params)
export const productProfileMergeHandler = async (params: MergeInput, ctx: Ctx) => {
  const res = await mergeProfiles(ctx, params)
  if (res.preview) return res
  // The merged profile's code wins on every SKU it now covers when the merge changed codes.
  const mode = res.differences.some((d) => d.field === "short_code") ? "overwrite" : "fill"
  return { ...res, product_codes: await syncAfterProfileWrite(ctx, [res.target_profile_id], mode) }
}
export const productProfileDeleteHandler = (params: { profile_id: string }, ctx: Ctx) =>
  deleteProfile(ctx, params)
export { migrateShippingProfilesJobHandler } from "./profiles"
export { syncProductCodesJobHandler } from "./product-attributes"

// — quote + draft tools —
export const quoteHandler = (params: CotationInput, ctx: Ctx) => quote(ctx, params)
// WHOLE-WALL pricing: server-side fan-out that quotes every order, picks the
// cheapest within-ETA offer per order, and sums one authoritative projected
// spend in ONE call (BL-270 — replaces the one-by-one hand-totalled bounded
// sample). READ-ONLY/UNGATED: prices + totals only, creates nothing; the per-
// order label buy stays a separate gated create_shipment.
export const quoteBatchHandler = (params: QuoteBatchInput, ctx: Ctx) => quoteBatch(ctx, params)
export const shipmentDraftCreateHandler = (
  params: { document_ref: string; lines?: Array<{ line_id: string; quantity: number }> },
  ctx: Ctx,
) => shipmentDraftCreate(ctx, params)
// Read-back of the current draft state (parcels + customsArticles incl. each line's tariffNumber and
// `incomplete` flag), keyed by the draft id. It re-derives the draft from the invoice snapshot + any
// persisted overrides — the SAME idempotent compute shipment_draft_create runs, exposed as an
// explicitly-named READ tool so the agent can VERIFY per-line customs codes from a tool result instead
// of fabricating "all lines set" from memory (BL-254 — the agent had only get_shipment, which returns
// live order/tracking and NO customsArticles, so it polled it pointlessly and bluffed).
export const shipmentDraftGetHandler = (params: { draft_id: string }, ctx: Ctx) =>
  shipmentDraftCreate(ctx, { document_ref: params.draft_id })
export const shipmentDraftSetPackageHandler = (
  params: { draft_id: string; override: SetPackageOverride },
  ctx: Ctx,
) => shipmentDraftSetPackagePersist(ctx, params)
export const shipmentDraftSetCustomsHandler = (
  params: { draft_id: string; index: number; patch: CustomsPatch },
  ctx: Ctx,
) => shipmentDraftSetCustomsPersist(ctx, params)

// — gated tools (handler name = tool name) —
export const create_shipment = (params: CreateShipmentInput, ctx: Ctx) =>
  createShipment(ctx, params)
// STAGE-TIME preflight (manifest `preflight`) — validates the draft_id resolves to a real invoice
// (catching a wrong/hallucinated id), has no unresolved lines, and is not a duplicate of a shipment
// already in flight for that invoice — BEFORE the gated approval is created, so a doomed create_shipment
// fails at staging (agent self-corrects) instead of 422-ing after the human approves it.
export const create_shipment_preflight = (params: CreateShipmentInput, ctx: Ctx) =>
  createShipmentPreflight(ctx, params)
export const cancel_shipment = (params: { id: string }, ctx: Ctx) =>
  cancelShipment(ctx, params)
// STAGE-TIME preflight (manifest `preflight`) — a gated call must not be parked for a human when the
// data it needs is missing: refuses at staging when Boxtal is not connected or the shipping order does
// not exist. The already-dispatched check stays in the handler (a genuine staging-to-approval race).
export const cancel_shipment_preflight = (params: { id: string }, ctx: Ctx) =>
  cancelShipmentPreflight(ctx, params)
// Backfill-import a created shipment's LABEL PDF into kernel.files (the label
// is generated asynchronously by Boxtal, so create_shipment's inline import
// can return label_file_id null; this closes the gap any time later).
export const importLabelDocumentHandler = (params: { id: string }, ctx: Ctx) =>
  importLabelDocument(ctx, params)
// Print-station document prep: TWO separate jobs (normalized label for the
// label printer; invoice for A4 with the route's copy count) — never merged.
export const printPackHandler = (params: PrintPackInput, ctx: Ctx) => printPack(ctx, params)

// The warehouse bench mark on a Ready-to-ship row: packed and waiting for pickup, or not yet.
// Local stamp only (`packed_at` on the shipment row): ships nothing, calls no carrier.
export const readySetPackedHandler = (params: ReadySetPackedInput, ctx: Ctx) =>
  readySetPacked(ctx, params)

// The same two jobs for a SELECTION of rows, merged one document per job so a morning's parcels
// are two print dialogs rather than two per parcel (see print-pack-batch.ts).
export const printPackBatchHandler = (params: PrintPackBatchInput, ctx: Ctx) =>
  printPackBatch(ctx, params)

// Attention rules: the DATA behind the "this parcel needs extra paperwork" mark (attention.ts).
export const attentionRulesListHandler = (_params: Record<string, never>, ctx: Ctx) =>
  attentionRulesList(ctx)
export const attentionRuleUpsertHandler = (params: AttentionRuleUpsertInput, ctx: Ctx) =>
  attentionRuleUpsert(ctx, params)
export const attentionRuleDeleteHandler = (params: { id?: string }, ctx: Ctx) =>
  attentionRuleDelete(ctx, params)

/** Kernel approval-poll target (manifest `pollHandler` on create_shipment):
 *  materializes the async label output so the sequence cascade resumes. */
export const pollCreateShipmentOutputHandler = (
  params: { external_ref?: { shipment_row_id?: string; boxtal_order_id?: string } | null },
  ctx: Ctx,
) => pollCreateShipmentOutput(ctx, params)

// — settings (ship-from address) —
export const settingsSenderAddressGetHandler = (_params: Record<string, never>, ctx: Ctx) =>
  settingsSenderAddressGet(ctx)
export const settingsSenderAddressSetHandler = (params: SenderAddressInput, ctx: Ctx) =>
  settingsSenderAddressSet(ctx, params)
export const settingsCarrierAllowlistGetHandler = (_params: Record<string, never>, ctx: Ctx) =>
  settingsCarrierAllowlistGet(ctx)
export const settingsCarrierAllowlistSetHandler = (params: CarrierAllowlistInput, ctx: Ctx) =>
  settingsCarrierAllowlistSet(ctx, params)
export const settingsLabelFormatGetHandler = (_params: Record<string, never>, ctx: Ctx) =>
  settingsLabelFormatGet(ctx)
export const settingsLabelFormatSetHandler = (params: { format: string }, ctx: Ctx) =>
  settingsLabelFormatSet(ctx, params)
export const settingsFormGetHandler = (_params: Record<string, never>, ctx: Ctx) =>
  settingsFormGet(ctx)
export const settingsSenderFormGetHandler = (_params: Record<string, never>, ctx: Ctx) =>
  settingsSenderFormGet(ctx)
export const settingsFormSetHandler = (params: SettingsFormInput, ctx: Ctx) =>
  settingsFormSet(ctx, params)
export const settingsProductCodesGetHandler = (_params: Record<string, never>, ctx: Ctx) =>
  settingsProductCodesGet(ctx)
export const settingsProductCodesSetHandler = (params: ProductCodesInput, ctx: Ctx) =>
  settingsProductCodesSet(ctx, params)
export const settingsPackagingPolicyGetHandler = (_params: Record<string, never>, ctx: Ctx) =>
  settingsPackagingPolicyGet(ctx)
export const settingsPackagingPolicySetHandler = (params: PackagingPolicyInput, ctx: Ctx) =>
  settingsPackagingPolicySet(ctx, params)

export const prepUnlinkedListHandler = (params: { limit?: number }, ctx: Ctx) =>
  unlinkedOrdersList(ctx, params)

// — import (local-only writes: pulls named Boxtal orders into the local table) —
export const importShipmentsHandler = (params: ImportShipmentsInput, ctx: Ctx) =>
  importShipments(ctx, params)

// — free reads —
export const trackHandler = (params: { id: string }, ctx: Ctx) => track(ctx, params)
export const getShipmentHandler = (params: { id: string }, ctx: Ctx) => getShipment(ctx, params)
export const getDocumentsHandler = (params: { id: string }, ctx: Ctx) => getDocuments(ctx, params)
export const listContentCategoriesHandler = (_params: Record<string, never>, ctx: Ctx) =>
  listContentCategories(ctx, {})

// — operational queues (sidebar badges + queue views) —
export const queueCountsHandler = (_params: Record<string, never>, ctx: Ctx) => queueCounts(ctx)
export const toPrepareListHandler = (_params: Record<string, never>, ctx: Ctx) => toPrepareList(ctx)
export const readyListHandler = (_params: Record<string, never>, ctx: Ctx) => readyList(ctx)
export const printRecordGetHandler = (params: { shipment_id?: string }, ctx: Ctx) =>
  printRecordGet(ctx, params)
export const orderPrintRecordGetHandler = (params: { document_ref?: string }, ctx: Ctx) =>
  orderPrintRecordGet(ctx, params)
export { generateOrderDocumentsJobHandler } from "./customs-documents"
export const returnsListHandler = (_params: Record<string, never>, ctx: Ctx) => returnsList(ctx)
export const exceptionsListHandler = (_params: Record<string, never>, ctx: Ctx) =>
  exceptionsList(ctx)
export const stuckListHandler = (_params: Record<string, never>, ctx: Ctx) => stuckList(ctx)
export const claimOpenHandler = (params: ClaimOpenInput, ctx: Ctx) => claimOpen(ctx, params)
// STAGE-TIME preflight (manifest `preflight`) — a gated call must not be parked for a human when the
// data it needs is missing: refuses at staging when the shipment does not exist or is not in an
// exception state, instead of throwing only after the approver clicked approve.
export const claimOpenPreflightHandler = (params: { shipment_id: string }, ctx: Ctx) =>
  claimOpenPreflight(ctx, params)

// — order-prep dashboard (prep_list free read; prep_sync gated write + external calls) —
export const prepListHandler = (params: PrepListInput, ctx: Ctx) => prepList(ctx, params)
export const prepSyncHandler = (params: PrepSyncInput, ctx: Ctx) => prepSync(ctx, params)
export const prepSetCategoryHandler = (params: PrepSetCategoryInput, ctx: Ctx) =>
  prepSetCategory(ctx, params)
export const prepSelectOfferHandler = (params: PrepSelectOfferInput, ctx: Ctx) =>
  prepSelectOffer(ctx, params)
// A person's pick between the order's address and the verified one when they differ (gated,
// noAutoApprove: a person's click runs it, an agent's call waits for a person).
export const prepSetAddressChoiceHandler = (params: PrepSetAddressChoiceInput, ctx: Ctx) =>
  prepSetAddressChoice(ctx, params)
export const prepSetAddressChoicePreflight = (params: PrepSetAddressChoiceInput, ctx: Ctx) =>
  prepSetAddressChoicePreflightImpl(ctx, params)
export const prepSetValidatedHandler = (params: PrepSetValidatedInput, ctx: Ctx) =>
  prepSetValidated(ctx, params)
// One status per row (to_prepare / validated / on_hold), keyed by order_key: the row-level
// state the whole grid tints off. prep_set_validated above is an alias onto it, hidden from agents.
export const prepSetStatusHandler = (params: PrepSetStatusInput, ctx: Ctx) =>
  prepSetStatus(ctx, params)
// The Shopify order's internal staff note, saved back through shopify:order_note_set with a
// compare-and-set on the value the grid last showed.
export const prepSetNoteHandler = (params: PrepSetNoteInput, ctx: Ctx) => prepSetNote(ctx, params)
// An ORDER-LESS row: a repaired unit or a sample, shipping on a proforma the app issues itself.
export const prepAddShipmentHandler = (params: PrepAddShipmentInput, ctx: Ctx) =>
  prepAddShipment(ctx, params)
// Read only: what an existing order would contribute to an order-less shipment.
export const prepOrderPrefillHandler = (params: PrepOrderPrefillInput, ctx: Ctx) =>
  prepOrderPrefill(ctx, params)
// The row's shipping document as a file id. The UI can only invoke THIS app's tools, so the
// cross-app PDF read happens here rather than in the browser.
export const prepDocumentPdfHandler = (params: PrepDocumentPdfInput, ctx: Ctx) =>
  prepDocumentPdf(ctx, params)
export const prepExcludeHandler = (params: PrepExcludeInput, ctx: Ctx) => prepExclude(ctx, params)
export const prepRestoreHandler = (params: PrepExcludeInput, ctx: Ctx) => prepRestore(ctx, params)

// — webhooks —
export { boxtalWebhookVerifier } from "./lib/hmac"
export { documentCreatedHandler, trackingChangedHandler } from "./webhooks"

// — connection events —
export { onConnectionDisconnected, onConnectionEstablished } from "./connection"

// — webhook repair (re-point subscriptions at the current kernel secret) —
import { webhooksRepair } from "./connection"
export const webhooksRepairHandler = (_params: Record<string, never>, ctx: Ctx) => webhooksRepair(ctx)

// — scheduled jobs —
// The convergence guarantee under the webhook stream: webhooks are the fast path,
// this re-reads Boxtal on a schedule so a missed/rejected delivery costs one
// interval of staleness instead of being lost forever. See reconcile-tracking.ts.
export { reconcileTrackingJobHandler } from "./reconcile-tracking"
// A person settles an orphaned label purchase (stuck_list family create_orphan) after checking the
// Boxtal dashboard: adopt the order found there, or release the reservation as never bought.
// Gated for agents (handler name = tool name); a person holding boxtal:shipments:write runs it directly.
export const settle_orphan_create = (params: SettleOrphanInput, ctx: Ctx) => settleOrphanedCreate(ctx, params)
export const settle_orphan_create_preflight = (params: SettleOrphanInput, ctx: Ctx) =>
  settleOrphanedCreatePreflight(ctx, params)
export { backfillQueueFactsJobHandler } from "./queue-facts-backfill"
// Tells the kernel when Boxtal last saw a parcel change status, so webhook silence
// on a quiet week is not paged as a dead pipe. See probe-webhook-upstream.ts.
export { probeWebhookUpstreamJob } from "./probe-webhook-upstream"

// — import kinds (manifest `import.kinds`) —
export { importLocalProducts, importPacks, importShippingProfiles } from "./import-kind"

// — search —
export { searchHandler } from "./search"

// — gated-tool approval summarizers —
export * from "./summarizers"
