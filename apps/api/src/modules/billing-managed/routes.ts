// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `/api/billing/managed/*`: the managed edition's Billing page (spec S17).
// Org admins only (browser JWT, `kernel:org:admin`, app.ts); every other
// edition answers 404 (decided per request). Each route forwards one signed
// message to the control plane (control-client.ts) and answers its reply:
//
//   GET  /summary              plan, next invoice, card, plans, top-up terms, auto top-up
//   POST /change-plan          {targetPlan, requestId?}: sends the org's current usage
//   POST /cancel, /resume      {requestId?}: cancel at period end, or undo it
//   POST /frame-session        {action, credits?|invoiceId?}: a pay-frame session
//   GET  /invoices             the invoices and credit notes
//   GET  /invoices/:id/pdf     the PDF, streamed (never a payment-provider URL)
//   POST /topup                {credits, requestId?}
//   PUT  /auto-topup           {enabled, thresholdCredits, amountCredits, requestId?}
//
// `requestId` is the browser's idempotency key: a retried click sends the same
// one and gets the first outcome back. Prices, the top-up minimum and every
// display amount come only from the control plane's replies; this server holds
// none. The control plane unreachable → 503 `billing_unavailable`; a refusal it
// chose → its code (`caps_exceeded` lists the caps).

import { createHash, randomUUID } from "node:crypto"
import {
  type CellBillingErrorReply,
  cloudPlanSchema,
  frameSessionActionSchema,
  providerIdSchema,
} from "@liaison/control-plane-contract"
import { type Context, Hono } from "hono"
import { createMiddleware } from "hono/factory"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { isManagedEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { BillingUnavailableError, callControlBilling } from "./control-client"
import { currentPlanUsage } from "./usage"

/** 404 outside the managed edition, before anything else runs. */
export const managedBillingOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (!isManagedEdition()) {
    return c.json({ error: { message: "not found", code: "not_found" } }, 404)
  }
  await next()
})

const STATUS_OF_CODE: Partial<Record<CellBillingErrorReply["code"], ContentfulStatusCode>> = {
  billing_unavailable: 503,
  not_trusted: 503,
  not_implemented: 503,
  invalid_request: 400,
  not_found: 404,
  rate_limited: 429,
  auto_topup_limited: 429,
  pdf_too_large: 502,
}

const MESSAGES: Partial<Record<CellBillingErrorReply["code"], string>> = {
  billing_unavailable: "Billing is unavailable right now. Try again shortly.",
  caps_exceeded: "Current usage is above the plan's limits.",
  pdf_too_large: "This invoice is too large to download here; it was sent by email.",
}

function refusal(c: Context<AppEnv>, r: CellBillingErrorReply) {
  const status = STATUS_OF_CODE[r.code] ?? 409
  return c.json(
    {
      error: {
        message: MESSAGES[r.code] ?? r.code,
        code: r.code,
        ...(r.caps ? { details: { caps: r.caps } } : {}),
        ...(r.retryAfterSeconds ? { retryAfterSeconds: r.retryAfterSeconds } : {}),
      },
    },
    status,
  )
}

function unavailable(c: Context<AppEnv>) {
  return c.json(
    { error: { message: MESSAGES.billing_unavailable as string, code: "billing_unavailable" } },
    503,
  )
}

/** Run one call; a transport failure is 503, anything else is the caller's bug. */
async function forward<R>(run: () => Promise<R>): Promise<R | BillingUnavailableError> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof BillingUnavailableError) return err
    throw err
  }
}

const requestIdField = { requestId: z.uuid().optional() }
const plainBody = z.object(requestIdField).strict()

const changePlanBody = z.object({ ...requestIdField, targetPlan: cloudPlanSchema }).strict()
const frameSessionBody = z
  .object({
    ...requestIdField,
    action: frameSessionActionSchema,
    credits: z.number().int().positive().max(1_000_000).optional(),
    invoiceId: providerIdSchema.optional(),
  })
  .strict()
const topupBody = z
  .object({ ...requestIdField, credits: z.number().int().positive().max(1_000_000) })
  .strict()
const autoTopupBody = z
  .object({
    ...requestIdField,
    enabled: z.boolean(),
    thresholdCredits: z.number().int().nonnegative().max(1_000_000),
    amountCredits: z.number().int().positive().max(1_000_000),
  })
  .strict()

