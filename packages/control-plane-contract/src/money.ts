// SPDX-License-Identifier: FSL-1.1-ALv2
// Contract version 2, money messages:
//   - Control→cell (`/api/cloud/*`, signed per `./c2c.ts`): the billing push,
//     credit grants, the credit rate and the workspace lookup;
//   - cell→Control (the signed instance channel, endpoint `cell-billing`): the
//     Billing page's actions, the auto top-up request and the daily usage
//     report, the sending-domain messages and an org move's lease messages
//     (`./moves.ts`), each with its reply;
//   - the managed edition's `GET /api/billing/state` reply.
//
// Prices, minimums, rates and every display amount come from Control at run
// time; nothing here names one. No `node:*` import and no import of `./index`
// beyond the shared field helpers below (it re-exports this file).
import { z } from "zod"
import {
  CLOUD_API_BASE,
  CLOUD_ERROR_CODES,
  cloudCapsSchema,
  cloudErrorReplySchema,
  cloudPlanSchema,
  slugSchema,
} from "./c2c"
import { moveDataSchemas, moveOkReplySchemas } from "./moves"

// ── Shared field schemas ─────────────────────────────────────────────────────

/** A non-negative decimal string (credits, a cost), up to 12 integer and 8 fraction digits. */
export const decimalStringSchema = z.string().regex(/^[0-9]{1,12}(\.[0-9]{1,8})?$/)

/** A decimal string strictly above zero. */
export const positiveDecimalStringSchema = decimalStringSchema.refine((v) => /[1-9]/.test(v), {
  message: "must be greater than zero",
})

/** Whole credits a person types (a top-up, a threshold); Control enforces the minimum. */
const wholeCreditsSchema = z.number().int().positive().max(1_000_000)
const thresholdCreditsSchema = z.number().int().nonnegative().max(1_000_000)

/**
 * Billing status of an org: suspension is a status, not an endpoint (§3.4). One
 * monotonic lifecycle: `active|past_due → suspended → closed`, back to `active`
 * only on payment before closing. `closed`: every user credential is refused and
 * the org waits for deletion (`DELETE /orgs/:id`).
 */
export const cloudBillingStatusSchema = z.enum(["active", "past_due", "suspended", "closed"])

/** Plan → `organizations.tier`, so existing tier reads keep working in the managed edition (S16). */
export const CLOUD_PLAN_TIERS = { preview: "starter", base: "team", pro: "business" } as const
export const cloudTierSchema = z.enum(["starter", "team", "business"])

/** A short machine code such as `card_declined`. */
const codeSchema = z.string().regex(/^[a-z0-9_]{1,64}$/)

/** A payment-provider object id (an invoice id); opaque to the cell. */
export const providerIdSchema = z.string().regex(/^[A-Za-z0-9_]{1,255}$/)

/** A display string Control formats (amount with its currency); the cell shows it as is. */
const displaySchema = z.string().min(1).max(64)

/** An email address Control sends for people to write to (the billing contact). */
const contactAddressSchema = z.email().max(320)

/**
 * The uniform `{ok:false, code}` codes of limits and providers. Control answers
 * the first five on `cell-billing` (they are in `CELL_BILLING_ERROR_CODES`); the
 * cell answers `org_suspended` (403) and `payment_required` (402) to its own
 * clients, and the custom-app codes at app install.
 */
export const CLOUD_LIMIT_ERROR_CODES = {
  /** Metered use (a top-up, AI usage) is refused until the open invoice is paid. */
  paymentRequired: "payment_required",
  /** The org is suspended or closed: only export and Billing remain. */
  orgSuspended: "org_suspended",
  /** The org holds as many sending domains as it may. */
  domainLimit: "domain_limit",
  /** Not a domain the mail provider accepts. */
  domainInvalid: "domain_invalid",
  /** The domain is registered for another org. */
  domainTaken: "domain_taken",
  /** The org's `customApps` cap is reached. */
  customAppLimit: "custom_app_limit",
  /** A custom app asks for a capability an org-level app may not hold. */
  customAppCapability: "custom_app_capability",
} as const

export type CloudLimitErrorCode =
  (typeof CLOUD_LIMIT_ERROR_CODES)[keyof typeof CLOUD_LIMIT_ERROR_CODES]

/** Auto top-up settings as Control holds them (S22). */
export const cloudAutoTopUpSchema = z
  .object({
    enabled: z.boolean(),
    thresholdCredits: thresholdCreditsSchema,
    amountCredits: wholeCreditsSchema,
    /** The last failed auto top-up; a newer one raises one attention item for the org's admins. */
    lastFailure: z.object({ code: codeSchema, at: z.iso.datetime() }).strict().optional(),
  })
  .strict()

// ── Control→cell (§3.4) ──────────────────────────────────────────────────────

const ORG_ID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CUSTOM_APP_NAME_SEGMENT = /^[a-z][a-z0-9-]*-o[0-9a-f]{8}$/

