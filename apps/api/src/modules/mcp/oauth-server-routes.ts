// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { and, eq, isNull, lt, notExists } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { mcpConnections, mcpOauthClients } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { escapeHtml } from "~/lib/html-page"
import { redis } from "~/lib/redis"
import { getClientIp } from "~/lib/request-context"
import { zValidator } from "~/lib/validate"
import { checkRateLimit } from "~/middleware/rate-limiter"
import {
  createMcpConnection,
  loadBindableAgent,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  mintAccessToken,
  refreshAccessToken,
} from "~/modules/mcp/connection-service"
import { assertFullAccessStepUp, readFullAccessProof } from "~/modules/mcp/full-access-step-up"
import { consumeAuthCode, putAuthCode } from "~/modules/mcp/oauth-store"
import { emitSecurityEvent } from "~/modules/security/security-events"

// Discovery metadata + DCR + authorization-code(+PKCE) + token. The exact
// /.well-known field set is verified against the installed SDK + current
// Claude client; the architecture (DCR + auth-code+PKCE + device grant, MCP
// connection minted at token) is fixed.

export const mcpOAuth = new Hono<AppEnv>()
// `.well-known` lives under its own instance so it can mount at the root.
export const mcpOAuthWellKnown = new Hono<AppEnv>()

function base() {
  return env.BASE_URL
}

mcpOAuthWellKnown.get("/oauth-protected-resource", (c) =>
  c.json({
    resource: base(),
    authorization_servers: [base()],
  }),
)

mcpOAuthWellKnown.get("/oauth-authorization-server", (c) =>
  c.json({
    issuer: base(),
    authorization_endpoint: `${base()}/mcp/oauth/authorize`,
    token_endpoint: `${base()}/mcp/oauth/token`,
    registration_endpoint: `${base()}/mcp/oauth/register`,
    device_authorization_endpoint: `${base()}/mcp/device/initiate`,
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  }),
)

mcpOAuthWellKnown.get("/mcp", (c) =>
  c.json({
    transport: "streamable-http",
    endpoint: `${base()}/mcp`,
    catalog_version: 1,
    auth_methods: ["oauth2", "device_code"],
  }),
)

const CLIENT_NAME_MAX = 100
const MAX_REDIRECT_URIS = 10
// Schemes that can run script or read local content in a browser: never a
// legitimate OAuth callback.
const FORBIDDEN_REDIRECT_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
])

/** Self-declared display name: one line, no control characters, bounded. */
export function sanitizeClientName(raw: string | undefined): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const cleaned = (raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  return cleaned ? cleaned.slice(0, CLIENT_NAME_MAX) : null
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  )
}

/**
 * A redirect URI a dynamically registered client may hold: https anywhere,
 * http only on a loopback host (native clients listen locally), and a custom
 * app scheme (cursor://, vscode://) for desktop clients. Script-bearing schemes
 * and plain http to a remote host (the code would cross the network in clear)
 * are refused.
 */
export function isAcceptableRedirectUri(uri: string): boolean {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.username || u.password || u.hash) return false
  if (FORBIDDEN_REDIRECT_SCHEMES.has(u.protocol)) return false
  if (u.protocol === "https:") return true
  if (u.protocol === "http:") return isLoopbackHost(u.hostname)
  return true
}

/** What the consent page shows as the place the user is sent back to. */
export function redirectDestination(uri: string): string {
  const u = new URL(uri)
  return u.protocol === "https:" || u.protocol === "http:" ? u.host : `${u.protocol}//${u.host}`
}

const registerSchema = z.object({
  client_name: z.string().optional(),
  // Must be valid absolute URLs (RFC 7591) — no arbitrary strings register as
  // redirect URIs (review N7) — over https, loopback http, or an app scheme.
  redirect_uris: z
    .array(z.string().url().refine(isAcceptableRedirectUri, "unacceptable redirect URI"))
    .min(1)
    .max(MAX_REDIRECT_URIS),
})

// Registered clients that never produced a connection are dropped after this
// long. Registration is unauthenticated, so unused rows are pure garbage.
const UNUSED_CLIENT_TTL_MS = 30 * 24 * 3600 * 1000