/** The PDF filename as a header value: plain ASCII, no quote or path. */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120)
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned || "invoice"}.pdf`
}

export const billingManagedRoutes = new Hono<AppEnv>()
  .get("/summary", async (c) => {
    const orgId = c.get("orgId") as string
    const reply = await forward(() =>
      callControlBilling("billing.summary", { requestId: randomUUID(), orgId }),
    )
    if (reply instanceof BillingUnavailableError) return unavailable(c)
    if (!reply.ok) return refusal(c, reply)
    return success(c, reply)
  })
  .post("/change-plan", zValidator("json", changePlanBody), async (c) => {
    const orgId = c.get("orgId") as string
    const body = c.req.valid("json")
    const usage = await currentPlanUsage(orgId)
    const reply = await forward(() =>
      callControlBilling("billing.change_plan", {
        requestId: body.requestId ?? randomUUID(),
        orgId,
        targetPlan: body.targetPlan,
        usage,
      }),
    )
    if (reply instanceof BillingUnavailableError) return unavailable(c)
    if (!reply.ok) return refusal(c, reply)
    return success(c, reply)
  })
  .post("/cancel", zValidator("json", plainBody), async (c) => {
    const orgId = c.get("orgId") as string
    const body = c.req.valid("json")
    const reply = await forward(() =>
      callControlBilling("billing.cancel", { requestId: body.requestId ?? randomUUID(), orgId }),
    )
    if (reply instanceof BillingUnavailableError) return unavailable(c)
    if (!reply.ok) return refusal(c, reply)
    return success(c, reply)
  })
  .post("/resume", zValidator("json", plainBody), async (c) => {
    const orgId = c.get("orgId") as string
    const body = c.req.valid("json")
    const reply = await forward(() =>
      callControlBilling("billing.resume", { requestId: body.requestId ?? randomUUID(), orgId }),
    )
    if (reply instanceof BillingUnavailableError) return unavailable(c)
    if (!reply.ok) return refusal(c, reply)
    return success(c, reply)
  })
  .post("/frame-session", zValidator("json", frameSessionBody), async (c) => {
    const orgId = c.get("orgId") as string
    const body = c.req.valid("json")
    const origin = env.LIAISON_PAY_FRAME_ORIGIN
    if (!origin) return unavailable(c)
    const reply = await forward(() =>
      callControlBilling("billing.frame_session", {
        requestId: body.requestId ?? randomUUID(),
        orgId,
        action: body.action,
        ...(body.credits !== undefined ? { credits: body.credits } : {}),
        ...(body.invoiceId !== undefined ? { invoiceId: body.invoiceId } : {}),
      }),
    )
    if (reply instanceof BillingUnavailableError) return unavailable(c)
    if (!reply.ok) return refusal(c, reply)
    return success(c, {
      token: reply.token,
      expiresAt: reply.expiresAt,
      frameOrigin: origin,
      frameUrl: `${origin}/?t=${encodeURIComponent(reply.token)}`,
    })
  })
  .get("/invoices", async (c) => {
    const orgId = c.get("orgId") as string
    const reply = await forward(() =>
      callControlBilling("billing.invoices", { requestId: randomUUID(), orgId }),
    )
    if (reply instanceof BillingUnavailableError) return unavailable(c)
    if (!reply.ok) return refusal(c, reply)
    return success(c, { invoices: reply.invoices, hasMore: reply.hasMore })
  })
  .get("/invoices/:id/pdf", async (c) => {
    const orgId = c.get("orgId") as string
    const id = providerIdSchema.safeParse(c.req.param("id"))
    if (!id.success) {
      return c.json({ error: { message: "invalid invoice id", code: "invalid_request" } }, 400)
    }
    const reply = await forward(() =>
      callControlBilling("billing.invoice_pdf", {
        requestId: randomUUID(),
        orgId,
        invoiceId: id.data,
      }),
    )
    if (reply instanceof BillingUnavailableError) return unavailable(c)
    if (!reply.ok) return refusal(c, reply)
    const bytes = Buffer.from(reply.base64, "base64")
    const sha = createHash("sha256").update(bytes).digest("hex")
    if (sha !== reply.sha256) {
      log.error({ orgId, invoiceId: id.data }, "invoice PDF digest mismatch")
      return c.json(
        { error: { message: "The invoice file arrived damaged.", code: "pdf_corrupt" } },
        502,
      )
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${safeFilename(reply.filename)}"`,
        "Cache-Control": "private, no-store",
      },
    })
  })
  .post("/topup", zValidator("json", topupBody), async (c) => {
    const orgId = c.get("orgId") as string
    const body = c.req.valid("json")
    const reply = await forward(() =>
      callControlBilling("billing.topup", {
        requestId: body.requestId ?? randomUUID(),
        orgId,
        credits: body.credits,
      }),
    )
    if (reply instanceof BillingUnavailableError) return unavailable(c)
    if (!reply.ok) return refusal(c, reply)
    return success(c, reply)
  })
  .put("/auto-topup", zValidator("json", autoTopupBody), async (c) => {
    const orgId = c.get("orgId") as string
    const body = c.req.valid("json")
    const reply = await forward(() =>
      callControlBilling("billing.auto_topup_settings", {
        requestId: body.requestId ?? randomUUID(),
        orgId,
        enabled: body.enabled,
        thresholdCredits: body.thresholdCredits,
        amountCredits: body.amountCredits,
      }),
    )
    if (reply instanceof BillingUnavailableError) return unavailable(c)
    if (!reply.ok) return refusal(c, reply)
    return success(c, reply)
  })