function orgPath(orgId: string, suffix: string): string {
  if (!ORG_ID_SEGMENT.test(orgId)) throw new Error(`not an org id: ${JSON.stringify(orgId)}`)
  return `${CLOUD_API_BASE}/orgs/${orgId}${suffix}`
}

/** The cell-side pathname of each Control→cell endpoint (what a signer signs). */
export const cloudPaths = {
  orgs: () => `${CLOUD_API_BASE}/orgs`,
  /** `DELETE`: the org's deletion. */
  org: (orgId: string) => orgPath(orgId, ""),
  handoff: (orgId: string) => orgPath(orgId, "/handoff"),
  billing: (orgId: string) => orgPath(orgId, "/billing"),
  credits: (orgId: string) => orgPath(orgId, "/credits"),
  creditRate: () => `${CLOUD_API_BASE}/settings/credit-rate`,
  lookup: () => `${CLOUD_API_BASE}/lookup`,
  /** `PUT`: the org's own mail sender. */
  mailSender: (orgId: string) => orgPath(orgId, "/mail-sender"),
  /** `PUT`: the operator's kill switch for one of the org's custom apps. */
  customAppState: (orgId: string, name: string) => {
    if (!CUSTOM_APP_NAME_SEGMENT.test(name))
      throw new Error(`not an app name: ${JSON.stringify(name)}`)
    return orgPath(orgId, `/custom-apps/${name}/state`)
  },
} as const

/**
 * `POST /api/cloud/orgs/:id/billing` (S16, S22, S24). `version` is a monotonic
 * per-tenant Control sequence: the cell applies a push only when it is newer than
 * the one it holds, and answers `applied: false` otherwise.
 */
export const cloudNextPlanSchema = z.object({ id: cloudPlanSchema, caps: cloudCapsSchema }).strict()

export const cloudBillingPushRequestSchema = z
  .object({
    orgId: z.uuid(),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    plan: cloudPlanSchema,
    status: cloudBillingStatusSchema,
    periodEnd: z.iso.datetime(),
    /** The plan's included credits per period. */
    includedCredits: decimalStringSchema,
    caps: cloudCapsSchema,
    /**
     * The plan above this one and its caps, for the cell's refusal copy; null on
     * the largest plan; absent from a Control that predates it (read as null).
     */
    nextPlan: cloudNextPlanSchema.nullable().optional(),
    /** When Preview moves to Base; null outside Preview. */
    previewEndsAt: z.iso.datetime().nullable(),
    autoTopUp: cloudAutoTopUpSchema,
    /**
     * While `suspended`: until when admins can still export and pay (Control's
     * processing time of the suspension + 30 days). Null otherwise; absent from
     * a Control that predates it (read as null).
     */
    accessUntil: z.iso.datetime().nullable().optional(),
    /**
     * Set once, when Control closes the tenant; the cell's deletion fence reads
     * it. Null before; absent from a Control that predates it (read as null).
     */
    closedAt: z.iso.datetime().nullable().optional(),
    /** The address the suspended page shows, from Control's config. */
    billingContact: contactAddressSchema.optional(),
  })
  .strict()

export const cloudBillingPushReplySchema = z
  .object({
    ok: z.literal(true),
    /** False when the cell already held this version or a newer one. */
    applied: z.boolean(),
    /** The version the cell holds after this push. */
    version: z.number().int().positive(),
  })
  .strict()

export const cloudCreditGrantKindSchema = z.enum(["topup", "auto_topup", "period_reset"])

/**
 * `POST /api/cloud/orgs/:id/credits` (S17, S21, S22, S41). Idempotent on `grantId`
 * (the paid invoice's id); the same id with another amount is `grant_conflict`.
 * `period_reset` sets the period's included credits; the others add purchased credits.
 */
export const cloudCreditGrantRequestSchema = z
  .object({
    orgId: z.uuid(),
    grantId: providerIdSchema,
    credits: positiveDecimalStringSchema,
    kind: cloudCreditGrantKindSchema,
  })
  .strict()

export const cloudCreditGrantReplySchema = z
  .object({ ok: z.literal(true), grantId: providerIdSchema })
  .strict()

/**
 * The credit price of each fixed-price item: what one unit costs in
 * credits, set in Control and pushed with the rate.
 *  - `webCall`: one web search, or one page read through the search service;
 *  - `dictationMinute`: one minute of voice dictation (pro rata by the second).
 */
export const cloudUnitPricesSchema = z
  .object({ webCall: decimalStringSchema, dictationMinute: decimalStringSchema })
  .strict()

/** A fixed-price item a cell bills at its pushed credit price. */
export type CloudUnitItem = keyof z.infer<typeof cloudUnitPricesSchema>

/**
 * `PUT /api/cloud/settings/credit-rate` (S21): the cell's credit rate and the
 * fixed-price items' credit prices, applied only when `version` is newer. A
 * cell setting, never serialized to a client. A cell without one refuses
 * metered managed usage.
 */
