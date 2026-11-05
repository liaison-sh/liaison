// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `webhooks_setup`: point Meta's Facebook Page webhooks at this instance's `meta` endpoint.
//
// Two subscriptions are needed before Meta delivers anything, and nothing else in the app makes
// either of them:
//   1. App level: the Meta app's `page` object subscription (`POST /{app-id}/subscriptions`, app
//      access token `{app-id}|{app-secret}`) names the callback URL, the fields and the verify
//      token. Meta checks the callback at once with the `hub.challenge` handshake, which the kernel
//      answers against the app config key `webhookVerifyToken` (webhooks/routes.ts). The token is
//      provisioned here (an app-held secret, encrypted at rest) BEFORE the subscription is sent.
//   2. Page level: each managed Page subscribes this app (`POST /{page-id}/subscribed_apps`, Page
//      token). This needs `pages_manage_metadata` on the user's grant.
// The fields are exactly what the parser reads (facebook adapter `parseWebhook`): `feed` changes
// (comments, read from the change values, so `include_values=true`) and `messages` (Messenger).
//
// Idempotent: a subscription that already matches is left alone and reported `unchanged`; a Page
// already subscribed to both fields is not posted again, and a Page's other subscribed fields are
// kept. A Page that fails is reported with its Graph error, never dropped.
import { FB_BASE } from "./adapters/facebook"
import { BASE_URL_METADATA_KEY, resolveAccessToken } from "./connection"
import type { SocialToolCtx } from "./ctx"

export const META_APP_SECRET_KEY = "socialMetaAppSecret"
export const VERIFY_TOKEN_KEY = "webhookVerifyToken"
export const WEBHOOK_FIELDS = ["feed", "messages"] as const
const WEBHOOK_ENDPOINT = "meta"

type SetupCtx = SocialToolCtx & {
  config: { get(key: string): Promise<unknown>; setSecret?(key: string, value: string): Promise<void> }
}

export interface SetupError {
  status: "error"
  error: { code: string; message: string }
}

export interface PageResult {
  page_id: string
  name: string | null
  account_external_id: string
  status: "subscribed" | "unchanged" | "failed"
  subscribed_fields?: string[]
  error?: string
}

export interface SetupResult {
  status: "completed" | "partial"
  callback_url: string
  app: { app_id: string; status: "subscribed" | "unchanged"; fields: string[] }
  pages: PageResult[]
  failed_pages: number
}

function fail(code: string, message: string): SetupError {
  return { status: "error", error: { code, message } }
}

class GraphError extends Error {}

async function graph<T>(
  ctx: SocialToolCtx,
  url: string,
  init: { method?: string; token?: string; body?: Record<string, unknown> } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  if (init.body) headers["content-type"] = "application/json"
  const res = await ctx.fetch(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  })
  let parsed: unknown = {}
  try {
    parsed = res.body ? JSON.parse(res.body) : {}
  } catch {
    throw new GraphError(`HTTP ${res.status}, unparseable body`)
  }
  const err = (parsed as { error?: { message?: string; code?: number } }).error
  if (res.status < 200 || res.status >= 300 || err) {
    throw new GraphError(`HTTP ${res.status}${err ? ` (#${err.code ?? "?"}) ${err.message ?? ""}`.trimEnd() : ""}`)
  }
  return parsed as T
}

function metadataOf(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      return (JSON.parse(v) as Record<string, unknown>) ?? {}
    } catch {
      return {}
    }
  }
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
}

interface Prereqs {
  accounts: string[]
  callbackUrl: string
  appSecret: string
}

/** Everything knowable before an approval: a connected account, the callback, the app secret. */
async function prerequisites(params: { callback_base_url?: string }, ctx: SetupCtx): Promise<Prereqs | SetupError> {
  const rows = (await ctx.db.findMany("sync_state", { where: { platform: "facebook", active: true } })) as Array<{
    account_external_id: string
    metadata?: unknown
  }>
  const accounts = [...new Set(rows.map((r) => r.account_external_id))]
  if (accounts.length === 0) {
    return fail("not_connected", "No Facebook account is connected: connect Facebook in Settings, Social first.")
  }
  const stored = rows.map((r) => metadataOf(r.metadata)[BASE_URL_METADATA_KEY]).find((v) => typeof v === "string" && v)
  const base = String(params?.callback_base_url || stored || "").replace(/\/+$/, "")
  if (!/^https:\/\/[^/\s]+/.test(base)) {
    return fail(
      "callback_base_url_missing",
      "The instance's public HTTPS address is not known: reconnect Facebook, or pass callback_base_url (the https address Liaison is reached at).",
    )
  }
  const appSecret = await ctx.config.get(META_APP_SECRET_KEY)
  if (typeof appSecret !== "string" || !appSecret) {
    return fail(
      "app_secret_missing",
      "The Meta app secret is not stored: provision the Facebook OAuth client (client id and secret) and reconnect Facebook.",
    )
  }
  // The sandbox leaves `ctx.orgId` unset and exposes the org through `getOrgId()`; a callback
  // without it ("/webhooks/undefined/...") would be refused by Meta or route nowhere.
  const orgId = ctx.orgId || (ctx.getOrgId ? await ctx.getOrgId() : "")
  if (!orgId) return fail("org_unknown", "The organization of this install is not known to the app host.")
  return { accounts, callbackUrl: `${base}/webhooks/${orgId}/social/${WEBHOOK_ENDPOINT}`, appSecret }
}

/**
 * A random token for the hub.challenge handshake. The app sandbox has no typed arrays and no
 * `crypto`, so it is drawn hex digit by hex digit; it only has to be unguessable to a caller
 * of the verify endpoint, and is stored as an app secret.
 */