// DCR (Dynamic Client Registration) rate limit — 10 registrations per IP per
// minute. The endpoint is unauthenticated; without this a single IP can exhaust
// the client-id space or trigger DB pressure at no cost.
const DCR_RATE_LIMIT = env.NODE_ENV === "development" || env.NODE_ENV === "test" ? 10_000 : 10
const DCR_WINDOW_SECONDS = 60

mcpOAuth.post("/register", zValidator("json", registerSchema), async (c) => {
  const { client_name, redirect_uris } = c.req.valid("json")

  const ip = getClientIp(c)
  const rlResult = await checkRateLimit(redis, [
    { identifier: `mcp:dcr:${ip}`, limit: DCR_RATE_LIMIT, windowSeconds: DCR_WINDOW_SECONDS },
  ])
  if (!rlResult.allowed) {
    c.header("Retry-After", String(rlResult.failed.retryAfterSeconds))
    throw new HTTPException(429, { message: "Too many registration requests" })
  }

  const clientId = randomUUID()
  const name = sanitizeClientName(client_name)
  await withSystemDb("mcp-oauth-register", async (db) => {
    await db.insert(mcpOauthClients).values({
      clientId,
      clientName: name,
      redirectUris: redirect_uris,
    })
    // Opportunistic garbage collection (1 in 20 registrations): clients never
    // used for a connection and older than the TTL.
    if (Math.random() < 0.05) {
      await db
        .delete(mcpOauthClients)
        .where(
          and(
            lt(mcpOauthClients.createdAt, new Date(Date.now() - UNUSED_CLIENT_TTL_MS)),
            notExists(
              db
                .select({ one: mcpConnections.id })
                .from(mcpConnections)
                .where(eq(mcpConnections.clientId, mcpOauthClients.clientId)),
            ),
          ),
        )
    }
  })
  // Registration is open by design (RFC 7591), so a new client is worth an
  // operator's eye: who registered, and where its codes may be sent.
  await emitSecurityEvent({
    kind: "mcp_client_registered",
    detail: {
      clientId,
      clientName: name,
      redirectHosts: redirect_uris.map((u) => {
        try {
          return new URL(u).host
        } catch {
          return "invalid"
        }
      }),
      ip,
    },
  })
  return c.json({ client_id: clientId, client_name: name, redirect_uris }, 201)
})

interface AuthorizeParams {
  responseType: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  state: string
  /** Optional agent binding requested by the client (spec-runtime.md). */
  agentId: string
}

function readAuthorizeParams(get: (k: string) => string | undefined): AuthorizeParams {
  return {
    responseType: get("response_type") ?? "",
    clientId: get("client_id") ?? "",
    redirectUri: get("redirect_uri") ?? "",
    codeChallenge: get("code_challenge") ?? "",
    codeChallengeMethod: get("code_challenge_method") ?? "",
    state: get("state") ?? "",
    agentId: get("agent_id") ?? "",
  }
}

// Validates the OAuth params + the registered client/redirect_uri. Returns the
// resolved client on success, or an error response to return to the caller.
async function validateAuthorize(
  c: Context<AppEnv>,
  p: AuthorizeParams,
): Promise<
  { ok: true; client: typeof mcpOauthClients.$inferSelect } | { ok: false; res: Response }
