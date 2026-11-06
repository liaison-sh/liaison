// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `/api/mail-sender/*`: the org's own sending domain (S29), shown in
// Settings → Organization → Email sender. Managed edition only (404
// otherwise, decided per request), org admins only (app.ts). The control plane
// holds the mail provider's account and creates, verifies and removes the
// domain; each route forwards one signed `mail.domain_*` message through the
// billing client and answers its reply:
//
//   GET    /status    the org's domain with its DNS records and status, or null
//   POST   /domain    {domain, requestId?}: add it
//   POST   /verify    {requestId?}: ask the provider to check the records again
//   DELETE /domain    remove it; mail goes back to the fallback sender
//
// Once the domain is verified the control plane pushes the sender and its
// sending key to `PUT /api/cloud/orgs/:id/mail-sender` (mail-sender.ts). The
// control plane unreachable → 503 `billing_unavailable`; a refusal keeps its
// code (`domain_limit`, `domain_taken` 409; `domain_invalid` 422), never with
// a provider or account detail.

import { randomUUID } from "node:crypto"
import { type CellBillingErrorReply, mailDomainNameSchema } from "@liaison/control-plane-contract"
import { type Context, Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { BillingUnavailableError, callControlBilling } from "../billing-managed/control-client"

export { managedBillingOnly as managedMailSenderOnly } from "../billing-managed/routes"

const STATUS_OF_CODE: Partial<Record<CellBillingErrorReply["code"], ContentfulStatusCode>> = {
  billing_unavailable: 503,
  not_trusted: 503,
  not_implemented: 503,
  invalid_request: 400,
  not_found: 404,
  rate_limited: 429,
  domain_invalid: 422,
}

const MESSAGES: Partial<Record<CellBillingErrorReply["code"], string>> = {
  billing_unavailable: "The email sender settings are unavailable right now. Try again shortly.",
  domain_limit: "This domain cannot be added right now; we have been told.",
  domain_invalid: "This is not a domain that can send mail.",
  domain_taken: "This domain is already used by another organization.",
}

function refusal(c: Context<AppEnv>, r: CellBillingErrorReply) {
  return c.json(
    {
      error: {
        message: MESSAGES[r.code] ?? r.code,
        code: r.code,
        ...(r.retryAfterSeconds ? { retryAfterSeconds: r.retryAfterSeconds } : {}),
      },
    },
    STATUS_OF_CODE[r.code] ?? 409,
  )
}

function unavailable(c: Context<AppEnv>) {
  return c.json(
    { error: { message: MESSAGES.billing_unavailable as string, code: "billing_unavailable" } },
    503,
  )
}

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
const addBody = z
  .object({
    ...requestIdField,
    domain: z.string().trim().toLowerCase().pipe(mailDomainNameSchema),
  })
  .strict()

export const mailSenderRoutes = new Hono<AppEnv>()
  .get("/status", async (c) => {
    const orgId = c.get("orgId") as string
    const reply = await forward(() =>
      callControlBilling("mail.domain_status", { requestId: randomUUID(), orgId }),
    )
    if (reply instanceof BillingUnavailableError) return unavailable(c)
    if (!reply.ok) return refusal(c, reply)
    return success(c, { domain: reply.domain })
  })
  .post("/domain", zValidator("json", addBody), async (c) => {
    const orgId = c.get("orgId") as string
    const body = c.req.valid("json")
    const reply = await forward(() =>
      callControlBilling("mail.domain_add", {
        requestId: body.requestId ?? randomUUID(),
        orgId,
        domain: body.domain,
      }),
    )
    if (reply instanceof BillingUnavailableError) return unavailable(c)
    if (!reply.ok) return refusal(c, reply)
    return success(c, { domain: reply.domain })
  })
  .post("/verify", zValidator("json", plainBody), async (c) => {
    const orgId = c.get("orgId") as string
    const body = c.req.valid("json")
    const reply = await forward(() =>
      callControlBilling("mail.domain_verify", {
        requestId: body.requestId ?? randomUUID(),
        orgId,
      }),
    )
    if (reply instanceof BillingUnavailableError) return unavailable(c)
    if (!reply.ok) return refusal(c, reply)
    return success(c, { domain: reply.domain })
  })
  .delete("/domain", async (c) => {
    const orgId = c.get("orgId") as string
    const reply = await forward(() =>
      callControlBilling("mail.domain_remove", { requestId: randomUUID(), orgId }),
    )
    if (reply instanceof BillingUnavailableError) return unavailable(c)
    if (!reply.ok) return refusal(c, reply)
    return success(c, { removed: true })
  })