function newVerifyToken(): string {
  let token = ""
  for (let i = 0; i < 48; i++) token += Math.floor(Math.random() * 16).toString(16)
  return token
}

async function ensureVerifyToken(ctx: SetupCtx): Promise<string> {
  const existing = await ctx.config.get(VERIFY_TOKEN_KEY)
  if (typeof existing === "string" && existing) return existing
  if (typeof ctx.config.setSecret !== "function") throw new GraphError("this host cannot store the webhook verify token")
  const token = newVerifyToken()
  await ctx.config.setSecret(VERIFY_TOKEN_KEY, token)
  return token
}

interface AppSubscription {
  object?: string
  callback_url?: string
  active?: boolean
  fields?: Array<string | { name?: string }>
}

function fieldNames(fields: AppSubscription["fields"]): string[] {
  return (fields ?? []).map((f) => (typeof f === "string" ? f : (f?.name ?? ""))).filter(Boolean)
}

export async function webhooksSetupPreflight(
  params: { callback_base_url?: string },
  ctx: SetupCtx,
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  const pre = await prerequisites(params, ctx)
  return "status" in pre ? { error: pre.error } : { ok: true }
}

export async function webhooksSetup(params: { callback_base_url?: string }, ctx: SetupCtx): Promise<SetupResult | SetupError> {
  const pre = await prerequisites(params, ctx)
  if ("status" in pre) return pre
  const { accounts, callbackUrl, appSecret } = pre

  const firstToken = await resolveAccessToken(ctx, "facebook", accounts[0] as string)
  if (!firstToken) {
    return fail("connection_lost", `The Facebook token for account ${accounts[0]} is missing or expired: reconnect Facebook.`)
  }

  // ── 1. App-level `page` subscription ─────────────────────────────────────
  let appId: string
  let appStatus: "subscribed" | "unchanged"
  try {
    const app = await graph<{ id?: string }>(ctx, `${FB_BASE}/app?fields=id`, { token: firstToken })
    if (!app.id) return fail("provider_rejected", "Meta did not return the app id for the Facebook token.")
    appId = app.id
    const appToken = `${appId}|${appSecret}`
    const current = await graph<{ data?: AppSubscription[] }>(ctx, `${FB_BASE}/${appId}/subscriptions`, { token: appToken })
    const page = (current.data ?? []).find((s) => s.object === "page")
    const have = new Set(fieldNames(page?.fields))
    const matches =
      page?.callback_url === callbackUrl && page?.active !== false && WEBHOOK_FIELDS.every((f) => have.has(f))
    if (matches) {
      appStatus = "unchanged"
    } else {
      const verifyToken = await ensureVerifyToken(ctx)
      await graph(ctx, `${FB_BASE}/${appId}/subscriptions`, {
        method: "POST",
        body: {
          object: "page",
          callback_url: callbackUrl,
          fields: WEBHOOK_FIELDS.join(","),
          include_values: true,
          verify_token: verifyToken,
          access_token: appToken,
        },
      })
      appStatus = "subscribed"
    }
  } catch (e) {
    return fail(
      "app_subscription_failed",
      `Meta refused the app-level page subscription for ${callbackUrl}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  // ── 2. Per-Page `subscribed_apps` ────────────────────────────────────────
  const pages: PageResult[] = []
  for (const account of accounts) {
    const userToken = account === accounts[0] ? firstToken : await resolveAccessToken(ctx, "facebook", account)
    if (!userToken) {
      pages.push({
        page_id: "",
        name: null,
        account_external_id: account,
        status: "failed",
        error: "The Facebook token for this account is missing or expired: reconnect Facebook.",
      })
      continue
    }
    let managed: Array<{ id: string; name?: string; access_token?: string }>
    try {
      managed = (
        await graph<{ data?: Array<{ id: string; name?: string; access_token?: string }> }>(
          ctx,
          `${FB_BASE}/me/accounts?fields=id,name,access_token`,
          { token: userToken },
        )
      ).data ?? []
    } catch (e) {
      pages.push({
        page_id: "",
        name: null,
        account_external_id: account,
        status: "failed",
        error: `Could not list the managed Pages: ${e instanceof Error ? e.message : String(e)}`,
      })
      continue
    }
    for (const p of managed) {
      const base = { page_id: p.id, name: p.name ?? null, account_external_id: account }
      if (!p.access_token) {
        pages.push({ ...base, status: "failed", error: "Meta returned no Page access token for this Page." })
        continue
      }
      try {
        const subs = await graph<{ data?: Array<{ id?: string; subscribed_fields?: string[] }> }>(
          ctx,
          `${FB_BASE}/${p.id}/subscribed_apps`,
          { token: p.access_token },
        )
        const existing = (subs.data ?? []).find((a) => a.id === appId)?.subscribed_fields ?? []
        if (WEBHOOK_FIELDS.every((f) => existing.includes(f))) {
          pages.push({ ...base, status: "unchanged", subscribed_fields: existing })
          continue
        }
        const fields = [...new Set([...existing, ...WEBHOOK_FIELDS])]
        await graph(ctx, `${FB_BASE}/${p.id}/subscribed_apps`, {
          method: "POST",
          token: p.access_token,
          body: { subscribed_fields: fields.join(",") },
        })
        pages.push({ ...base, status: "subscribed", subscribed_fields: fields })
      } catch (e) {
        pages.push({ ...base, status: "failed", error: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  const failed = pages.filter((p) => p.status === "failed").length
  if (failed > 0) ctx.logger?.warn?.("social: webhooks_setup left Pages unsubscribed", { failed })
  return {
    status: failed === 0 && pages.length > 0 ? "completed" : "partial",
    callback_url: callbackUrl,
    app: { app_id: appId, status: appStatus, fields: [...WEBHOOK_FIELDS] },
    pages,
    failed_pages: failed,
  }
}
