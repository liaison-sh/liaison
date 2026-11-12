// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pennylane e-invoicing webhooks (endpoint `einvoicing`, `POST /webhooks/:orgId/pennylane/einvoicing`).
//
// Verify: `X-Pennylane-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`,
// |now − t| ≤ 300 s, constant-time compare (host bridge), replay key = the envelope id (900 s).
// The secret is the one Pennylane returned once when the subscription was created, held by the
// kernel app-secret capability (never in a tool result, approval card or log line).
// Handle: acknowledge at once and record WHICH invoice may have changed; the payload is never
// trusted for the status itself (the caller re-reads it through get_einvoice_status).
//
// Setup: the gated `webhooks_setup` tool subscribes the two e-invoicing events with a callback
// built from the instance's public base URL (remembered from the connection event, or passed).
import { lowercaseHeaderKeys } from "@liaison/app-sdk/webhook-verify"
import type { PennylaneToolCtx } from "../ctx"
import { getClient } from "../lib/get-client"
import { PennylaneClient } from "../lib/pennylane-client"
import { fromException, type OpError, opError } from "./errors"
import { recordStatusChange } from "./inbox"

export const WEBHOOK_SECRET_KEY = "einvoicingWebhookSecret"
export const WEBHOOK_EVENTS = [
  "customer_invoice.e_invoicing_status_updated",
  "supplier_invoice.e_invoicing_received",
] as const
const MAX_SKEW_SECONDS = 300
const REPLAY_TTL_SECONDS = 900

export interface VerifyBridge {
  config_get(key: string): Promise<unknown>
  crypto_hmacSha256Hex(secret: string, body: string): Promise<string>
  crypto_timingSafeEqual(a: string, b: string): Promise<boolean>
}

export function parseSignature(header: string | undefined): { t: number; v1: string } | null {
  if (!header) return null
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=")
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]
    }),
  )
  const t = Number(parts.t)
  if (!Number.isInteger(t) || !parts.v1 || !/^[0-9a-f]+$/i.test(parts.v1)) return null
  return { t, v1: parts.v1.toLowerCase() }
}

export async function verifyEinvoicingWebhook(
  params: {
    headers: Record<string, string>
    body: string
    method: string
    query: Record<string, string>
  },
  bridge: VerifyBridge,
  now: () => number = () => Date.now(),
): Promise<{ ok: boolean; reason?: string; replayKey?: string; replayTtlSeconds?: number }> {
  const headers = lowercaseHeaderKeys(params.headers)
  const sig = parseSignature(headers["x-pennylane-signature"])
  if (!sig) return { ok: false, reason: "missing_signature" }
  const secret = (await bridge.config_get(WEBHOOK_SECRET_KEY)) as string | null
  if (!secret) return { ok: false, reason: "missing_secret" }
  if (Math.abs(Math.floor(now() / 1000) - sig.t) > MAX_SKEW_SECONDS)
    return { ok: false, reason: "stale_timestamp" }
  const expected = await bridge.crypto_hmacSha256Hex(secret, `${sig.t}.${params.body}`)
  if (!(await bridge.crypto_timingSafeEqual(sig.v1, expected)))
    return { ok: false, reason: "signature_mismatch" }
  let envelopeId: string | null = null
  try {
    const id = (JSON.parse(params.body) as { id?: unknown }).id
    envelopeId = id === undefined || id === null ? null : String(id)
  } catch {
    return { ok: false, reason: "invalid_json" }
  }
  return {
    ok: true,
    replayKey: envelopeId ? `envelope:${envelopeId}` : `sig:${sig.v1}`,
    replayTtlSeconds: REPLAY_TTL_SECONDS,
  }
}

interface Envelope {
  id?: string | number
  type?: string
  event?: string
  data?: {
    object?: { id?: string | number }
    data?: { id?: string | number }
    id?: string | number
  }
}

/** The webhook handler: record which invoice may have changed, acknowledge. */
export async function einvoicingWebhookHandler(
  payload: Envelope,
  ctx: Pick<PennylaneToolCtx, "db" | "logger">,
): Promise<{ status: number }> {
  const type = String(payload?.type ?? payload?.event ?? "")
  const ref = payload?.data?.object?.id ?? payload?.data?.data?.id ?? payload?.data?.id
  if (ref === undefined || ref === null) {
    ctx.logger?.warn?.("pennylane einvoicing webhook without an object id", { type })
    return { status: 200 }
  }
  const kind = type.startsWith("supplier_invoice.")
    ? "supplier_invoice"
    : type.startsWith("customer_invoice.")
      ? "customer_invoice"
      : null
  if (!kind) return { status: 200 } // other events (e.g. dms_file.created) are not ours
  await recordStatusChange(ctx, {
    provider_ref: String(ref),
    kind,
    event_type: type,
    envelope_id: payload.id === undefined ? null : String(payload.id),
  })
  return { status: 200 }
}

