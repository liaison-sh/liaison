// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The signed Control→cell API, mounted at `/api/cloud` (spec §3.4): create an
// org, hand its owner a sign-in link, push its billing state, grant credits,
// set the credit rate, look up an email's workspaces, delete a closed org,
// push the org's own mail sender. These routes are outside the suspension
// gate (suspension.ts): a suspended or closed org still receives them. Exists in the managed
// edition only: on a self-hosted instance every path answers 404, checked per
// request so the edition is read as configured. Every request passes
// `verifyCloudRequest` (verify.ts) before any handler runs.

import {
  CLOUD_ERROR_CODES,
  cloudBillingPushRequestSchema,
  cloudCreateOrgRequestSchema,
  cloudCreditGrantRequestSchema,
  cloudCreditRateRequestSchema,
  cloudCustomAppStateRequestSchema,
  cloudDeleteOrgRequestSchema,
  cloudHandoffRequestSchema,
  cloudLookupRequestSchema,
  cloudMailSenderRequestSchema,
} from "@liaison/control-plane-contract"
import { orgCapsSchema } from "@liaison/shared"
import { Hono } from "hono"
import { isManagedEdition } from "~/lib/edition"
import { applyBillingPush } from "./billing"
import { createCloudOrgWithinBudget } from "./create-org"
import { applyCreditRate } from "./credit-rate"
import { applyCreditGrant } from "./credits"
import { setCustomAppState } from "./custom-app-disable"
import { deleteCloudOrg } from "./delete-org"
import { cloudHandoff } from "./handoff"
import { lookupOrgsByEmail } from "./lookup"
import { applyMailSender } from "./mail-sender"
import { purgeExpiredOutcomes } from "./outcomes"
import { type CloudEnv, cloudError, verifyCloudRequest } from "./verify"

export const cloudRoutes = new Hono<CloudEnv>()

cloudRoutes.use("*", async (c, next) => {
  if (!isManagedEdition()) return c.notFound()
  await next()
})
cloudRoutes.use("*", verifyCloudRequest)
// Outcomes past their lifetime (a handoff's sealed link) go before any handler reads the store.
cloudRoutes.use("*", async (_c, next) => {
  await purgeExpiredOutcomes()
  await next()
})

cloudRoutes.post("/orgs", async (c) => {
  const parsed = cloudCreateOrgRequestSchema.safeParse(c.get("cloudBody"))
  const caps = orgCapsSchema.safeParse(parsed.success ? (parsed.data.caps ?? {}) : {})
  if (!parsed.success || !caps.success) {
    return cloudError(c, 400, CLOUD_ERROR_CODES.invalidRequest)
  }
  const { status, reply } = await createCloudOrgWithinBudget({
    ...parsed.data,
    caps: parsed.data.caps === undefined ? undefined : caps.data,
  })
  return c.json(reply, status)
})

cloudRoutes.post("/orgs/:id/handoff", async (c) => {
  const parsed = cloudHandoffRequestSchema.safeParse(c.get("cloudBody"))
  if (!parsed.success) return cloudError(c, 400, CLOUD_ERROR_CODES.invalidRequest)
  const { status, reply } = await cloudHandoff(parsed.data.orgId, c.get("cloudMessageId"))
  return c.json(reply, status)
})

cloudRoutes.post("/orgs/:id/billing", async (c) => {
  const parsed = cloudBillingPushRequestSchema.safeParse(c.get("cloudBody"))
  const caps = orgCapsSchema.safeParse(parsed.success ? parsed.data.caps : {})
  if (!parsed.success || !caps.success || parsed.data.orgId !== c.req.param("id")) {
    return cloudError(c, 400, CLOUD_ERROR_CODES.invalidRequest)
  }
  const { status, reply } = await applyBillingPush(parsed.data, caps.data)
  return c.json(reply, status)
})

cloudRoutes.post("/orgs/:id/credits", async (c) => {
  const parsed = cloudCreditGrantRequestSchema.safeParse(c.get("cloudBody"))
  if (!parsed.success || parsed.data.orgId !== c.req.param("id")) {
    return cloudError(c, 400, CLOUD_ERROR_CODES.invalidRequest)
  }
  const { status, reply } = await applyCreditGrant(parsed.data)
  return c.json(reply, status)
})

cloudRoutes.put("/settings/credit-rate", async (c) => {
  const parsed = cloudCreditRateRequestSchema.safeParse(c.get("cloudBody"))
  if (!parsed.success) return cloudError(c, 400, CLOUD_ERROR_CODES.invalidRequest)
  return c.json(await applyCreditRate(parsed.data), 200)
})

cloudRoutes.post("/lookup", async (c) => {
  const parsed = cloudLookupRequestSchema.safeParse(c.get("cloudBody"))
  if (!parsed.success) return cloudError(c, 400, CLOUD_ERROR_CODES.invalidRequest)
  return c.json(await lookupOrgsByEmail(parsed.data.email), 200)
})

cloudRoutes.delete("/orgs/:id", async (c) => {
  const parsed = cloudDeleteOrgRequestSchema.safeParse(c.get("cloudBody"))
  if (!parsed.success || parsed.data.orgId !== c.req.param("id")) {
    return cloudError(c, 400, CLOUD_ERROR_CODES.invalidRequest)
  }
  const { status, reply } = await deleteCloudOrg(parsed.data)
  return c.json(reply, status)
})

cloudRoutes.put("/orgs/:id/mail-sender", async (c) => {
  const parsed = cloudMailSenderRequestSchema.safeParse(c.get("cloudBody"))
  if (!parsed.success || parsed.data.orgId !== c.req.param("id")) {
    return cloudError(c, 400, CLOUD_ERROR_CODES.invalidRequest)
  }
  const { status, reply } = await applyMailSender(parsed.data)
  return c.json(reply, status)
})

cloudRoutes.put("/orgs/:id/custom-apps/:name/state", async (c) => {
  const parsed = cloudCustomAppStateRequestSchema.safeParse(c.get("cloudBody"))
  if (
    !parsed.success ||
    parsed.data.orgId !== c.req.param("id") ||
    parsed.data.name !== c.req.param("name")
  ) {
    return cloudError(c, 400, CLOUD_ERROR_CODES.invalidRequest)
  }
  const { status, reply } = await setCustomAppState(parsed.data, c.get("cloudMessageId"))
  return c.json(reply, status)
})
