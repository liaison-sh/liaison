// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hidden reads other parts of Liaison call:
//   - `approval_route_read`: which company a pending approval about a Stripe
//     customer, subscription or charge is for, so it goes to that company's
//     account manager;
//   - `billing_status_for_counterparty`: whether a contact or a company pays a
//     live Stripe subscription (invoicing's guard reads this one narrow tool);
//   - `invoice_document_link`: the Liaison document a Stripe invoice became;
import { refuseTool } from "@liaison/app-sdk"
import { customerIdsFor, type ReadCtx, UUID } from "./read-common"

type Obj = Record<string, unknown>

async function one(ctx: ReadCtx, entity: string, stripeId: string): Promise<Obj | undefined> {
  return ((await ctx.db.findMany(entity, { where: { stripe_id: stripeId }, limit: 1 })) as Obj[])[0]
}

export async function approvalRouteRead(params: Obj | undefined, ctx: ReadCtx) {
  const p = params ?? {}
  const type = String(p.entityType ?? "")
  const id = String(p.entityId ?? "")
  let customerId: string | null = null
  if (type === "customer") customerId = id
  else if (type === "subscription") customerId = ((await one(ctx, "stripe_subscriptions", id))?.customer_id as string) ?? null
  else if (type === "charge") customerId = ((await one(ctx, "stripe_payments", id))?.customer_id as string) ?? null
  const customer = customerId ? await one(ctx, "stripe_customers", customerId) : undefined
  const companyId = typeof customer?.company_id === "string" ? customer.company_id : null
  return { companyId, personId: null }
}

const LIVE = new Set(["trialing", "active", "past_due", "unpaid", "paused"])

export async function billingStatusForCounterparty(params: Obj | undefined, ctx: ReadCtx) {
  const p = params ?? {}
  const contactId = typeof p.contactId === "string" && UUID.test(p.contactId) ? p.contactId : undefined
  const companyId = typeof p.companyId === "string" && UUID.test(p.companyId) ? p.companyId : undefined
  const customerIds = [
    ...new Set([
      ...(contactId ? await customerIdsFor(ctx, { contactId }) : []),
      ...(companyId ? await customerIdsFor(ctx, { companyId }) : []),
    ]),
  ]
  if (customerIds.length === 0) return { live: false, subscriptions: [], customerIds: [] }
  const subs = (await ctx.db.findMany("stripe_subscriptions", {
    where: { customer_id: { in: customerIds } },
    limit: 100,
  })) as Obj[]
  const live = subs.filter((s) => LIVE.has(String(s.status)))
  return {
    live: live.length > 0,
    subscriptions: live.map((s) => ({ id: String(s.stripe_id), plan: String(s.plan_name ?? "") })),
    customerIds,
  }
}

export interface DocLinkCtx extends ReadCtx {
  db: ReadCtx["db"] & { update(entity: string, id: string, data: Record<string, unknown>): Promise<void> }
}

export async function invoiceDocumentLink(params: Obj | undefined, ctx: DocLinkCtx) {
  const p = params ?? {}
  const stripeInvoiceId = typeof p.stripeInvoiceId === "string" ? p.stripeInvoiceId : ""
  const documentId = typeof p.documentId === "string" && UUID.test(p.documentId) ? p.documentId : ""
  if (!stripeInvoiceId || !documentId) {
    return refuseTool("invoice_link_invalid", "A Stripe invoice id and a document id are both needed, so nothing was linked.")
  }
  const row = await one(ctx, "stripe_invoices", stripeInvoiceId)
  if (!row) {
    return refuseTool("invoice_not_found", `No Stripe invoice ${stripeInvoiceId} is in the mirror, so nothing was linked.`)
  }
  await ctx.db.update("stripe_invoices", String(row.id), { liaison_document_id: documentId })
  return { ok: true, summary: `Stripe invoice ${stripeInvoiceId} now names document ${documentId}.` }
}
