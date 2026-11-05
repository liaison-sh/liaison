// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE GOOGLE PICKER PAGE.
 *
 * The Picker is Google's script and frames; the web app's policy allows neither,
 * and a desktop or phone shell's webview may not run it at all. So it runs on a
 * page of its own, opened in a popup (web) or the system browser (shells):
 *
 * 1. The signed-in app asks for a ticket (POST /api/google-drive/picker/ticket):
 *    a random id in Redis bound to the person, the workspace and one Drive
 *    account, valid 15 minutes.
 * 2. GET /api/drive-picker/:ticket renders the page ONCE: the ticket is taken
 *    (getdel), the account is checked again (still the person's, still in
 *    picked mode: a full-mode token, which reads the whole Drive, never reaches
 *    a page), and a NEW random save id is minted. The page carries the save id,
 *    the account's current access token (drive.file), the Picker API key and
 *    the app id. The link's own id no longer saves anything.
 * 3. The person picks; the page posts the items to
 *    POST /api/drive-picker/:saveId/items, which saves them and starts the sync
 *    (picker.ts). The app's card shows the progress.
 *
 * Its policy allows its own hashed script and style, Google's Picker origins,
 * and posting back to this origin. Nothing on the page is read from the link.
 */
import { randomBytes } from "node:crypto"
import type { Context } from "hono"
import { z } from "zod"
import { pickedItemSchema } from "~/apps/google-drive/drive-mode"
import { DrivePickerError, pickerAccount, savePicks } from "~/apps/google-drive/picker"
import { announcePicks } from "~/apps/google-drive/picker-announce"
import { KnowledgeError } from "~/apps/knowledge/service"
import { withSystemDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { cspHash, escapeHtml, localeFromAcceptLanguage } from "~/lib/html-page"
import { redis } from "~/lib/redis"
import { resolveConnectionAccount } from "~/modules/apps/connections/service"
import { serverT } from "~/modules/i18n/server-i18n"

const TICKET_TTL_SECONDS = 15 * 60
const ticketKey = (ticket: string) => `drive-picker:ticket:${ticket}`
const saveKey = (ticket: string) => `drive-picker:save:${ticket}`

export interface PickerTicket {
  orgId: string
  userId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  roles: string[]
  accountId: string
  identifier: string
  /** The conversation card the picker was opened from (picker-announce.ts), if any. */
  origin?: string
}

const TICKET_RE = /^[A-Za-z0-9_-]{32,64}$/

/** A new ticket for one account (the caller already proved it may pick on it). */
export async function createPickerTicket(ticket: PickerTicket): Promise<string> {
  const id = randomBytes(32).toString("base64url")
  await redis.set(ticketKey(id), JSON.stringify(ticket), "EX", TICKET_TTL_SECONDS)
  return id
}

export function pickerPageUrl(ticket: string): string {
  return `${env.BASE_URL.replace(/\/+$/, "")}/api/drive-picker/${ticket}`
}

function parseTicket(raw: string | null): PickerTicket | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as PickerTicket
  } catch {
    return null
  }
}

const STYLE =
  ":root{color-scheme:light dark}" +
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
  "font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
  "background:#f6f6f4;color:#1c1c1a}" +
  "main{max-width:420px;margin:24px;padding:32px;border-radius:12px;background:#fff;" +
  "border:1px solid #e3e3df;text-align:center}" +
  "h1{font-size:20px;margin:0 0 12px}p{margin:0 0 16px;color:#55554f}" +
  "button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #c9c9c3;" +
  "background:#1c1c1a;color:#fff;cursor:pointer}" +
  "@media (prefers-color-scheme:dark){body{background:#161615;color:#ededea}" +
  "main{background:#1f1f1d;border-color:#33332f}p{color:#b5b5ae}" +
  "button{background:#ededea;color:#161615}}"

/**
 * Loads Google's API script, opens the Picker (Drive files and folders,
 * multi-select, shared drives), and posts what was picked back. Reads its
 * configuration from the page's JSON block, never from the link.
 */
