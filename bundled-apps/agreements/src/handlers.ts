// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Handler barrel: every tool handler the manifest names, by exact export name.

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
} from "./agreements"
import type { AgreementsCtx } from "./ctx"
import {
  agreementSend,
  agreementSendPreflight,
  agreementVoid,
  agreementVoidPreflight,
  clientActionViewGet,
  onClientActionDecided,
  type SendParams,
} from "./send"
import { type SaveParams, templateGet, templateSave, templatesList } from "./templates"

type Ctx = AgreementsCtx

export const homeLoadHandler = (p: { limit?: number }, ctx: Ctx) =>
  agreementsSearch(ctx, { limit: p?.limit ?? 200 })
export const agreementsSearchHandler = (p: SearchParams, ctx: Ctx) => agreementsSearch(ctx, p ?? {})
export const agreementGetHandler = (p: { id: string }, ctx: Ctx) => agreementGet(ctx, p)
export const agreementCreateHandler = (p: CreateParams, ctx: Ctx) => agreementCreate(ctx, p)
export const agreementUpdateHandler = (p: UpdateParams, ctx: Ctx) => agreementUpdate(ctx, p)
export const agreementPrepareHandler = (p: { id: string }, ctx: Ctx) => agreementPrepare(ctx, p)
export const agreementPriceSetHandler = (
  p: { id: string; price_minor: string; currency: string },
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
export const agreementVoidPreflightHandler = (p: { id: string; reason: string }, ctx: Ctx) =>
  agreementVoidPreflight(ctx, p)
export const agreementVoidHandler = (p: { id: string; reason: string }, ctx: Ctx) =>
  agreementVoid(ctx, p)
export const clientActionViewGetHandler = (p: { targetType: string; targetId: string }, ctx: Ctx) =>
  clientActionViewGet(ctx, p)
export const onClientActionDecidedHandler = (event: unknown, ctx: Ctx) =>
  onClientActionDecided(ctx, event as Parameters<typeof onClientActionDecided>[1])

// --- Gated-tool approval summarizers ---
export * from "./summarizers"
