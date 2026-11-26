// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `webhook_status` (agent-visible, admins): what an admin needs to set up the Stripe webhook, in
// one read. The endpoint path (the kernel serves it at the org's public address), the exact
// events to select (the ones the event handler acts on, read from it), whether a signing secret
// is saved and whether a replaced one still verifies, and the connection's state.
//
// The secret itself is never read here: `config.has` answers without it. A person saves it on
// Settings > Apps > Stripe (Webhook) or on a secret request card (kind app_secret), never in a
// chat message, and `config apply` takes it from the environment.
//
// `verifyStripe` is the app's `provisioning.verify` (`liaison config verify --app stripe`): the
// key check of `connection_check`, plus the webhook secret, set or not.
import { type ConnectionCtx, decodeState, readInstall, runConnectionCheck } from "../connection"
import { PREVIOUS_SECRET_KEY, PREVIOUS_SECRET_UNTIL_KEY, SIGNING_SECRET_KEY } from "../verify"
import { WEBHOOK_EVENTS } from "../webhook-events"

/** The webhook endpoint the manifest declares (`webhooks.events`). */
export const WEBHOOK_ENDPOINT = "events"

export { WEBHOOK_EVENTS }

/** The shape of a signing secret Stripe shows for an endpoint (the manifest's pattern too). */
export const SIGNING_SECRET_PATTERN = /^whsec_[A-Za-z0-9]{16,}$/

export interface WebhookConfigCtx {
  orgId?: string
  config: {
    get(key: string): Promise<unknown>
    has(key: string): Promise<boolean>
  }
}

type WebhookCtx = ConnectionCtx & WebhookConfigCtx

export interface WebhookStatus {
  /** Path on this Liaison's public address; the settings page and the request card show the full address. */
  webhookPath: string
  events: readonly string[]
  secretSet: boolean
  /** A replaced secret still verifies until then (ISO), or null. */
  previousSecretUntil: string | null
  state: string
  summary: string
  next: string
}

async function previousUntil(ctx: WebhookConfigCtx, now: Date): Promise<string | null> {
  if (!(await ctx.config.has(PREVIOUS_SECRET_KEY))) return null
  const until = await ctx.config.get(PREVIOUS_SECRET_UNTIL_KEY)
  const ms = typeof until === "string" ? Date.parse(until) : Number.NaN
  return Number.isFinite(ms) && ms > now.getTime() ? new Date(ms).toISOString() : null
}

export async function webhookStatus(
  _params: Record<string, never>,
  ctx: WebhookCtx,
  now: Date = new Date(),
): Promise<WebhookStatus> {
  const install = await readInstall(ctx.db)
  const s = decodeState(install?.state)
  const state = s.overlay ? `${s.base}+${s.overlay}` : s.base
  const secretSet = await ctx.config.has(SIGNING_SECRET_KEY)
  const orgId = ctx.orgId ?? "<org>"
  const webhookPath = `/webhooks/${orgId}/stripe/${WEBHOOK_ENDPOINT}`
  const summary = secretSet
    ? "A webhook signing secret is saved: Stripe deliveries signed with it are accepted."
    : "No webhook signing secret is saved: deliveries cannot be verified, so Liaison catches up from Stripe's event log every 15 minutes instead."
  const next = secretSet
    ? "Nothing to do. To replace the secret (after rolling it in Stripe), save the new one: the old one keeps verifying for 24 hours."
    : `In Stripe, Developers > Webhooks > Add endpoint: the endpoint URL is this Liaison's address followed by ${webhookPath} (shown in full on Settings > Apps > Stripe and on the request card), with exactly these events: ${WEBHOOK_EVENTS.join(", ")}. Then reveal its signing secret (whsec_...) and have an admin save it: post a card with kernel__request_secret kind app_secret, target { app: "stripe", connection: "stripe", field: "webhookSigningSecret" }. Never ask for it in a message.`
  return {
    webhookPath,
    events: WEBHOOK_EVENTS,
    secretSet,
    previousSecretUntil: await previousUntil(ctx, now),
    state,
    summary,
    next,
  }
}

/** `provisioning.verify`: the key check, then the webhook secret, set or not. */
export async function verifyStripe(
  _input: { config?: Record<string, unknown> },
  ctx: WebhookCtx,
): Promise<{ ok: boolean; problems: string[]; identity?: string }> {
  const check = await runConnectionCheck(ctx)
  if ("error" in check) {
    return { ok: false, problems: [`${check.error.code}: ${check.error.message}`] }
  }
  const problems = check.checks
    .filter((c) => c.state !== "ok")
    .map((c) => `${c.label} (${c.level}): ${c.state}${c.meta ? `, ${c.meta}` : ""}`)
  const secret = (await ctx.config.has(SIGNING_SECRET_KEY))
    ? "webhook secret set"
    : "webhook secret not set"
  return {
    ok: problems.length === 0,
    problems,
    identity: `${check.mode} mode, ${check.state}, ${secret}`,
  }
}

/** `provisioning.handler`: the app has no setup of its own beyond its connection and secret. */
export async function provisionStripe(
  _input: { config?: Record<string, unknown>; dryRun?: boolean },
  _ctx: unknown,
): Promise<{ changed: string[] }> {
  return { changed: [] }
}