const SCRIPT = `(function(){
var cfg=JSON.parse(document.getElementById("cfg").textContent);
var status=document.getElementById("status");
var again=document.getElementById("again");
function say(t){status.textContent=t}
function open(){
  var G=google.picker;
  var mine=new G.DocsView(G.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(true).setParent("root");
  var all=new G.DocsView(G.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(true);
  var shared=new G.DocsView(G.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(true).setEnableDrives(true);
  new G.PickerBuilder()
    .setDeveloperKey(cfg.apiKey).setAppId(cfg.appId).setOAuthToken(cfg.accessToken)
    .addView(mine).addView(all).addView(shared)
    .enableFeature(G.Feature.MULTISELECT_ENABLED).enableFeature(G.Feature.SUPPORT_DRIVES)
    .setTitle(cfg.text.title).setLocale(cfg.locale).setCallback(picked).build().setVisible(true);
}
function picked(data){
  var A=google.picker.Action;
  if(data.action===A.CANCEL){say(cfg.text.cancelled);again.hidden=false;return}
  if(data.action!==A.PICKED)return;
  var items=(data.docs||[]).map(function(d){return{id:d.id,name:d.name||d.id,mimeType:d.mimeType||"application/octet-stream"}});
  say(cfg.text.saving);
  fetch(cfg.saveUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({add:items})})
    .then(function(r){if(!r.ok)throw new Error(String(r.status));return r.json()})
    .then(function(){say(cfg.text.saved.replace("__COUNT__",String(items.length)));again.hidden=false;setTimeout(function(){try{window.close()}catch(e){}},1500)})
    .catch(function(){say(cfg.text.failed);again.hidden=false});
}
again.addEventListener("click",function(){again.hidden=true;say("");open()});
var s=document.createElement("script");
s.src="https://apis.google.com/js/api.js";
s.onload=function(){gapi.load("picker",{callback:open})};
s.onerror=function(){say(cfg.text.failed)};
document.head.appendChild(s);
})()`

/** Google's Picker: its loader and scripts, its frames, its styles and images. */
export const PICKER_PAGE_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${cspHash(SCRIPT)}' https://apis.google.com https://www.gstatic.com`,
  // The Picker injects its own inline styles: a hash here would turn
  // 'unsafe-inline' off, so the page's style is allowed the same way.
  "style-src 'unsafe-inline' https://www.gstatic.com https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src https: data:",
  "frame-src https://docs.google.com https://drive.google.com https://accounts.google.com https://content.googleapis.com",
  "connect-src 'self' https://apis.google.com https://content.googleapis.com https://www.googleapis.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ")

/** JSON safe inside a `<script type="application/json">` block. */
function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
}