> {
  if (p.responseType !== "code") {
    return { ok: false, res: c.json({ error: "unsupported_response_type" }, 400) }
  }
  if (p.codeChallengeMethod !== "S256" || !p.codeChallenge) {
    return {
      ok: false,
      res: c.json({ error: "invalid_request", error_description: "S256 PKCE required" }, 400),
    }
  }
  // `state` is opaque to us but is reflected into the consent page and the
  // redirect. Injection is neutralized at every sink (escapeHtml for the
  // `data-*` attribute the page carries it in, URLSearchParams for the
  // redirect); this bound is defense-in-depth against reflected-payload abuse
  // without restricting the charset (clients legitimately use base64/base64url
  // state).
  if (p.state.length > 1024) {
    return {
      ok: false,
      res: c.json({ error: "invalid_request", error_description: "state too long" }, 400),
    }
  }
  if (!p.clientId) return { ok: false, res: c.json({ error: "invalid_client" }, 400) }
  const [client] = await withSystemDb("mcp-oauth-authorize-client", (db) =>
    db.select().from(mcpOauthClients).where(eq(mcpOauthClients.clientId, p.clientId)),
  )
  if (!client) return { ok: false, res: c.json({ error: "invalid_client" }, 400) }
  // Re-checked here, not only at registration: a client registered before the
  // registration rule existed may still hold a URI it would now be refused.
  if (
    !p.redirectUri ||
    !client.redirectUris.includes(p.redirectUri) ||
    !isAcceptableRedirectUri(p.redirectUri)
  ) {
    // Open-redirect prevention — never redirect to an unregistered URI.
    return {
      ok: false,
      res: c.json(
        { error: "invalid_request", error_description: "redirect_uri not registered" },
        400,
      ),
    }
  }
  return { ok: true, client }
}

