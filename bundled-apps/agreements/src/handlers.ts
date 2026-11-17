// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Handler barrel: every tool handler the manifest names, by exact export name.

import { activityRead } from "./activity"
import {
  agreementCreate,
  agreementGet,
  agreementPrepare,
  agreementPriceSet,
  agreementsSearch,
  agreementUpdate,
  approvalRouteRead,
  type CreateParams,
  type SearchParams,
  type UpdateParams,
  uploadFreezeJob,
  uploadRescanJob,
} from "./agreements"
import { changeRequestEffectsJob } from "./change-request-effects"
import {
  type ChangeRequestSendParams,
  changeRequestSend,
  changeRequestSendPreflight,
} from "./change-request-send"
import type { AgreementsCtx } from "./ctx"
import { datesDaily } from "./dates"
import { agreementImport, type ImportParams } from "./import"
import { agreementPassageGet } from "./passage"
import { onPortalAccessEnded } from "./portal-ended"
import { onScopeCheckEnabled, scopeGroupReconcile } from "./scope-group"
import { copiesRetry, evidenceVerify, type SealCtx, sealRetry, timestampRetry } from "./seal"
import {
  agreementNewLink,
  agreementNewLinkPreflight,
  agreementReminderSend,
  agreementReminderSendPreflight,
  agreementSend,
  agreementSendPreflight,
  agreementVoid,
  agreementVoidPreflight,
  clientActionViewGet,
  decidedReconcile,
  onClientActionDecided,
  type SendParams,
} from "./send"
import { agreementEvidenceGetNamed, agreementVerifyNamed } from "./stand-in"
import { type SaveParams, templateGet, templateSave, templatesList } from "./templates"

type Ctx = AgreementsCtx

export const homeLoadHandler = (p: { limit?: number }, ctx: Ctx) =>
  agreementsSearch(ctx, { limit: p?.limit ?? 200 })
export const agreementsSearchHandler = (p: SearchParams, ctx: Ctx) => agreementsSearch(ctx, p ?? {})
export const agreementGetHandler = (p: { id: string }, ctx: Ctx) => agreementGet(ctx, p)
export const agreementCreateHandler = (p: CreateParams, ctx: Ctx) => agreementCreate(ctx, p)
export const agreementImportHandler = (p: ImportParams, ctx: Ctx) => agreementImport(ctx, p)
export const agreementUpdateHandler = (p: UpdateParams, ctx: Ctx) => agreementUpdate(ctx, p)
export const agreementPrepareHandler = (p: { id: string }, ctx: Ctx) => agreementPrepare(ctx, p)
export const agreementPriceSetHandler = (
  p: { id: string; price_minor: string; currency: string; rate_minor?: string },
  ctx: Ctx,
) => agreementPriceSet(ctx, p)
export const templatesListHandler = (p: { kind?: string; include_archived?: boolean }, ctx: Ctx) =>
  templatesList(ctx, p ?? {})
export const templateGetHandler = (p: { template_id: string; version?: number }, ctx: Ctx) =>
  templateGet(ctx, p)
export const templateSaveHandler = (p: SaveParams, ctx: Ctx) => templateSave(ctx, p)
export const approvalRouteReadHandler = (p: { entityType: string; entityId: string }, ctx: Ctx) =>
  approvalRouteRead(ctx, p)
export const agreementSendHandler = (p: SendParams, ctx: Ctx) => agreementSend(ctx, p)
export const agreementSendPreflightHandler = (p: SendParams, ctx: Ctx) =>
  agreementSendPreflight(ctx, p)
export const changeRequestSendHandler = (p: ChangeRequestSendParams, ctx: Ctx) =>
  changeRequestSend(ctx, p)
export const changeRequestSendPreflightHandler = (p: ChangeRequestSendParams, ctx: Ctx) =>
  changeRequestSendPreflight(ctx, p)
export const agreementVoidPreflightHandler = (p: { id: string; reason: string }, ctx: Ctx) =>
  agreementVoidPreflight(ctx, p)
export const agreementVoidHandler = (p: { id: string; reason: string }, ctx: Ctx) =>
  agreementVoid(ctx, p)
type ReminderParams = Parameters<typeof agreementReminderSend>[1]
export const agreementReminderSendHandler = (p: ReminderParams, ctx: Ctx) =>
  agreementReminderSend(ctx, p)
export const agreementReminderSendPreflightHandler = (p: ReminderParams, ctx: Ctx) =>
  agreementReminderSendPreflight(ctx, p)
type NewLinkParams = { client_action_id: string; email?: string; expires_in_days?: number }
export const agreementNewLinkHandler = (p: NewLinkParams, ctx: Ctx) => agreementNewLink(ctx, p)
export const agreementNewLinkPreflightHandler = (p: NewLinkParams, ctx: Ctx) =>
  agreementNewLinkPreflight(ctx, p)
export const clientActionViewGetHandler = (p: { targetType: string; targetId: string }, ctx: Ctx) =>
  clientActionViewGet(ctx, p)
export const onClientActionDecidedHandler = (event: unknown, ctx: Ctx) =>
  onClientActionDecided(ctx, event as Parameters<typeof onClientActionDecided>[1])

export const onPortalAccessEndedHandler = (event: unknown, ctx: Ctx) =>
  onPortalAccessEnded(ctx, event as Parameters<typeof onPortalAccessEnded>[1])

export const decidedReconcileJobHandler = (_payload: unknown, ctx: Ctx) => decidedReconcile(ctx)
export const changeRequestEffectsJobHandler = (_payload: unknown, ctx: Ctx) =>
  changeRequestEffectsJob(ctx)
export const scopeGroupReconcileJobHandler = (_payload: unknown, ctx: Ctx) =>
  scopeGroupReconcile(ctx)
export const onRoutineCreatedHandler = (event: unknown, ctx: Ctx) =>
  onScopeCheckEnabled(ctx, event as Parameters<typeof onScopeCheckEnabled>[1])
export const datesDailyJobHandler = (_payload: unknown, ctx: Ctx) => datesDaily(ctx)
export const uploadFreezeJobHandler = (_payload: unknown, ctx: Ctx) => uploadFreezeJob(ctx)
export const uploadRescanJobHandler = (_payload: unknown, ctx: Ctx) => uploadRescanJob(ctx)
export const agreementEvidenceGetHandler = (p: { id: string }, ctx: Ctx) =>
  agreementEvidenceGetNamed(ctx, p)
export const agreementVerifyHandler = (p: { id: string }, ctx: Ctx) =>
  agreementVerifyNamed(ctx as SealCtx, p)
export const sealRetryJobHandler = (_payload: unknown, ctx: Ctx) => sealRetry(ctx as SealCtx)
export const timestampRetryJobHandler = (_payload: unknown, ctx: Ctx) =>
  timestampRetry(ctx as SealCtx)
export const copiesRetryJobHandler = (_payload: unknown, ctx: Ctx) => copiesRetry(ctx as SealCtx)
export const evidenceVerifyJobHandler = (_payload: unknown, ctx: Ctx) =>
  evidenceVerify(ctx as SealCtx)

// --- Gated-tool approval summarizers ---
export const agreementPassageGetHandler = (
  p: { version_id?: string; agreement_id?: string; section?: string },
  ctx: Ctx,
) => agreementPassageGet(ctx, p ?? {})
export const activityReadHandler = (p: Parameters<typeof activityRead>[1], ctx: Ctx) =>
  activityRead(ctx, p ?? {})

export * from "./summarizers"
