// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Webhook upstream probe: tells the kernel when Meta last saw a change that it
// must have delivered to our `meta` webhook.
//
// The kernel pages "webhook-ingest" when an app's webhooks go silent. A silence
// window alone cannot tell a quiet Page from a dead subscription. This job gives
// the kernel the missing evidence: the newest Facebook Page event of a kind our
// app is subscribed to, and the kernel pages only when that event is older than
// its delivery grace and no webhook has arrived since (modules/webhooks/
// ingest-health.ts in the API).
//
// What counts, per managed Page, and only for the fields `/{page}/subscribed_apps`
// says THIS app (`/app`) is subscribed to:
//   - `messages`: the newest message of the newest conversations, when it was
//     written by the other participant. Our own sends only reach the webhook as
//     `message_echoes`, which this app does not rely on, so they never count.
//   - `feed`: the newest comment or reply on the Page's newest posts, when it was
//     written by someone other than the Page. The Page's own comments are left
//     out rather than guessed at.
// Both reads look at a short head of the Page, so the probe can miss an event on
// an older post or thread. That errs on the safe side: a missed event only
// delays a page, a counted event that Meta never sends would page falsely.
//
// Instagram is left out: its webhooks belong to a separate product
// subscription, and the shared parser does not read Instagram's `comments`
// field, so nothing here proves they are delivered.
//
// Contract: `{ upstreamActivityAt: ISO }` when a subscribed Page has such an
// event, `{ upstreamActivityAt: null }` when there is no live sender (no
// connected Facebook account, no managed Page, no Page subscribed to our app, no
// event yet), and `{ probed: false, reason }` when Graph cannot be reached or
// errors, or an active account's token is missing, expired or refused: the kernel
// lists the probe as stale instead of reading an unreachable Page as a quiet one.
import type { UpstreamProbeResult } from "@liaison/app-sdk"
import { FB_BASE } from "./adapters/facebook"
import { resolveAccessToken } from "./connection"
import type { SocialToolCtx } from "./ctx"

export type { UpstreamProbeResult }

/** How many of the newest conversations / posts each run inspects. */
const HEAD_LIMIT = 5

const SUBSCRIBED_FIELDS = new Set(["messages", "feed"])

class GraphError extends Error {}

interface FbFrom {
  id?: string
}

async function graphGet<T>(ctx: SocialToolCtx, url: string, token: string): Promise<T> {
  const res = await ctx.fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  let body: unknown = {}
  try {
    body = res.body ? JSON.parse(res.body) : {}
  } catch {
    throw new GraphError(`${res.status} unparseable body`)
  }
  const err = (body as { error?: { message?: string; code?: number } }).error
  if (res.status !== 200 || err) {
    throw new GraphError(
      `${res.status}${err ? ` ${err.code ?? ""} ${err.message ?? ""}`.trimEnd() : ""}`,
    )
  }
  return body as T
}

function newer(a: string | null, b: string | undefined | null): string | null {
  if (!b || Number.isNaN(Date.parse(b))) return a
  if (!a || Date.parse(b) > Date.parse(a)) return b
  return a
}

/** Newest inbound message across the Page's newest conversations. */
async function newestInboundMessage(
  ctx: SocialToolCtx,
  pageId: string,
  token: string,
): Promise<string | null> {
  const url = `${FB_BASE}/${pageId}/conversations?fields=updated_time,messages.limit(1){from,created_time}&limit=${HEAD_LIMIT}`
  const body = await graphGet<{
    data?: Array<{ messages?: { data?: Array<{ from?: FbFrom; created_time?: string }> } }>
  }>(ctx, url, token)
  let latest: string | null = null
  for (const conv of body.data ?? []) {
    const m = conv.messages?.data?.[0]
    if (!m?.from?.id || m.from.id === pageId) continue
    latest = newer(latest, m.created_time)
  }
  return latest
}

/** Newest comment or reply by someone else across the Page's newest posts. */
async function newestForeignComment(
  ctx: SocialToolCtx,
  pageId: string,
  token: string,
): Promise<string | null> {
  const url = `${FB_BASE}/${pageId}/feed?fields=comments.filter(stream).order(reverse_chronological).limit(${HEAD_LIMIT}){from,created_time}&limit=${HEAD_LIMIT}`
  const body = await graphGet<{
    data?: Array<{ comments?: { data?: Array<{ from?: FbFrom; created_time?: string }> } }>
  }>(ctx, url, token)
  let latest: string | null = null
  for (const post of body.data ?? []) {
    for (const c of post.comments?.data ?? []) {
      if (!c.from?.id || c.from.id === pageId) continue
      latest = newer(latest, c.created_time)
      break // reverse chronological: the first foreign comment is this post's newest
    }
  }
  return latest
}

async function probeAccount(ctx: SocialToolCtx, accountExternalId: string): Promise<string | null> {
  const userToken = await resolveAccessToken(ctx, "facebook", accountExternalId)
  // An account we are meant to watch but cannot authenticate is a probe that could not look,
  // not a missing sender: the kernel must see the probe go stale.
  if (!userToken) throw new GraphError(`no usable token for facebook account ${accountExternalId}`)
  const app = await graphGet<{ id?: string }>(ctx, `${FB_BASE}/app?fields=id`, userToken)
  if (!app.id) throw new GraphError("no app id for token")
  const pages = await graphGet<{ data?: Array<{ id: string; access_token: string }> }>(
    ctx,
    `${FB_BASE}/me/accounts?fields=id,access_token`,
    userToken,
  )
  let latest: string | null = null
  for (const page of pages.data ?? []) {
    const subs = await graphGet<{ data?: Array<{ id?: string; subscribed_fields?: string[] }> }>(
      ctx,
      `${FB_BASE}/${page.id}/subscribed_apps`,
      page.access_token,
    ).catch((err: unknown) => {
      // A grant made before the app asked for pages_manage_metadata (or with it
      // unticked) cannot read or make the Page subscription, so no webhook ever
      // arrives. Only a reconnect fixes it: say so, so the page names its cure.
      if (err instanceof GraphError && err.message.includes("pages_manage_metadata")) {
        throw new GraphError(
          `${err.message}: the Facebook grant lacks pages_manage_metadata, so Page ${page.id} cannot be subscribed to webhooks; reconnect the Facebook account in Settings > Apps > Social, then run webhooks setup`,
        )
      }
      throw err
    })
    const fields = new Set(
      (subs.data ?? [])
        .find((a) => a.id === app.id)
        ?.subscribed_fields?.filter((f) => SUBSCRIBED_FIELDS.has(f)) ?? [],
    )
    if (fields.has("messages"))
      latest = newer(latest, await newestInboundMessage(ctx, page.id, page.access_token))
    if (fields.has("feed"))
      latest = newer(latest, await newestForeignComment(ctx, page.id, page.access_token))
  }
  return latest
}

export async function probeWebhookUpstreamJob(
  _params: unknown,
  ctx: SocialToolCtx,
): Promise<UpstreamProbeResult> {
  const states = (await ctx.db.findMany("sync_state", {
    where: { platform: "facebook", active: true },
  })) as Array<{ account_external_id: string }>
  const accounts = [...new Set(states.map((s) => s.account_external_id))]
  let latest: string | null = null
  try {
    for (const account of accounts) latest = newer(latest, await probeAccount(ctx, account))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.logger?.warn?.("social: webhook upstream probe could not read Meta", { reason })
    return { probed: false, reason }
  }
  return { upstreamActivityAt: latest }
}