// ---------------------------------------------------------------------------------------------
// Setup (gated tool) and the stored base URL.

export const BASE_URL_KEY = "kernel_public_base_url"
export const SUBSCRIPTION_KEY = "einvoicing_webhook_subscription"

type SetupCtx = PennylaneToolCtx & {
  config: {
    get(key: string): Promise<unknown>
    setSecret(key: string, value: string): Promise<void>
  }
  getOrgId?: () => Promise<string> | string
}

type ConfigDb = {
  db: {
    findMany(
      entity: string,
      opts?: { where?: Record<string, unknown>; limit?: number },
    ): Promise<unknown[]>
    insert(entity: string, data: Record<string, unknown>): Promise<unknown>
    update(entity: string, id: string, data: Record<string, unknown>): Promise<unknown>
  }
}

async function appConfig(
  ctx: ConfigDb,
  key: string,
): Promise<{ id: string; value: unknown } | null> {
  const rows = (await ctx.db.findMany("app_config", { where: { key }, limit: 1 })) as Array<{
    id: string
    value: unknown
  }>
  return rows[0] ?? null
}

export async function setAppConfig(ctx: ConfigDb, key: string, value: unknown): Promise<void> {
  const row = await appConfig(ctx, key)
  const v = JSON.stringify(value)
  if (row) await ctx.db.update("app_config", row.id, { value: v })
  else await ctx.db.insert("app_config", { key, value: v })
}

export async function readAppConfig<T>(ctx: ConfigDb, key: string): Promise<T | null> {
  const row = await appConfig(ctx, key)
  if (!row) return null
  try {
    return (typeof row.value === "string" ? JSON.parse(row.value) : row.value) as T
  } catch {
    return null
  }
}

export async function webhooksSetup(
  params: { callback_base_url?: string },
  ctx: SetupCtx,
): Promise<
  | {
      status: "completed"
      subscription_id: number
      callback_url: string
      events: readonly string[]
      replaced: boolean
    }
  | OpError
> {
  const stored = await readAppConfig<string>(ctx, BASE_URL_KEY)
  const base = (params?.callback_base_url || stored || "").replace(/\/$/, "")
  if (!/^https:\/\//.test(base)) {
    return opError(
      "callback_base_url_missing",
      "The instance's public HTTPS address is not known yet: reconnect Pennylane, or pass callback_base_url (the address Liaison is reached at).",
    )
  }
  const orgId = ctx.orgId ?? (ctx.getOrgId ? await ctx.getOrgId() : "")
  const callbackUrl = `${base}/webhooks/${orgId}/pennylane/einvoicing`
  let client: PennylaneClient
  try {
    client = ctx.__client instanceof PennylaneClient ? ctx.__client : (await getClient(ctx)).client
  } catch (e) {
    return fromException(e, "webhooks_setup")
  }
  try {
    const page = await client.list<{ id: number; callback_url: string }>("/webhook_subscriptions", {
      limit: 100,
    })
    const mine = page.items.filter((s) => s.callback_url === callbackUrl)
    // The secret is returned only at creation: a subscription we hold no secret for cannot be
    // verified, so it is replaced rather than kept.
    for (const s of mine) await client.request("DELETE", `/webhook_subscriptions/${s.id}`)
    const created = await client.post<{ id: number; secret?: string }>("/webhook_subscriptions", {
      callback_url: callbackUrl,
      events: [...WEBHOOK_EVENTS],
      enabled: true,
    })
    const secret = created.data?.secret
    if (!secret)
      return opError(
        "provider_rejected",
        "Pennylane created the subscription without returning its signing secret",
      )
    await ctx.config.setSecret(WEBHOOK_SECRET_KEY, secret)
    await setAppConfig(ctx, SUBSCRIPTION_KEY, {
      id: created.data.id,
      callback_url: callbackUrl,
      events: WEBHOOK_EVENTS,
      at: new Date().toISOString(),
    })
    if (params?.callback_base_url) await setAppConfig(ctx, BASE_URL_KEY, base)
    return {
      status: "completed",
      subscription_id: created.data.id,
      callback_url: callbackUrl,
      events: WEBHOOK_EVENTS,
      replaced: mine.length > 0,
    }
  } catch (e) {
    return fromException(e, "webhooks_setup")
  }
}
