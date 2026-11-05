// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The server's own inbound callbacks (managed edition): one per provider for the
// whole server, fanned out to the orgs a delivery concerns.
//
//   POST /webhooks/_cell/gmail-push  One Pub/Sub push subscription per server
//     (GMAIL_PUBSUB_TOPIC). The OIDC bearer is verified once against
//     GMAIL_PUSH_AUDIENCE / GMAIL_PUSH_SERVICE_ACCOUNT, `message.data` names the
//     mailbox (`emailAddress`), and every org whose Mail or Tickets Gmail
//     connection holds that address gets the ORIGINAL request on its own
//     `/webhooks/<org>/<app>/gmail-push` endpoint, whose verifier checks the token
//     again (with the same instance defaults) and keys replay per org. An address
//     no org holds answers 204, so Pub/Sub stops retrying.
//   POST /webhooks/_cell/meta  The app-level callback of the one Meta app every
//     org's Facebook connection uses. X-Hub-Signature-256 is verified once with
//     META_APP_SECRET, `entry[]` is split by Page id, and each org whose Facebook
//     Pages include that id gets a body holding only its own entries, through the
//     kernel's verified-dispatch path (replay, scopes, handler, retry). Meta always
//     gets 200 unless a delivery failed transiently.
//   GET /webhooks/_cell/meta  Meta's hub.challenge handshake, against the token
//     derived from META_APP_SECRET (cell-meta-token.ts).
//
// A suspended or closed org is skipped (its own endpoint would drop it anyway).
// Self-hosted: every route here is a 404. Lookups and dispatch are injected
// (webhooks/routes.ts wires the real ones), so this file holds only the routing.
import { createHmac, timingSafeEqual } from "node:crypto"
import { and, sql as drizzleSql, eq, inArray, ne } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { webhooksLogger } from "~/lib/logger"
import { RequestBodyTooLargeError, readRequestTextWithLimit } from "~/lib/request-body"
import { cellMetaVerifyToken } from "~/modules/cloud/cell-meta-token"

export { cellMetaVerifyToken } from "~/modules/cloud/cell-meta-token"

const log = webhooksLogger.child({ component: "cell-webhooks" })

const MAX_BODY_BYTES = 1024 * 1024

export interface GmailPushOrg {
  orgId: string
  appName: "mail" | "tickets"
}

export interface CellWebhookDeps {
  managed(): boolean
  gmailPush(): { audience?: string; serviceAccount?: string }
  metaAppSecret(): string | undefined
  verifyOidc(
    token: string,
    audience: string,
    serviceAccount: string,
  ): Promise<{ valid: boolean; reason?: string }>
  /** Orgs whose Mail or Tickets Gmail connection holds this (lower-cased) address. */
  gmailOrgsFor(address: string): Promise<GmailPushOrg[]>
  /** Page id -> the orgs whose Facebook connection holds that Page. */
  metaOrgsForPages(pageIds: string[]): Promise<Map<string, string[]>>
  suspended(orgId: string): Promise<boolean>
  /** Runs the org's own webhook endpoint with the original request (it re-verifies). */
  forward(
    orgId: string,
    appName: string,
    endpointName: string,
    req: { headers: Headers; body: string },
  ): Promise<Response>
  /** Runs the org's handler on a delivery the kernel verified (replay key per org body). */
  dispatchVerified(
    c: Context,
    orgId: string,
    appName: string,
    endpointName: string,
    req: { headers: Headers; rawBody: string; replayKey: string },
  ): Promise<Response>
}

