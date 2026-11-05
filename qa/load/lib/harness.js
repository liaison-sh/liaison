// SPDX-License-Identifier: FSL-1.1-ALv2
// k6 side of the load harness (apps/api/src/lib/load-harness.ts): request
// signing with the box's LOAD_HARNESS_KEY, sessions that refresh themselves,
// and the scripted agent turn with its expected reply.
//
// The signature is HMAC-SHA256(key, METHOD \n path \n ts \n nonce \n sha256hex(body)),
// the same as scripts/lib/load-harness-client.ts and the server.

import crypto from "k6/crypto"
import http from "k6/http"

export const TS_HEADER = "x-liaison-harness-timestamp"
export const NONCE_HEADER = "x-liaison-harness-nonce"
export const SIG_HEADER = "x-liaison-harness-signature"

function nonce() {
  return `k6${crypto.hexEncode(crypto.randomBytes(16))}`
}

/** The harness headers for one request (the exact body bytes are signed). */
export function signedHeaders(key, method, path, body) {
  const ts = String(Date.now())
  const n = nonce()
  const bodyHash = crypto.sha256(body || "", "hex")
  const sig = crypto.hmac("sha256", key, [method.toUpperCase(), path, ts, n, bodyHash].join("\n"), "hex")
  return { [TS_HEADER]: ts, [NONCE_HEADER]: n, [SIG_HEADER]: sig }
}

/** The reply a load org's turn must end with (load-script-catalog.ts). */
export function expectedReply(replies, fallback, threadId, ordinal) {
  if (ordinal > 0) return fallback
  const index = parseInt(crypto.sha256(threadId, "hex").slice(0, 8), 16) % replies.length
  return replies[index]
}

const ACCESS_REFRESH_MS = 10 * 60 * 1000

let passKey = ""

/** The harness key the token refresh is signed with (the per-IP limiter pass, app.ts). */
export function setPassKey(key) {
  passKey = key || ""
}

/**
 * A session: `{ accessToken, refreshCookie: "name=value", issuedAt }`. The
 * access token lives 15 min; it is refreshed after 10 with the refresh cookie
 * (rotated on every refresh, so one session belongs to one VU), or at once
 * with `force` (a 401: the org's permissions changed, as the web client does).
 */
export function bearer(host, session, force) {
  if ((force || Date.now() - session.issuedAt > ACCESS_REFRESH_MS) && session.refreshCookie) {
    const eq = session.refreshCookie.indexOf("=")
    const name = session.refreshCookie.slice(0, eq)
    const headers = { "content-type": "application/json", cookie: session.refreshCookie }
    if (passKey) Object.assign(headers, signedHeaders(passKey, "POST", "/api/auth/refresh", "{}"))
    const r = http.post(`${host}/api/auth/refresh`, "{}", {
      headers,
      tags: { name: "auth-refresh" },
    })
    if (r.status === 200) {
      const body = r.json()
      const token = body && body.data && body.data.accessToken
      if (token) session.accessToken = token
      const fresh = r.cookies[name]
      if (fresh && fresh.length > 0 && fresh[0].value) session.refreshCookie = `${name}=${fresh[0].value}`
      session.issuedAt = Date.now()
    }
  }
  return { Authorization: `Bearer ${session.accessToken}` }
}

/**
 * Run `send(headers)` with the session's bearer; on a 401, refresh once and
 * send again (what the web client does when a token goes stale).
 */
export function authed(host, session, send) {
  const res = send(bearer(host, session, false))
  if (res.status !== 401 || !session.refreshCookie) return res
  return send(bearer(host, session, true))
}

/**
 * A draining server's refusal (503 RESTARTING): it saved nothing, so one
 * retry after its Retry-After (a second without one, at most 5) reaches a
 * live process and cannot double the turn. What the web client does.
 */
export function restartRetryDelayS(res) {
  if (res.status !== 503) return null
  let code = null
  try {
    const body = res.json()
    code = body && body.error && body.error.code
  } catch (_) {
    return null
  }
  if (code !== "RESTARTING") return null
  const raw = res.headers["Retry-After"] || res.headers["retry-after"] || ""
  const s = raw.trim() === "" ? Number.NaN : Number(raw)
  if (!Number.isFinite(s) || s < 0) return 1
  return Math.min(s, 5)
}

/** Parse an SSE body into `[{event, data}]`. */
export function parseSse(body) {
  const out = []
  if (!body) return out
  for (const block of String(body).split(/\r?\n\r?\n/)) {
    let event = "message"
    const data = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
    }
    if (data.length === 0) continue
    let parsed = null
    try {
      parsed = JSON.parse(data.join("\n"))
    } catch (_) {
      parsed = data.join("\n")
    }
    out.push({ event, data: parsed })
  }
  return out
}

/**
 * Fold SSE frames into the turn's state: the text so far, the terminal frame
 * (`done` | `error` | `restart` | null) and how many text deltas came.
 */
export function foldTurn(frames, state) {
  const s = state || { text: "", terminal: null, turnId: null, doneText: null, error: null }
  for (const f of frames) {
    const d = f.data || {}
    if (f.event === "message-start" && d.turnId) s.turnId = d.turnId
    else if (f.event === "text-delta" && typeof d.delta === "string") s.text += d.delta
    else if (f.event === "rewind" && typeof d.text === "string") s.text = d.text
    else if (f.event === "done") {
      s.terminal = "done"
      if (typeof d.text === "string") s.doneText = d.text
    } else if (f.event === "error") {
      s.terminal = "error"
      s.error = (d && d.code) || "error"
    } else if (f.event === "restart") {
      s.terminal = "restart"
      if (d.turnId) s.turnId = d.turnId
    }
  }
  return s
}