// The consent page's button wiring, served as an EXTERNAL script (see
// GET /authorize.js below). The page is sent with CSP `script-src 'self'`
// (middleware/security-headers.ts), which blocks inline scripts in any
// compliant browser — a static same-origin script is the robust fix.
//
// This script is fully STATIC: no request param is interpolated into it. The
// reflected OAuth params (state, client_id, redirect_uri, PKCE, etc.) are read
// at runtime from `data-*` attributes on the card element, which escapeHtml()
// neutralizes at the attribute sink. The params never enter a JS context, so
// the old inline `jsonForScript` shim is no longer needed.
const CONSENT_SCRIPT = `(function(){
  var card=document.getElementById("consent");
  var P={
    response_type:card.dataset.responseType,
    client_id:card.dataset.clientId,
    redirect_uri:card.dataset.redirectUri,
    code_challenge:card.dataset.codeChallenge,
    code_challenge_method:card.dataset.codeChallengeMethod,
    state:card.dataset.state,
    agent_id:card.dataset.agentId||""
  };
  function qs(o){return Object.keys(o).map(function(k){return encodeURIComponent(k)+"="+encodeURIComponent(o[k])}).join("&")}
  function done(loc){window.location.href=loc}
  function fail(){document.getElementById("err").style.display="block"}
  document.getElementById("deny").onclick=function(){
    fetch("/mcp/oauth/authorize/consent?"+qs(P)+"&consent=deny",{method:"POST",credentials:"include"})
      .then(function(r){return r.json()}).then(function(j){if(j.redirect)done(j.redirect);else fail()})
      .catch(fail)
  };
  function refresh(){
    return fetch("/api/auth/refresh",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:"{}"})
  }
  function withToken(){
    // 409: the app tab of this browser rotated the shared cookie a moment ago;
    // the rotated cookie is in place, so one retry finds the session.
    return refresh()
      .then(function(r){return r.status===409?new Promise(function(ok){setTimeout(ok,300)}).then(refresh):r})
      .then(function(r){if(!r.ok)throw new Error("no session");return r.json()})
      .then(function(j){
        var token=(j&&j.data&&j.data.accessToken)||(j&&j.accessToken);
        if(!token)throw new Error("no token");
        return token
      })
  }
  function consent(kind,proof){
    return withToken()
      .then(function(token){
        var headers={Authorization:"Bearer "+token};
        var init={method:"POST",credentials:"include",headers:headers};
        if(proof){headers["Content-Type"]="application/json";init.body=JSON.stringify(proof)}
        return fetch("/mcp/oauth/authorize/consent?"+qs(P)+"&consent="+kind,init)
      })
      .then(function(r){return r.json().then(function(j){return {status:r.status,body:j}})})
      .then(function(res){
        var j=res.body||{};
        if(j.redirect)return done(j.redirect);
        var e=new Error("denied");
        e.stepUp=(j.error&&j.error.code==="STEP_UP_REQUIRED")||res.status===422||res.status===429;
        throw e
      })
  }
  var ack=document.getElementById("ack");
  var approveBtn=document.getElementById("approve");
  // Full access also takes a fresh step-up: a code emailed to the person, sent
  // by the page itself once it knows the approval needs one (never for a silent
  // re-consent). The server refuses the approval without it. A reload within
  // the server's cooldown sends nothing; the code already sent stands.
  var stepup=document.getElementById("stepup");
  var code=document.getElementById("code");
  var resend=document.getElementById("resend");
  var sent=document.getElementById("sent");
  var wait=document.getElementById("wait");
  var sendErr=document.getElementById("senderr");
  var stepErr=document.getElementById("steperr");
  function show(el,on){if(el)el.style.display=on?"block":"none"}
  function proof(){
    if(!stepup)return null;
    var c=code&&code.value.trim();
    return c?{stepUpCode:c}:null
  }
  var cooldownLeft=0;
  function tick(){
    if(cooldownLeft<=0){if(resend)resend.disabled=false;show(wait,false);return}
    if(resend)resend.disabled=true;
    if(wait){wait.textContent="You can send a new one in "+cooldownLeft+(cooldownLeft===1?" second.":" seconds.");show(wait,true)}
    cooldownLeft--;
    setTimeout(tick,1000)
  }
  function sendCode(){
    if(!stepup)return;
    if(resend)resend.disabled=true;
    show(sendErr,false);show(stepErr,false);
    withToken()
      .then(function(token){
        return fetch("/api/auth/totp/step-up",{method:"POST",credentials:"include",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({purpose:"mcp_connect"})})
      })
      .then(function(r){if(!r.ok)throw new Error("not sent");return r.json()})
      .then(function(j){
        var d=(j&&j.data)||{};
        show(sent,true);
        if(code)code.focus();
        var wasRunning=cooldownLeft>0;
        cooldownLeft=Number(d.retryAfterSeconds)||0;
        if(!wasRunning)tick()
      })
      .catch(function(){show(sendErr,true);if(resend)resend.disabled=false})
  }
  if(resend)resend.onclick=function(){if(cooldownLeft<=0)sendCode()};
  // An application bound to no agent receives EVERYTHING the person can do: Approve stays
  // disabled until they say they understand that (the server refuses it without the same ack).
  if(ack){approveBtn.disabled=true;ack.onchange=function(){approveBtn.disabled=!ack.checked}}
  approveBtn.onclick=function(){
    var btn=this;
    var pr=proof();
    if(stepup&&!pr){show(stepErr,true);return}
    btn.disabled=true;show(stepErr,false);
    if(ack&&ack.checked)P.ack="full";
    consent("approve",pr).catch(function(e){
      btn.disabled=ack?!ack.checked:false;
      if(e&&e.stepUp&&stepup){if(code)code.value="";show(stepErr,true)}else fail()
    })
  };
  // Silent re-consent: a client this user ALREADY authorized (live connection
  // on record) reconnects without a click — redeploys and session drops stop
  // demanding a fresh manual approval. First-time connects still require the
  // explicit button (the auto call is rejected server-side). Only then, when the
  // page stays for a full-access approval, does it email the code.
  consent("auto").catch(function(){sendCode()})
})();
`

// The page references the script by a hash of its content, so a release that
// changes it changes the URL: a browser (or a CDN that sets its own browser TTL)
// holding the previous script never runs it against the new page.
const CONSENT_SCRIPT_VERSION = createHash("sha256")
  .update(CONSENT_SCRIPT)
  .digest("hex")
  .slice(0, 16)
const CONSENT_SCRIPT_SRC = `/mcp/oauth/authorize.js?v=${CONSENT_SCRIPT_VERSION}`

// GET /authorize.js — the consent page's button wiring, served as a static
// same-origin script so it loads under `script-src 'self'`. Public (the
// consent page that references it is public); contains no secrets or
// per-request data. Immutable at its versioned URL; any other URL (an old
// page, a missing or stale `v`) is served the current script uncached.
mcpOAuth.get("/authorize.js", (c) =>
  c.body(CONSENT_SCRIPT, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control":
      c.req.query("v") === CONSENT_SCRIPT_VERSION
        ? "public, max-age=31536000, immutable"
        : "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
  }),
)