/** A response that makes the provider deliver again (a transient failure somewhere). */
function isTransient(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

async function readBody(c: Context): Promise<string | Response> {
  try {
    return await readRequestTextWithLimit(c.req.raw, MAX_BODY_BYTES)
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError)
      return c.json({ error: { message: "Payload too large" } }, 413)
    throw err
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function notFound(c: Context): Response {
  return c.json({ error: { message: "Not found" } }, 404)
}

export function createCellWebhookRoutes(deps: CellWebhookDeps): Hono {
  const routes = new Hono()

  routes.post("/gmail-push", async (c) => {
    if (!deps.managed()) return notFound(c)
    const { audience, serviceAccount } = deps.gmailPush()
    if (!audience || !serviceAccount) {
      log.error("cell Gmail push: GMAIL_PUSH_AUDIENCE / GMAIL_PUSH_SERVICE_ACCOUNT unset; 503")
      return c.json({ error: { message: "Gmail push is not configured on this server" } }, 503)
    }
    const auth = c.req.header("authorization") ?? ""
    const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim()
    if (!bearer) return c.json({ error: { message: "Invalid signature" } }, 401)
    const verified = await deps.verifyOidc(bearer, audience, serviceAccount)
    if (!verified.valid) {
      log.warn({ reason: verified.reason }, "cell Gmail push: OIDC token refused")
      return c.json({ error: { message: "Invalid signature" } }, 401)
    }
    const body = await readBody(c)
    if (typeof body !== "string") return body
    let address: string | null = null
    try {
      const envelope = JSON.parse(body) as { message?: { data?: string } }
      const data = envelope?.message?.data
      const decoded = data
        ? (JSON.parse(Buffer.from(data, "base64").toString("utf8")) as { emailAddress?: unknown })
        : null
      address =
        typeof decoded?.emailAddress === "string" ? decoded.emailAddress.trim().toLowerCase() : null
    } catch {
      return c.json({ error: { message: "Invalid push message" } }, 400)
    }
    if (!address) return c.body(null, 204)
    const orgs = await deps.gmailOrgsFor(address)
    let delivered = 0
    let skipped = 0
    let transient = false
    for (const org of orgs) {
      if (await deps.suspended(org.orgId)) {
        skipped++
        continue
      }
      const res = await deps.forward(org.orgId, org.appName, "gmail-push", {
        headers: c.req.raw.headers,
        body,
      })
      if (isTransient(res.status)) transient = true
      else if (res.status >= 400) {
        log.warn(
          { orgId: org.orgId, app: org.appName, status: res.status },
          "cell Gmail push: org endpoint refused",
        )
      } else delivered++
    }
    if (orgs.length === 0) return c.body(null, 204)
    if (transient) return c.json({ error: { message: "Webhook processing failed" } }, 503)
    return c.json({ data: { delivered, skipped } }, 200)
  })

  routes.post("/meta", async (c) => {
    if (!deps.managed()) return notFound(c)
    const secret = deps.metaAppSecret()
    if (!secret) {
      log.error("cell Meta callback: META_APP_SECRET unset; 503")
      return c.json({ error: { message: "Meta webhooks are not configured on this server" } }, 503)
    }
    const body = await readBody(c)
    if (typeof body !== "string") return body
    const presented = (c.req.header("x-hub-signature-256") ?? "")
      .replace(/^sha256=/i, "")
      .trim()
      .toLowerCase()
    const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex")
    if (!presented || !safeEqual(presented, expected)) {
      log.warn("cell Meta callback: signature mismatch")
      return c.json({ error: { message: "Invalid signature" } }, 401)
    }
    let envelope: { object?: unknown; entry?: unknown }
    try {
      envelope = JSON.parse(body) as typeof envelope
    } catch {
      return c.json({ error: { message: "Invalid JSON body" } }, 400)
    }
    const entries = Array.isArray(envelope.entry) ? (envelope.entry as Array<{ id?: unknown }>) : []
    const pageIds = [
      ...new Set(entries.map((e) => (e && e.id !== undefined ? String(e.id) : "")).filter(Boolean)),
    ]
    const owners = pageIds.length
      ? await deps.metaOrgsForPages(pageIds)
      : new Map<string, string[]>()
    // Each org's own entries, in delivery order.
    const perOrg = new Map<string, unknown[]>()
    for (const entry of entries) {
      for (const orgId of owners.get(String(entry?.id ?? "")) ?? []) {
        const list = perOrg.get(orgId) ?? []
        list.push(entry)
        perOrg.set(orgId, list)
      }
    }
    let transient = false
    for (const [orgId, orgEntries] of perOrg) {
      if (await deps.suspended(orgId)) continue
      const rawBody = JSON.stringify({ ...envelope, entry: orgEntries })
      const res = await deps.dispatchVerified(c, orgId, "social", "meta", {
        headers: c.req.raw.headers,
        rawBody,
        replayKey: createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"),
      })
      if (isTransient(res.status)) transient = true
      else if (res.status >= 400)
        log.warn({ orgId, status: res.status }, "cell Meta callback: org endpoint refused")
    }
    if (transient) return c.json({ error: { message: "Webhook processing failed" } }, 503)
    return c.json({ data: { received: true } }, 200)
  })

  routes.get("/meta", (c) => {
    if (!deps.managed()) return notFound(c)
    const q = new URL(c.req.url).searchParams
    const challenge = q.get("hub.challenge")
    const presented = q.get("hub.verify_token") ?? ""
    const secret = deps.metaAppSecret()
    if (q.get("hub.mode") !== "subscribe" || challenge === null) {
      return c.json({ error: { message: "Method not allowed", code: "METHOD_NOT_ALLOWED" } }, 405)
    }
    if (!secret || !presented || !safeEqual(presented, cellMetaVerifyToken(secret)))
      return c.text("Forbidden", 403)
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(challenge)) return c.text("Bad request", 400)
    return c.text(challenge, 200, { "X-Content-Type-Options": "nosniff" })
  })

  routes.all("/*", (c) => notFound(c))
  return routes
}

// ---------------------------------------------------------------- lookups

/** Orgs whose Mail or Tickets Gmail connection (not disconnected) holds the address. */
export async function gmailOrgsForAddress(address: string): Promise<GmailPushOrg[]> {
  const rows = await withSystemDb("cell-gmail-push-orgs", (db) =>
    db
      .selectDistinct({ orgId: connectedAccounts.orgId, appName: connectedAccounts.appName })
      .from(connectedAccounts)
      .where(
        and(
          inArray(connectedAccounts.appName, ["mail", "tickets"]),
          eq(connectedAccounts.connectionName, "gmail"),
          ne(connectedAccounts.status, "disconnected"),
          drizzleSql`lower(${connectedAccounts.identifier}) = ${address.toLowerCase()}`,
        ),
      ),
  )
  return rows
    .map((r) => ({ orgId: r.orgId, appName: r.appName as GmailPushOrg["appName"] }))
    .sort((a, b) => `${a.orgId}:${a.appName}`.localeCompare(`${b.orgId}:${b.appName}`))
}

/**
 * Page id -> orgs, from the Page ids the Social app's `webhooks_setup` records on
 * each active Facebook account (`sync_state.metadata.meta_page_ids`). No Social
 * schema on this server: no owner.
 *
 * The stored list alone is not trusted: an org counts only while the Facebook
 * account that recorded the Page is still connected with a working token (its
 * `connected_accounts` row is `active`; a disconnect or a rejected token refresh
 * takes it out at once). The Social app keeps the list itself current against
 * Meta's own answer (`bundled-apps/social/src/meta-pages.ts`): it prunes Pages
 * the account no longer manages and drops entries for them before ingesting.
 */
export async function metaOrgsForPageIds(pageIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (pageIds.length === 0) return out
  const rows = await withSystemDb("cell-meta-page-orgs", async (db) => {
    const exists = extractRows<{ ok: boolean }>(
      await db.execute(drizzleSql`SELECT to_regclass('app_social.sync_state') IS NOT NULL AS ok`),
    )
    if (!exists[0]?.ok) return [] as Array<{ org_id: string; page_id: string }>
    return extractRows<{ org_id: string; page_id: string }>(
      await db.execute(drizzleSql`
      SELECT DISTINCT s.org_id::text AS org_id, p.page_id
      FROM app_social.sync_state s,
           jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(s.metadata::jsonb -> 'meta_page_ids') = 'array'
                  THEN s.metadata::jsonb -> 'meta_page_ids' ELSE '[]'::jsonb END
           ) AS p(page_id)
      WHERE s.platform = 'facebook' AND s.active = true
        AND EXISTS (
          SELECT 1 FROM ${drizzleSql.raw(schemaRef("kernel"))}.connected_accounts ca
          WHERE ca.org_id = s.org_id
            AND ca.app_name = 'social'
            AND ca.connection_name = 'facebook'
            AND ca.identifier = s.account_external_id
            AND ca.status = 'active'
        )
        AND p.page_id IN (${drizzleSql.join(
          pageIds.map((id) => drizzleSql`${id}`),
          drizzleSql`, `,
        )})
    `),
    )
  })
  for (const r of rows) {
    const list = out.get(r.page_id) ?? []
    if (!list.includes(r.org_id)) list.push(r.org_id)
    out.set(r.page_id, list.sort())
  }
  return out
}