export const cloudCreditRateRequestSchema = z
  .object({
    rate: z
      .string()
      .regex(/^[0-9]{1,4}(\.[0-9]{1,6})?$/)
      .refine((v) => /[1-9]/.test(v), { message: "must be greater than zero" }),
    unitPrices: cloudUnitPricesSchema,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()

export const cloudCreditRateReplySchema = cloudBillingPushReplySchema

/** `POST /api/cloud/lookup` (S43): the orgs on this cell where the email is a member. */
export const cloudLookupRequestSchema = z.object({ email: z.email().max(320) }).strict()

export const cloudLookupReplySchema = z
  .object({
    ok: z.literal(true),
    orgs: z
      .array(z.object({ slug: slugSchema, name: z.string().min(1).max(200) }).strict())
      .max(500),
  })
  .strict()

// ── Control→cell: org deletion and the org's mail sender ─────────────────

/** The id of the Control timer that asks (Control's idempotency key for the deletion). */
const timerIdSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/)

/**
 * `DELETE /api/cloud/orgs/:id`: deletes a closed org with the cell's
 * deletion core. Asynchronous: the first call queues it, Control calls again
 * (same `timerId`) until `done` or `failed`. A repeat answers the current state.
 */
export const cloudDeleteOrgRequestSchema = z
  .object({ orgId: z.uuid(), timerId: timerIdSchema })
  .strict()

export const CLOUD_DELETE_ORG_STATES = ["queued", "running", "done", "failed"] as const
export const cloudDeleteOrgStateSchema = z.enum(CLOUD_DELETE_ORG_STATES)

/**
 * The refusals of `DELETE /orgs/:id`, as `{ok:false, code}` (a 409). Only
 * `export_running` clears by itself; Control retries it later.
 */
export const CLOUD_DELETE_ORG_ERROR_CODES = {
  notClosed: CLOUD_ERROR_CODES.notClosed,
  closedTooRecently: CLOUD_ERROR_CODES.closedTooRecently,
  operatorOrg: CLOUD_ERROR_CODES.operatorOrg,
  exportRunning: CLOUD_ERROR_CODES.exportRunning,
} as const

export const cloudDeleteOrgOkReplySchema = z
  .object({ ok: z.literal(true), state: cloudDeleteOrgStateSchema })
  .strict()

export const cloudDeleteOrgReplySchema = z.union([
  cloudDeleteOrgOkReplySchema,
  cloudErrorReplySchema,
])

/** A lowercase domain name with at least two labels, e.g. `mail.example.com`. */
export const MAIL_DOMAIN_PATTERN =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export const mailDomainNameSchema = z.string().regex(MAIL_DOMAIN_PATTERN)

/**
 * `PUT /api/cloud/orgs/:id/mail-sender`: the org's verified sending domain,
 * its From address and a sending key restricted to that domain; `sender: null`
 * returns the org to the cell's fallback sender. Applied only when `version` is
 * newer than the one the cell holds (reply as the billing push). The key is
 * stored encrypted and never serialized to a client.
 */
export const cloudMailSenderRequestSchema = z
  .object({
    orgId: z.uuid(),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sender: z
      .object({
        domain: mailDomainNameSchema,
        fromAddress: z.email().max(320),
        key: z
          .string()
          .min(8)
          .max(512)
          .regex(/^[\x21-\x7e]+$/),
      })
      .strict()
      .nullable(),
  })
  .strict()

export const cloudMailSenderReplySchema = z
  .object({ ok: z.literal(true), applied: z.boolean(), version: z.number().int().positive() })
  .strict()

/**
 * `PUT /api/cloud/orgs/:id/custom-apps/:name/state`: the operator disables an
 * org's custom app during an incident (`disabled: true`, with the reason the
 * org's audit log records), or enables it again. A disabled custom app stays
 * installed with its data, but nothing runs it and its owner cannot replace or
 * remove it. Idempotent: the reply says the state the app is in.
 */
export const cloudCustomAppStateRequestSchema = z
  .object({
    orgId: z.uuid(),
    name: z.string().regex(CUSTOM_APP_NAME_SEGMENT),
    disabled: z.boolean(),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict()

export const cloudCustomAppStateReplySchema = z
  .object({ ok: z.literal(true), name: z.string(), disabled: z.boolean() })
  .strict()

export type CloudCustomAppStateRequest = z.infer<typeof cloudCustomAppStateRequestSchema>
export type CloudCustomAppStateReply = z.infer<typeof cloudCustomAppStateReplySchema>

export type CloudDeleteOrgRequest = z.infer<typeof cloudDeleteOrgRequestSchema>
export type CloudDeleteOrgState = z.infer<typeof cloudDeleteOrgStateSchema>
export type CloudDeleteOrgReply = z.infer<typeof cloudDeleteOrgReplySchema>
export type CloudMailSenderRequest = z.infer<typeof cloudMailSenderRequestSchema>
export type CloudMailSenderReply = z.infer<typeof cloudMailSenderReplySchema>

export type CloudBillingStatus = z.infer<typeof cloudBillingStatusSchema>
export type CloudAutoTopUp = z.infer<typeof cloudAutoTopUpSchema>
export type CloudBillingPushRequest = z.infer<typeof cloudBillingPushRequestSchema>
export type CloudBillingPushReply = z.infer<typeof cloudBillingPushReplySchema>
export type CloudCreditGrantRequest = z.infer<typeof cloudCreditGrantRequestSchema>
export type CloudCreditGrantReply = z.infer<typeof cloudCreditGrantReplySchema>
export type CloudCreditRateRequest = z.infer<typeof cloudCreditRateRequestSchema>
export type CloudUnitPrices = z.infer<typeof cloudUnitPricesSchema>
export type CloudCreditRateReply = z.infer<typeof cloudCreditRateReplySchema>
export type CloudLookupRequest = z.infer<typeof cloudLookupRequestSchema>
export type CloudLookupReply = z.infer<typeof cloudLookupReplySchema>

// ── cell→Control: the `cell-billing` endpoint ────────────────────────────────

/**
 * Control webhook every money message from a cell is posted to
 * (`<endpoint base>/cell-billing`), signed like the v1 instance messages
 * (`x-liaison-instance`, `x-liaison-signature`). Unlike `ENDPOINTS`, the
 * envelope `type` is the message type below, not the endpoint name. Control
 * accepts these only from a provisioned cell for an org it hosts (S40).
 */
export const CELL_BILLING_ENDPOINT = "cell-billing" as const

export const CELL_BILLING_MESSAGE_TYPES = [
  "billing.summary",
  "billing.change_plan",
  "billing.cancel",
  "billing.resume",
  "billing.frame_session",
  "billing.invoices",
  "billing.invoice_pdf",
  "billing.topup",
  "billing.auto_topup_settings",
  "billing.auto_topup_request",
  "usage.report",
  "apps.usage",
  "storage.estimate",
  "mail.domain_add",
  "mail.domain_status",
  "mail.domain_verify",
  "mail.domain_remove",
  "move.heartbeat",
  "move.status",
] as const

/** The org's sending-domain messages: Control holds the provider's full-access key. */
export const MAIL_DOMAIN_MESSAGE_TYPES = [
  "mail.domain_add",
  "mail.domain_status",
  "mail.domain_verify",
  "mail.domain_remove",
] as const

export type CellBillingMessageType = (typeof CELL_BILLING_MESSAGE_TYPES)[number]

/** Fields of every cell-billing message: the cell's request id (Control's idempotency key) and the org. */
const requestFields = { requestId: z.uuid(), orgId: z.uuid() }

const plainRequest = z.object(requestFields).strict()

/** Usage Control compares to the target plan's caps before a change (S17). */
export const cloudPlanUsageSchema = z
  .object({
    seats: z.number().int().nonnegative(),
    storageBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    customApps: z.number().int().nonnegative(),
    /**
     * The nightly estimate of everything the org occupies (files, mail, tickets, conversations,
     * knowledge, search). Information only: a plan's caps never compare to it, and it never blocks
     * a change. Absent from older cells and before the first measure.
     */
    storageEstimateBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict()

export const frameSessionActionSchema = z.enum(["card", "topup", "confirm_invoice"])

/** `card`: no extra field; `topup`: `credits`; `confirm_invoice`: `invoiceId`. */
const frameSessionDataSchema = z
  .object({
    ...requestFields,
    action: frameSessionActionSchema,
    invoiceId: providerIdSchema.optional(),
    credits: wholeCreditsSchema.optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const needs: Record<typeof d.action, readonly string[]> = {
      card: [],
      topup: ["credits"],
      confirm_invoice: ["invoiceId"],
    }
    const want = needs[d.action]
    for (const key of ["invoiceId", "credits"] as const) {
      const has = d[key] !== undefined
      if (has !== want.includes(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: has ? `not allowed for ${d.action}` : `required for ${d.action}`,
        })
      }
    }
  })

/** A UTC calendar day `YYYY-MM-DD`. */
const daySchema = z.iso.date()

export const cellBillingDataSchemas = {
  "billing.summary": plainRequest,
  "billing.change_plan": z
    .object({ ...requestFields, targetPlan: cloudPlanSchema, usage: cloudPlanUsageSchema })
    .strict(),
  "billing.cancel": plainRequest,
  "billing.resume": plainRequest,
  "billing.frame_session": frameSessionDataSchema,
  "billing.invoices": plainRequest,
  "billing.invoice_pdf": z.object({ ...requestFields, invoiceId: providerIdSchema }).strict(),
  "billing.topup": z.object({ ...requestFields, credits: wholeCreditsSchema }).strict(),
  "billing.auto_topup_settings": z
    .object({
      ...requestFields,
      enabled: z.boolean(),
      thresholdCredits: thresholdCreditsSchema,
      amountCredits: wholeCreditsSchema,
    })
    .strict(),
  /** `crossingId` names one threshold crossing on the cell (Control's idempotency key with the org). */
  "billing.auto_topup_request": z
    .object({ ...requestFields, crossingId: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/) })
    .strict(),
  /** One UTC day's provider-reported cost of the org, in USD, and its usage row count (S5d). */
  "usage.report": z
    .object({
      ...requestFields,
      day: daySchema,
      rawCostUsd: decimalStringSchema,
      rows: z.number().int().nonnegative(),
      /**
       * When the cell computed this report: Control keeps the newest per cell,
       * so a late retry never replaces a corrected one. Absent from older cells.
       */
      computedAt: z.iso.datetime().optional(),
    })
    .strict(),
  /**
   * One org's app usage of a UTC day on this cell, per (app, executor): runs,
   * bridge calls, wall and CPU milliseconds (`cpuMs` null when the executor
   * cannot measure it: QuickJS, or a Workers day not pulled from the loader
   * yet; the instance's own sandbox service, `workerd`, measures it per run). Separate from `usage.report`, so a Control that refuses it (one that
   * predates it) never loses the billing report. `capsVersion` is the caps
   * version the cell accepts (`CAPS_CONTRACT_VERSION`, c2c.ts): Control sends
   * the app cap kinds only to a cell that reported 2 or more. Sent daily for
   * every org of a managed cell, `rows` empty when nothing ran.
   */
  "apps.usage": z
    .object({
      ...requestFields,
      day: daySchema,
      capsVersion: z.number().int().min(1).max(1000),
      rows: z
        .array(
          z
            .object({
              app: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/),
              executor: z.enum(["workers", "workerd", "quickjs", "inprocess"]),
              runs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
              bridgeCalls: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
              wallMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
              cpuMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
            })
            .strict(),
        )
        .max(1000),
      computedAt: z.iso.datetime().optional(),
    })
    .strict(),
  /**
   * The org's nightly storage estimate crossed its plan's cap, up (`over`) or back down. Sent on a
   * crossing only, so Control gets nothing about an org under its cap. Information only.
   */
  "storage.estimate": z
    .object({
      ...requestFields,
      day: daySchema,
      estimatedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      capBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
      over: z.boolean(),
    })
    .strict(),
  /** Register `domain` as the org's sending domain (one per org unless Control says otherwise). */
  "mail.domain_add": z.object({ ...requestFields, domain: mailDomainNameSchema }).strict(),
  /** The org's sending domain as Control holds it, or null. */
  "mail.domain_status": plainRequest,
  /** Ask the provider to check the DNS records again. */
  "mail.domain_verify": plainRequest,
  /** Remove the org's sending domain and its sending key; mail goes back to the fallback sender. */
  "mail.domain_remove": plainRequest,
  /** An org move's lease (`./moves.ts`): heartbeat of the driving instance, and its outcome. */
  "move.heartbeat": moveDataSchemas["move.heartbeat"],
  "move.status": moveDataSchemas["move.status"],
} as const satisfies Record<CellBillingMessageType, z.ZodType>

export type CellBillingData<T extends CellBillingMessageType> = z.infer<
  (typeof cellBillingDataSchemas)[T]
>

function cellBillingEnvelope<T extends CellBillingMessageType>(type: T) {
  return z
    .object({
      v: z.literal(2),
      type: z.literal(type),
      messageId: z.uuid(),
      instanceId: z.uuid(),
      ts: z.iso.datetime(),
      data: cellBillingDataSchemas[type] as (typeof cellBillingDataSchemas)[T],
    })
    .strict()
}

/** Envelope schema per cell-billing message type (`v` is 2: these exist only in version 2). */
export const cellBillingMessageSchemas = {
  "billing.summary": cellBillingEnvelope("billing.summary"),
  "billing.change_plan": cellBillingEnvelope("billing.change_plan"),
  "billing.cancel": cellBillingEnvelope("billing.cancel"),
  "billing.resume": cellBillingEnvelope("billing.resume"),
  "billing.frame_session": cellBillingEnvelope("billing.frame_session"),
  "billing.invoices": cellBillingEnvelope("billing.invoices"),
  "billing.invoice_pdf": cellBillingEnvelope("billing.invoice_pdf"),
  "billing.topup": cellBillingEnvelope("billing.topup"),
  "billing.auto_topup_settings": cellBillingEnvelope("billing.auto_topup_settings"),
  "billing.auto_topup_request": cellBillingEnvelope("billing.auto_topup_request"),
  "usage.report": cellBillingEnvelope("usage.report"),
  "apps.usage": cellBillingEnvelope("apps.usage"),
  "storage.estimate": cellBillingEnvelope("storage.estimate"),
  "mail.domain_add": cellBillingEnvelope("mail.domain_add"),
  "mail.domain_status": cellBillingEnvelope("mail.domain_status"),
  "mail.domain_verify": cellBillingEnvelope("mail.domain_verify"),
  "mail.domain_remove": cellBillingEnvelope("mail.domain_remove"),
  "move.heartbeat": cellBillingEnvelope("move.heartbeat"),
  "move.status": cellBillingEnvelope("move.status"),
} as const satisfies Record<CellBillingMessageType, z.ZodType>

/** Any cell-billing message, discriminated on `type` (what the `cell-billing` dispatcher parses). */
export const cellBillingMessageSchema = z.discriminatedUnion("type", [
  cellBillingMessageSchemas["billing.summary"],
  cellBillingMessageSchemas["billing.change_plan"],
  cellBillingMessageSchemas["billing.cancel"],
  cellBillingMessageSchemas["billing.resume"],
  cellBillingMessageSchemas["billing.frame_session"],
  cellBillingMessageSchemas["billing.invoices"],
  cellBillingMessageSchemas["billing.invoice_pdf"],
  cellBillingMessageSchemas["billing.topup"],
  cellBillingMessageSchemas["billing.auto_topup_settings"],
  cellBillingMessageSchemas["billing.auto_topup_request"],
  cellBillingMessageSchemas["usage.report"],
  cellBillingMessageSchemas["apps.usage"],
  cellBillingMessageSchemas["storage.estimate"],
  cellBillingMessageSchemas["mail.domain_add"],
  cellBillingMessageSchemas["mail.domain_status"],
  cellBillingMessageSchemas["mail.domain_verify"],
  cellBillingMessageSchemas["mail.domain_remove"],
  cellBillingMessageSchemas["move.heartbeat"],
  cellBillingMessageSchemas["move.status"],
])

export type CellBillingMessage<T extends CellBillingMessageType = CellBillingMessageType> = {
  [K in CellBillingMessageType]: z.infer<(typeof cellBillingMessageSchemas)[K]>
}[T]

// ── cell-billing replies (the object under the kernel's `{data: ...}` envelope) ──

/**
 * Codes of the uniform `{ok:false, code}` reply. Control answers these with a 200
 * after any payment-provider call (never a throw, so the kernel never re-runs a
 * money action); the gate's refusals (S40) are a 403 instead.
 */
export const CELL_BILLING_ERROR_CODES = {
  /** Control or the payment provider cannot act now; the page says "try again shortly". */
  billingUnavailable: "billing_unavailable",
  /** The sender is not a provisioned cell hosting this org (S40). */
  notTrusted: "not_trusted",
  invalidRequest: "invalid_request",
  /** A handler not built yet. */
  notImplemented: "not_implemented",
  /** Current usage exceeds the target plan; `caps` names the exceeded keys. */
  capsExceeded: "caps_exceeded",
  /** An auto top-up already ran for this org this hour, or auto top-up is off. */
  autoTopUpLimited: "auto_topup_limited",
  /** The invoice PDF is above the reply cap; the page says to get it by mail. */
  pdfTooLarge: "pdf_too_large",
  notFound: "not_found",
  /** No card on file: the page opens the pay frame for this action. */
  noCard: "no_card",
  /** Below Control's top-up minimum (the minimum is in `billing.summary`'s `topUp`). */
  belowMinimum: "below_minimum",
  paymentFailed: "payment_failed",
  /** The bank asks for 3-D Secure off-session (auto top-up turns off, S22). */
  authenticationRequired: "authentication_required",
  samePlan: "same_plan",
  /** The target plan cannot be chosen from this one: Preview is an entry plan. */
  planNotOffered: "plan_not_offered",
  /** Another plan change is pending (unpaid upgrade or scheduled downgrade). */
  changePending: "change_pending",
  /** The org has no subscription to change, cancel or resume. */
  noSubscription: "no_subscription",
  rateLimited: "rate_limited",
  /** `billing.topup` (and auto top-up) while past due or suspended: pay the open invoice first. */
  paymentRequired: CLOUD_LIMIT_ERROR_CODES.paymentRequired,
  /** The org is suspended or closed. */
  orgSuspended: CLOUD_LIMIT_ERROR_CODES.orgSuspended,
  domainLimit: CLOUD_LIMIT_ERROR_CODES.domainLimit,
  domainInvalid: CLOUD_LIMIT_ERROR_CODES.domainInvalid,
  domainTaken: CLOUD_LIMIT_ERROR_CODES.domainTaken,
} as const

export type CellBillingErrorCode =
  (typeof CELL_BILLING_ERROR_CODES)[keyof typeof CELL_BILLING_ERROR_CODES]

export const cellBillingErrorReplySchema = z
  .object({
    ok: z.literal(false),
    code: z.enum(
      Object.values(CELL_BILLING_ERROR_CODES) as [CellBillingErrorCode, ...CellBillingErrorCode[]],
    ),
    /** Present exactly when `code` is `caps_exceeded`. */
    caps: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
    retryAfterSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .refine((r) => (r.code === "caps_exceeded") === (r.caps !== undefined), {
    path: ["caps"],
    message: "caps is present exactly for caps_exceeded",
  })

export const pendingPlanChangeSchema = z
  .object({
    targetPlan: cloudPlanSchema,
    effectiveAt: z.iso.datetime(),
    kind: z.enum(["upgrade_unpaid", "downgrade_scheduled"]),
    /** For `upgrade_unpaid`: the proration invoice the pay frame confirms. */
    invoiceId: providerIdSchema.optional(),
  })
  .strict()

export const billingSummaryReplySchema = z
  .object({
    ok: z.literal(true),
    plan: cloudPlanSchema,
    status: cloudBillingStatusSchema,
    periodEnd: z.iso.datetime(),
    previewEndsAt: z.iso.datetime().nullable(),
    /** Set when the subscription ends at period end (cancel); `billing.resume` clears it. */
    cancelAt: z.iso.datetime().nullable(),
    nextInvoice: z
      .object({ amountDisplay: displaySchema, date: z.iso.datetime() })
      .strict()
      .nullable(),
    plans: z
      .array(
        z
          .object({
            id: cloudPlanSchema,
            priceDisplay: displaySchema,
            includedCredits: decimalStringSchema,
            caps: cloudCapsSchema,
          })
          .strict(),
      )
      .min(1)
      .max(10),
    card: z
      .object({
        brand: z.string().min(1).max(32),
        last4: z.string().regex(/^[0-9]{4}$/),
        expMonth: z.number().int().min(1).max(12),
        expYear: z.number().int().min(2000).max(2200),
      })
      .strict()
      .optional(),
    /** Top-up terms, from Control config: the cell never holds a price. */
    topUp: z
      .object({
        minCredits: wholeCreditsSchema,
        unitPriceCents: z.number().int().positive(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict(),
    autoTopUp: cloudAutoTopUpSchema,
    pendingChange: pendingPlanChangeSchema.optional(),
    /** An invoice waiting for the customer's confirmation (3-D Secure, S42). */
    paymentAction: z
      .object({ invoiceId: providerIdSchema, amountDisplay: displaySchema })
      .strict()
      .optional(),
    /** The unpaid renewal invoice while past due or suspended: paying it resumes the org. */
    openInvoice: z
      .object({
        invoiceId: providerIdSchema,
        amountDisplay: displaySchema,
        dueAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
    /**
     * The page comparing every plan in full, linked under the cell's comparison
     * table; without it the cell shows no link. An https URL, checked without
     * the `URL` global (see c2c.ts).
     */
    pricingUrl: z
      .string()
      .max(2048)
      .regex(/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:[/?#][^\s]*)?$/)
      .optional(),
  })
  .strict()

const okOnly = z.object({ ok: z.literal(true) }).strict()

/** `requires_action`: the page confirms `invoiceId` in the pay frame. */
const changePlanReplySchema = z
  .object({
    ok: z.literal(true),
    result: z.enum(["changed", "scheduled", "requires_action"]),
    effectiveAt: z.iso.datetime(),
    invoiceId: providerIdSchema.optional(),
  })
  .strict()
  .refine((r) => r.result !== "requires_action" || r.invoiceId !== undefined, {
    path: ["invoiceId"],
    message: "requires_action names the invoice",
  })

/** Base64 of the raw bytes. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export const invoiceListItemSchema = z
  .object({
    id: providerIdSchema,
    number: z.string().min(1).max(64).nullable(),
    kind: z.enum(["invoice", "credit_note"]),
    issuedAt: z.iso.datetime(),
    amountDisplay: displaySchema,
    status: z.enum(["open", "paid", "void", "uncollectible"]),
  })
  .strict()

/**
 * The provider's verification state, normalized by Control: a partial or
 * temporary failure reads `pending`.
 */
export const MAIL_DOMAIN_STATUSES = ["not_started", "pending", "verified", "failed"] as const

/** One DNS record the org adds for its sending domain. */
export const mailDomainRecordSchema = z
  .object({
    type: z.string().regex(/^[A-Z]{1,10}$/),
    name: z.string().min(1).max(255),
    value: z.string().min(1).max(4096),
    priority: z.number().int().nonnegative().max(65535).optional(),
    /** Seconds, or the provider's word for its default (`Auto`). */
    ttl: z.union([z.number().int().positive(), z.string().min(1).max(16)]).optional(),
  })
  .strict()

export const mailDomainSchema = z
  .object({
    /** The provider's domain id (opaque to the cell). */
    id: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
    name: mailDomainNameSchema,
    status: z.enum(MAIL_DOMAIN_STATUSES),
    records: z.array(mailDomainRecordSchema).max(20),
  })
  .strict()

const mailDomainReplySchema = z.object({ ok: z.literal(true), domain: mailDomainSchema }).strict()

/** 32 random bytes, base64url without padding. */
const FRAME_TOKEN = /^[A-Za-z0-9_-]{43}$/

export const cellBillingOkReplySchemas = {
  "billing.summary": billingSummaryReplySchema,
  "billing.change_plan": changePlanReplySchema,
  "billing.cancel": z.object({ ok: z.literal(true), cancelAt: z.iso.datetime() }).strict(),
  "billing.resume": okOnly,
  /** The cell builds the frame URL from its pay-frame origin setting and this token (5 min, one use). */
  "billing.frame_session": z
    .object({
      ok: z.literal(true),
      token: z.string().regex(FRAME_TOKEN),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
  "billing.invoices": z
    .object({
      ok: z.literal(true),
      invoices: z.array(invoiceListItemSchema).max(100),
      hasMore: z.boolean(),
    })
    .strict(),
  "billing.invoice_pdf": z
    .object({
      ok: z.literal(true),
      filename: z.string().min(1).max(255),
      contentType: z.literal("application/pdf"),
      base64: z.string().min(1).regex(BASE64),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  /** `paid`: credits arrive through a credit grant with `grantId = invoiceId`. */
  "billing.topup": z.discriminatedUnion("result", [
    z
      .object({
        ok: z.literal(true),
        result: z.literal("paid"),
        invoiceId: providerIdSchema,
        credits: wholeCreditsSchema,
      })
      .strict(),
    z
      .object({
        ok: z.literal(true),
        result: z.literal("requires_action"),
        invoiceId: providerIdSchema,
      })
      .strict(),
  ]),
  "billing.auto_topup_settings": z
    .object({ ok: z.literal(true), autoTopUp: cloudAutoTopUpSchema })
    .strict(),
  "billing.auto_topup_request": z
    .object({ ok: z.literal(true), invoiceId: providerIdSchema, credits: wholeCreditsSchema })
    .strict(),
  "usage.report": okOnly,
  "apps.usage": okOnly,
  "storage.estimate": okOnly,
  "mail.domain_add": mailDomainReplySchema,
  "mail.domain_status": z
    .object({ ok: z.literal(true), domain: mailDomainSchema.nullable() })
    .strict(),
  "mail.domain_verify": mailDomainReplySchema,
  "mail.domain_remove": okOnly,
  "move.heartbeat": moveOkReplySchemas["move.heartbeat"],
  "move.status": moveOkReplySchemas["move.status"],
} as const satisfies Record<CellBillingMessageType, z.ZodType>

/** The full reply of each type: its ok shape or the uniform error. */
export const cellBillingReplySchemas = Object.fromEntries(
  CELL_BILLING_MESSAGE_TYPES.map((t) => [
    t,
    z.union([cellBillingOkReplySchemas[t], cellBillingErrorReplySchema]),
  ]),
) as {
  [K in CellBillingMessageType]: z.ZodUnion<
    [(typeof cellBillingOkReplySchemas)[K], typeof cellBillingErrorReplySchema]
  >
}

export type CellBillingErrorReply = z.infer<typeof cellBillingErrorReplySchema>
export type CellBillingOkReply<T extends CellBillingMessageType> = z.infer<
  (typeof cellBillingOkReplySchemas)[T]
>
export type CellBillingReply<T extends CellBillingMessageType> =
  | CellBillingOkReply<T>
  | CellBillingErrorReply
export type BillingSummaryReply = z.infer<typeof billingSummaryReplySchema>
export type MailDomain = z.infer<typeof mailDomainSchema>
export type MailDomainRecord = z.infer<typeof mailDomainRecordSchema>
export type MailDomainStatus = (typeof MAIL_DOMAIN_STATUSES)[number]
export type InvoiceListItem = z.infer<typeof invoiceListItemSchema>

// ── Managed `GET /api/billing/state` (served by the cell from the last push) ──

/** No portal or checkout URL; self-hosted keeps its own reply. */
export const managedBillingStateSchema = z
  .object({
    mode: z.literal("managed"),
    plan: cloudPlanSchema,
    tier: cloudTierSchema,
    status: cloudBillingStatusSchema,
    periodEnd: z.iso.datetime(),
    includedCredits: decimalStringSchema,
    previewEndsAt: z.iso.datetime().nullable(),
    autoTopUp: cloudAutoTopUpSchema,
    /** From the last push: this plan's caps, for the refusal copy. */
    caps: cloudCapsSchema.optional(),
    /** From the last push: the plan above and its caps; null on the largest plan. */
    nextPlan: cloudNextPlanSchema.nullable().optional(),
    /** From the last push: until when a suspended org keeps export and Billing. */
    accessUntil: z.iso.datetime().nullable().optional(),
    /** From the last push: the address the suspended page shows. */
    billingContact: contactAddressSchema.optional(),
  })
  .strict()

export type ManagedBillingState = z.infer<typeof managedBillingStateSchema>