// GET /authorize — UNAUTHENTICATED consent screen (spec C1: "the authorization
// page is a logged-in consent screen showing the requesting client and the
// scope of access"). It NEVER issues a code. The user must explicitly approve;
// the Approve action obtains a fresh access token via the httpOnly refresh
// cookie (same as the SPA bootstrap) and POSTs it to /authorize/consent. A
// bare GET (no consent action) returns only the page — no grant.
mcpOAuth.get("/authorize", async (c) => {
  const p = readAuthorizeParams((k) => c.req.query(k))
  const v = await validateAuthorize(c, p)
  if (!v.ok) return v.res

  const clientLabel = v.client.clientName?.trim() || "an MCP client"
  const destination = redirectDestination(p.redirectUri)
  // The OAuth params ride to the client as `data-*` attributes (escaped at the
  // HTML attribute sink), NOT interpolated into JS. The external script
  // (/mcp/oauth/authorize.js) reads them from `card.dataset` at runtime, so no
  // request value ever enters a script context.
  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Authorize ${escapeHtml(clientLabel)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1c1e21}
.card{max-width:420px;margin:8vh auto;background:#fff;border:1px solid #e3e5e8;border-radius:12px;padding:28px}
h1{font-size:18px;margin:0 0 4px}
p{color:#52575d;margin:8px 0}
.client{font-weight:600;color:#1c1e21}
.scope{background:#f0f1f3;border-radius:8px;padding:10px 12px;margin:16px 0;font-size:14px}
.row{display:flex;gap:10px;margin-top:20px}
button{flex:1;padding:10px 14px;border-radius:8px;border:1px solid #d0d3d7;font:inherit;cursor:pointer}
.approve{background:#1c1e21;color:#fff;border-color:#1c1e21}
.warn{background:#fff4e5;border:1px solid #f0c987;border-radius:8px;padding:10px 12px;margin:14px 0;font-size:14px;color:#5c3b00}
.ackrow{display:block;margin:12px 0;font-size:14px}
.dest{font-family:ui-monospace,monospace;font-weight:600;word-break:break-all}
.err{color:#b3261e;margin-top:14px;font-size:14px;display:none}
.stepup{border-top:1px solid #e3e5e8;margin-top:14px;padding-top:12px;font-size:14px}
.stepup .title{font-weight:600;color:#1c1e21;margin:0}
.field{display:block;margin:10px 0;font-size:14px}
.field input{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:8px 10px;border:1px solid #d0d3d7;border-radius:8px;font:inherit}
.sent{display:none;color:#1c1e21;font-size:14px;margin:6px 0}
.hint{color:#52575d;font-size:13px;margin:4px 0}
.link{flex:none;padding:0;border:0;background:none;color:#1c1e21;text-decoration:underline;font:inherit;cursor:pointer}
.link:disabled{color:#8a8f95;cursor:default;text-decoration:none}
.wait{display:none;color:#52575d;font-size:13px;margin:4px 0}
</style></head><body>
<div class="card" id="consent"
 data-response-type="${escapeHtml(p.responseType)}"
 data-client-id="${escapeHtml(p.clientId)}"
 data-redirect-uri="${escapeHtml(p.redirectUri)}"
 data-code-challenge="${escapeHtml(p.codeChallenge)}"
 data-code-challenge-method="${escapeHtml(p.codeChallengeMethod)}"
 data-state="${escapeHtml(p.state)}"
 data-agent-id="${escapeHtml(p.agentId)}">
<h1>Connect ${escapeHtml(clientLabel)}</h1>
<p><span class="client">${escapeHtml(clientLabel)}</span> is requesting access to Liaison on your behalf.</p>
<div class="warn" id="unverified">Unverified application. This name was chosen by the application itself; Liaison has not checked who it is. After you approve, you are sent to <span class="dest" id="dest">${escapeHtml(destination)}</span>. Approve only if you recognise that address.</div>
<div class="scope">Scope: all tools and data you can access here, gated by the same approvals.</div>
${
  p.agentId
    ? ""
    : `<label class="ackrow"><input type="checkbox" id="ack"> I understand this application will be able to act as me, with everything I can access, until I revoke it in Settings.</label>
<div class="stepup" id="stepup">
<p class="title">Confirm it's you</p>
<p>Full access needs one more confirmation: a code we email you.</p>
<p class="sent" id="sent">We emailed you a code.</p>
<label class="field" for="code">Code from the email<input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6"></label>
<p class="hint">No code arrived? Check your spam folder, or <button type="button" class="link" id="resend">send a new one</button>.</p>
<p class="wait" id="wait"></p>
<div class="err" id="senderr">The code could not be sent. Send a new one to try again.</div>
<div class="err" id="steperr">Enter the code from the email. If you did, it was not accepted: check it, or send a new one.</div>
</div>`
}
<p>Only approve if you initiated this connection.</p>
<div class="row">
<button class="deny" id="deny">Cancel</button>
<button class="approve" id="approve">Approve</button>
</div>
<div class="err" id="err">Could not complete authorization. Make sure you are signed in to Liaison in this browser, then retry.</div>
</div>
<script src="${CONSENT_SCRIPT_SRC}"></script>
</body></html>`
  return c.html(html)
})

// POST /authorize/consent — AUTHENTICATED (Bearer, behind authMiddleware in
// app.ts). This is the only place a code is minted, and only with an explicit
// consent=approve from the authenticated owner. Returns JSON `{ redirect }`
// (the consent page navigates there) so the SPA-style fetch flow works.
mcpOAuth.post("/authorize/consent", async (c) => {
  // Consenting mints an MCP connection whose tokens carry the grantor's live
  // grants: never from a restricted (device-flow) session (session-ceiling.ts).
  if (c.get("sessionRestricted") === true) {
    return c.json(
      { error: "access_denied", error_description: "a restricted device session cannot consent" },
      403,
    )
  }
  const p = readAuthorizeParams((k) => c.req.query(k))
  const v = await validateAuthorize(c, p)
  if (!v.ok) return v.res

  const consent = c.req.query("consent")
  if (consent === "deny") {
    const u = new URL(p.redirectUri)
    u.searchParams.set("error", "access_denied")
    if (p.state) u.searchParams.set("state", p.state)
    return c.json({ redirect: u.toString() })
  }
  // Silent re-consent: `consent=auto` succeeds ONLY when this user already
  // holds a live (non-revoked) connection for this exact client — i.e. they
  // explicitly approved it before. Removes the manual approve-click on every
  // reconnect (server redeploys drop MCP sessions and the client re-runs the
  // flow); a first-time client is still rejected here and must present the
  // explicit consent button. The prior approval must be for the SAME binding:
  // an approval of a connection bound to an agent is not an approval of one
  // carrying everything the person can do, nor of one bound to another agent.
  if (consent === "auto") {
    const priorUserId = c.get("userId")
    const [prior] = await withSystemDb("mcp-oauth-auto-consent", (db) =>
      db
        .select({ id: mcpConnections.id })
        .from(mcpConnections)
        .where(
          and(
            eq(mcpConnections.clientId, p.clientId),
            eq(mcpConnections.userId, priorUserId),
            isNull(mcpConnections.revokedAt),
            p.agentId ? eq(mcpConnections.agentId, p.agentId) : isNull(mcpConnections.agentId),
          ),
        )
        .limit(1),
    )
    if (!prior) {
      return c.json({ error: "consent_required" }, 403)
    }
  } else if (consent !== "approve") {
    return c.json({ error: "invalid_request", error_description: "explicit consent required" }, 400)
  }

  const userId = c.get("userId")
  const orgId = c.get("orgId")

  // A connection bound to no agent holds the grantor's FULL grants for its whole life. Approving one
  // for the first time needs the person's explicit acknowledgement of that (the consent page's
  // checkbox); binding it to an agent narrows it to that agent's ceiling and needs none. A client
  // this person already authorized (`auto`) re-connects as before.
  if (consent === "approve" && !p.agentId && c.req.query("ack") !== "full") {
    return c.json(
      {
        error: "invalid_request",
        error_description: "full-access acknowledgement required for an unbound application",
      },
      400,
    )
  }

  // The same full-access approval also takes a fresh step-up (an emailed code, never the password,
  // `full-access-step-up.ts`): a signed-in session alone must not mint a credential that outlives it.
  if (consent === "approve" && !p.agentId) {
    await assertFullAccessStepUp(userId, readFullAccessProof(await c.req.json().catch(() => ({}))))
  }

  // Optional agent binding: the desktop client asks to connect AS an agent, and
  // the consenting user's own org is the only one that can supply it. Validated
  // HERE, where the authenticated org is known, and bound to the code so the
  // token exchange (which is unauthenticated, PKCE-proved only) cannot change
  // it. A foreign-org, unknown or archived agent is refused, never silently
  // dropped to a legacy connection carrying the grantor's full scopes. Only an
  // agent this person could address (not the system agent, not a colleague's
  // personal agent): the connection acts, and is recorded, as that agent.
  const agentId = p.agentId || undefined
  if (agentId && !(await loadBindableAgent(orgId, userId, agentId))) {
    return c.json(
      { error: "invalid_request", error_description: "unknown or foreign org agent" },
      400,
    )
  }

  const code = randomBytes(32).toString("hex")
  await putAuthCode(code, {
    clientId: p.clientId,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    userId,
    orgId,
    ...(agentId ? { agentId } : {}),
  })

  const redirect = new URL(p.redirectUri)
  redirect.searchParams.set("code", code)
  if (p.state) redirect.searchParams.set("state", p.state)
  return c.json({ redirect: redirect.toString() })
})

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

mcpOAuth.post("/token", async (c) => {
  const body = await c.req.parseBody()
  const grantType = String(body.grant_type ?? "")

  if (grantType === "authorization_code") {
    const code = String(body.code ?? "")
    const codeVerifier = String(body.code_verifier ?? "")
    const clientId = String(body.client_id ?? "")

    const entry = await consumeAuthCode(code)
    if (!entry) return c.json({ error: "invalid_grant" }, 400)
    if (entry.clientId !== clientId) return c.json({ error: "invalid_grant" }, 400)
    // RFC 6749 §4.1.3: the redirect_uri presented at token exchange must match
    // the one bound to the authorization code (review N7).
    const presentedRedirectUri = String(body.redirect_uri ?? "")
    if (presentedRedirectUri !== entry.redirectUri) {
      return c.json({ error: "invalid_grant" }, 400)
    }
    if (!codeVerifier || pkceS256(codeVerifier) !== entry.codeChallenge) {
      return c.json({ error: "invalid_grant" }, 400)
    }

    const [client] = await withSystemDb("mcp-oauth-token-client", (db) =>
      db.select().from(mcpOauthClients).where(eq(mcpOauthClients.clientId, clientId)),
    )
    const label = client?.clientName?.trim() || "MCP client"

    const { connection, refreshToken } = await createMcpConnection({
      orgId: entry.orgId,
      userId: entry.userId,
      clientId,
      label,
      // Bound at consent, under the authenticated org; carried here verbatim.
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
    })
    const { token } = await mintAccessToken(connection.id)
    return c.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: MCP_ACCESS_TOKEN_TTL_SECONDS,
      // High-entropy refresh secret (<connId>.<secret>); only its hash is stored.
      refresh_token: refreshToken,
    })
  }

  if (grantType === "refresh_token") {
    const refreshToken = String(body.refresh_token ?? "")
    if (!refreshToken) return c.json({ error: "invalid_grant" }, 400)
    try {
      const { token } = await refreshAccessToken(refreshToken)
      return c.json({
        access_token: token,
        token_type: "Bearer",
        expires_in: MCP_ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refreshToken,
      })
    } catch {
      return c.json({ error: "invalid_grant" }, 400)
    }
  }

  return c.json({ error: "unsupported_grant_type" }, 400)
})