function page(c: Context, body: string, cfg: Record<string, unknown> | null): Response {
  const locale = localeOf(c)
  const t = (key: string) => escapeHtml(serverT(locale, `google-drive.picker.${key}`))
  const html = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="strict-origin">
<title>${t("title")}</title>
<style>${STYLE}</style>
</head>
<body>
<main data-testid="drive-picker-page">
<h1>${t("title")}</h1>
${body}
</main>
${cfg ? `<script type="application/json" id="cfg">${jsonForHtml(cfg)}</script><script>${SCRIPT}</script>` : ""}
</body>
</html>
`
  return new Response(html, {
    status: cfg ? 200 : 410,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": PICKER_PAGE_CSP,
      "Cache-Control": "no-store",
      // Origin only: Google checks the Picker API key against the page's
      // referrer (an HTTP-referrer key restriction), so no-referrer makes it
      // refuse the key. strict-origin sends the scheme and host, never the path
      // that carries the one-time ticket, and nothing over plain HTTP from HTTPS.
      "Referrer-Policy": "strict-origin",
    },
  })
}

function localeOf(c: Context) {
  return localeFromAcceptLanguage(c.req.header("accept-language"))
}

/** GET /api/drive-picker/:ticket: the page, once per ticket. */
export async function drivePickerPage(c: Context): Promise<Response> {
  const locale = localeOf(c)
  const t = (key: string) => serverT(locale, `google-drive.picker.${key}`)
  const expired = `<p data-testid="drive-picker-expired">${escapeHtml(t("expired"))}</p>`
  const id = c.req.param("ticket") ?? ""
  if (!TICKET_RE.test(id)) return page(c, expired, null)
  const ticket = parseTicket(await redis.getdel(ticketKey(id)))
  if (!ticket || !env.GOOGLE_PICKER_API_KEY || !env.GOOGLE_CLOUD_PROJECT_NUMBER) {
    return page(c, expired, null)
  }
  try {
    // Re-checked at load: the account may have been reconnected with the whole
    // Drive, or handed to someone else, since the ticket was made.
    await pickerAccount(ticket, ticket.accountId)
  } catch (err) {
    if (err instanceof DrivePickerError) return page(c, expired, null)
    throw err
  }
  let accessToken: string
  try {
    // The ticket's own account: one Google account may hold an org row and a
    // member's own row, and the picker grants files to that row's token only.
    accessToken = (
      await withSystemDb("drive-picker-page-token", (db) =>
        resolveConnectionAccount(
          db,
          ticket.orgId,
          ticket.userId,
          "google-drive",
          "drive",
          ticket.identifier,
          { actorType: "system", accountId: ticket.accountId },
        ),
      )
    ).token
  } catch {
    return page(c, `<p data-testid="drive-picker-failed">${escapeHtml(t("reconnect"))}</p>`, null)
  }
  const saveId = randomBytes(32).toString("base64url")
  await redis.set(saveKey(saveId), JSON.stringify(ticket), "EX", TICKET_TTL_SECONDS)
  const cfg = {
    accessToken,
    apiKey: env.GOOGLE_PICKER_API_KEY,
    appId: env.GOOGLE_CLOUD_PROJECT_NUMBER,
    locale,
    saveUrl: `/api/drive-picker/${saveId}/items`,
    text: {
      title: t("title"),
      cancelled: t("cancelled"),
      saving: t("saving"),
      saved: serverT(locale, "google-drive.picker.saved", { count: "__COUNT__" }),
      failed: t("failed"),
    },
  }
  const body = `<p>${escapeHtml(t("body"))}</p>
<p id="status" role="status" data-testid="drive-picker-status"></p>
<button id="again" type="button" hidden data-testid="drive-picker-again">${escapeHtml(t("again"))}</button>`
  return page(c, body, cfg)
}

const saveSchema = z.object({ add: z.array(pickedItemSchema).min(1).max(500) })

/** POST /api/drive-picker/:ticket/items: what the person picked on the page. */
export async function drivePickerPageSave(c: Context): Promise<Response> {
  const id = c.req.param("ticket") ?? ""
  const ticket = TICKET_RE.test(id) ? parseTicket(await redis.get(saveKey(id))) : null
  if (!ticket) {
    return c.json({ error: { message: "This picker link has expired", code: "expired" } }, 410)
  }
  const parsed = saveSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: { message: "Invalid picked items", code: "invalid" } }, 400)
  }
  try {
    const result = await savePicks(ticket, ticket.accountId, { add: parsed.data.add, remove: [] })
    // Opened from a card in a conversation: the agent there learns what was picked.
    if (ticket.origin) await announcePicks(ticket, ticket.origin, parsed.data.add)
    return c.json({ data: { picked: result.picked.length } })
  } catch (err) {
    if (err instanceof DrivePickerError) {
      const status = err.code === "not_found" ? 404 : err.code === "forbidden" ? 403 : 409
      return c.json({ error: { message: err.message, code: err.code } }, status)
    }
    if (err instanceof KnowledgeError) {
      return c.json(
        { error: { message: err.message, code: err.code } },
        err.code === "FORBIDDEN" ? 403 : 400,
      )
    }
    throw err
  }
}
