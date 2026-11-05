// SPDX-License-Identifier: FSL-1.1-ALv2
// A9: realistic mixed traffic on load orgs, for deploys under load and the
// launch scenario. Run by `scripts/load-test.ts --deploys N` / `--launch`
// (scripts/lib/deploy-under-load.ts), which sets the env below, runs the
// deploys while this runs, and reads the JSON output it writes.
//
// LOAD_MODE=deploys  every seeded load org (LOAD_ORGS_FILE, written by
//                    load-test --deploys N --orgs N) gets two VUs: a "user" (page loads, an API write,
//                    a scripted agent turn on its agent DM, about every
//                    TURN_INTERVAL_S) and a "live" one (a WebSocket held
//                    WS_HOLD_S, reconnected at once when the server closes it).
// LOAD_MODE=launch   synthetic visitors arrive (LAUNCH_STAGES ramping VUs, or
//                    LAUNCH_ARRIVAL ramping arrival rate), each signs up through
//                    the signed demo start (the warm pool first), verifies with
//                    the code the sink read returns, then walks for WALK_S.
//
// Every agent turn runs on the box's scripted load model: its reply is known
// (LOAD_REPLIES / LOAD_FALLBACK, the catalog of load-script-catalog.ts), and
// each turn is judged: ok, mismatch, doubled, error, lost.

import { sleep } from "k6"
import http from "k6/http"
import { Counter, Rate, Trend } from "k6/metrics"
import ws from "k6/ws"
import {
  authed,
  bearer,
  expectedReply,
  foldTurn,
  parseSse,
  restartRetryDelayS,
  setPassKey,
  signedHeaders,
} from "./lib/harness.js"

const HOST = (__ENV.HOST || "http://localhost:3000").replace(/\/$/, "")
const MODE = __ENV.LOAD_MODE || "deploys"
const KEY = __ENV.LOAD_HARNESS_KEY || ""
setPassKey(KEY)
const REPLIES = JSON.parse(__ENV.LOAD_REPLIES || "[]")
const FALLBACK = __ENV.LOAD_FALLBACK || "Acknowledged."
const TURN_INTERVAL_S = Number(__ENV.TURN_INTERVAL_S || 8)
const WS_HOLD_S = Number(__ENV.WS_HOLD_S || 60)
const WALK_S = Number(__ENV.WALK_S || 300)
const PAGE_PATH = __ENV.PAGE_PATH || "/"
const NEEDS = JSON.parse(__ENV.LAUNCH_NEEDS || '["support"]')
const ORGS = MODE === "deploys" ? JSON.parse(open(__ENV.LOAD_ORGS_FILE)).orgs : []

const turnMs = new Trend("load_turn_ms", true)
const turnResult = new Counter("load_turn_result")
const wsGap = new Trend("load_ws_gap_ms", true)
const wsClose = new Counter("load_ws_server_close")
const loadErrors = new Counter("load_errors")
const ttw = new Trend("load_time_to_workspace_ms", true)
const poolHit = new Rate("load_pool_hit")
const signups = new Counter("load_signup_result")
/** 202 "being prepared" answers a start got before its workspace (a busy box). */
const signupsPreparing = new Counter("load_signup_preparing")

function scenarios() {
  if (MODE === "deploys") {
    if (ORGS.length === 0) throw new Error("LOAD_ORGS_FILE has no orgs")
    return {
      a9: {
        executor: "constant-vus",
        vus: ORGS.length * 2,
        duration: __ENV.LOAD_DURATION || "6h",
        gracefulStop: "60s",
      },
    }
  }
  if (__ENV.LAUNCH_ARRIVAL) {
    const a = JSON.parse(__ENV.LAUNCH_ARRIVAL)
    return {
      launch: {
        executor: "ramping-arrival-rate",
        startRate: 0,
        timeUnit: a.timeUnit || "1h",
        preAllocatedVUs: a.preAllocatedVUs,
        maxVUs: a.maxVUs,
        stages: a.stages,
        gracefulStop: `${WALK_S + 60}s`,
      },
    }
  }
  return {
    launch: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: JSON.parse(__ENV.LAUNCH_STAGES || '[{"target":10,"duration":"1m"}]'),
      gracefulRampDown: `${WALK_S + 60}s`,
      gracefulStop: `${WALK_S + 60}s`,
    },
  }
}

export const options = {
  scenarios: scenarios(),
  // The driver judges the run from the JSON output; no k6 thresholds.
  summaryTrendStats: ["avg", "med", "p(95)", "max"],
  discardResponseBodies: false,
}

function error(type, extra) {
  loadErrors.add(1, Object.assign({ type }, extra || {}))
}

// ── Page loads and an API write ─────────────────────────────────────────────

/**
 * Sign a request for the per-IP limiter (app.ts): every synthetic visitor comes
 * from this one generator, which real launch traffic never does, so a signed
 * request skips the per-IP budget (and only it). `path` without its query.
 */
function pass(headers, method, path, body) {
  if (!KEY) return headers
  return Object.assign(headers, signedHeaders(KEY, method, path.split("?")[0], body))
}

function pageLoads(session) {
  const shell = http.get(`${HOST}${PAGE_PATH}`, { tags: { name: "page-shell" }, responseType: "none" })
  if (shell.status !== 200) error("page", { status: String(shell.status) })
  for (const [name, path] of [
    ["threads", "/api/threads?limit=50"],
    ["attention", "/api/attention-items"],
    ["search", "/api/search?q=load"],
  ]) {
    const r = authed(HOST, session, (h) =>
      http.get(`${HOST}${path}`, { headers: pass(h, "GET", path, ""), tags: { name } }),
    )
    if (r.status !== 200) error("api_read", { status: String(r.status), route: name })
  }
}

function apiWrite(session, label) {
  const groupBody = JSON.stringify({ name: `load ${label}` })
  const r = authed(HOST, session, (h) =>
    http.post(`${HOST}/api/contacts/groups`, groupBody, {
      headers: pass(Object.assign({ "content-type": "application/json" }, h), "POST", "/api/contacts/groups", groupBody),
      tags: { name: "write-group" },
    }),
  )
  if (r.status !== 200 && r.status !== 201) error("api_write", { status: String(r.status) })
}

// ── The scripted agent turn ─────────────────────────────────────────────────

function agentDm(session) {
  const r = authed(HOST, session, (h) =>
    http.post(`${HOST}/api/threads/dm`, "{}", {
      headers: pass(Object.assign({ "content-type": "application/json" }, h), "POST", "/api/threads/dm", "{}"),
      tags: { name: "agent-dm" },
    }),
  )
  if (r.status !== 200 && r.status !== 201) {
    error("agent_dm", { status: String(r.status) })
    return null
  }
  const body = r.json()
  const id = body && body.data && (body.data.id || body.data.threadId)
  // A fresh DM has had no turn: its first turn plays the thread's script.
  return id ? { id, ordinal: r.status === 201 ? 0 : null } : null
}

/** One turn; `dm.ordinal` (null = unknown) advances only when a turn is done. */
function runTurn(session, dm) {
  const started = Date.now()
  const body = JSON.stringify({ threadId: dm.id, content: `load turn ${started}` })
  const post = () =>
    authed(HOST, session, (h) =>
      http.post(`${HOST}/api/agent/chat`, body, {
        headers: pass(Object.assign({ "content-type": "application/json" }, h), "POST", "/api/agent/chat", body),
        tags: { name: "agent-chat" },
        timeout: "300s",
      }),
    )
  let r = post()
  // A draining server refused before saving anything: once more, as the web
  // client does. The refusal itself still counts as a 5xx (the edge served it).
  const retryS = restartRetryDelayS(r)
  if (retryS !== null) {
    error("turn_restart_retried")
    sleep(retryS)
    r = post()
  }
  if (r.status === 429) {
    // Refused before it started (the per-person turn rate): no turn exists.
    error("turn_refused_429")
    return
  }
  let st = r.status === 200 ? foldTurn(parseSse(r.body)) : null
  if (!st) {
    error("turn_http", { status: String(r.status) })
    turnResult.add(1, { verdict: "lost", followed: "no" })
    dm.ordinal = null
    return
  }
  let follows = 0
  while ((st.terminal === "restart" || st.terminal === null) && st.turnId && follows < 10) {
    follows++
    const e = authed(HOST, session, (h) =>
      http.get(`${HOST}/api/agent/turns/${st.turnId}/events`, {
        headers: pass(h, "GET", `/api/agent/turns/${st.turnId}/events`, ""),
        tags: { name: "agent-reattach" },
        timeout: "600s",
      }),
    )
    if (e.status !== 200) {
      error("reattach_http", { status: String(e.status) })
      break
    }
    // The re-attach stream sends the text so far from its start.
    st = foldTurn(parseSse(e.body), {
      text: "",
      terminal: null,
      turnId: st.turnId,
      doneText: null,
      error: null,
    })
  }
  const followed = follows > 0 ? "yes" : "no"
  let verdict
  if (st.terminal === "done") {
    const final = (st.doneText !== null ? st.doneText : st.text).trim()
    const firstReply = expectedReply(REPLIES, FALLBACK, dm.id, 0)
    const ok =
      dm.ordinal === null
        ? final === firstReply || final === FALLBACK
        : final === expectedReply(REPLIES, FALLBACK, dm.id, dm.ordinal)
    if (ok) verdict = "ok"
    else if (final.split(firstReply).length > 2 || final.split(FALLBACK).length > 2) verdict = "doubled"
    else verdict = "mismatch"
    dm.ordinal = dm.ordinal === null ? null : dm.ordinal + 1
    if (dm.ordinal === null && final === FALLBACK) dm.ordinal = 1
  } else if (st.terminal === "error") {
    verdict = "error"
    error("turn_error", { code: String(st.error) })
    dm.ordinal = null
  } else {
    verdict = "lost"
    dm.ordinal = null
  }
  turnMs.add(Date.now() - started, { verdict, followed })
  turnResult.add(1, { verdict, followed })
}

// ── The live socket ─────────────────────────────────────────────────────────

let lastServerClose = 0

function liveSocket(session) {
  const t = authed(HOST, session, (h) =>
    http.post(`${HOST}/api/auth/ws-ticket`, null, {
      headers: pass(h, "POST", "/api/auth/ws-ticket", ""),
      tags: { name: "ws-ticket" },
    }),
  )
  const ticket = t.status === 200 ? t.json().data && t.json().data.ticket : null
  if (!ticket) {
    error("ws_ticket", { status: String(t.status) })
    sleep(1)
    return
  }
  let closedByUs = false
  const url = `${HOST.replace(/^http/, "ws")}/ws?ticket=${ticket}`
  const res = ws.connect(url, { tags: { name: "ws" } }, (socket) => {
    socket.on("open", () => {
      if (lastServerClose) wsGap.add(Date.now() - lastServerClose)
      lastServerClose = 0
    })
    socket.on("close", (code) => {
      if (!closedByUs) {
        wsClose.add(1, { code: String(code) })
        lastServerClose = Date.now()
      }
    })
    socket.on("error", () => {
      if (!closedByUs && !lastServerClose) lastServerClose = Date.now()
    })
    socket.setTimeout(() => {
      closedByUs = true
      socket.close()
    }, WS_HOLD_S * 1000)
  })
  if (!res || res.status !== 101) {
    error("ws_connect", { status: String(res ? res.status : 0) })
    if (!lastServerClose) lastServerClose = Date.now()
    sleep(1)
  }
}

// ── Deploys mode ────────────────────────────────────────────────────────────

let dm = null
let session = null
let iteration = 0

function deploysIteration() {
  const index = Math.floor((__VU - 1) / 2) % ORGS.length
  const live = (__VU - 1) % 2 === 1
  const org = ORGS[index]
  if (!session) {
    const s = org.sessions[live ? Math.min(1, org.sessions.length - 1) : 0]
    session = { accessToken: s.accessToken, refreshCookie: s.refreshCookie, issuedAt: s.issuedAt }
  }
  if (live) {
    liveSocket(session)
    return
  }
  const began = Date.now()
  iteration++
  pageLoads(session)
  apiWrite(session, `${__VU}-${iteration}`)
  if (!dm) dm = agentDm(session)
  if (dm) runTurn(session, dm)
  const rest = TURN_INTERVAL_S - (Date.now() - began) / 1000
  if (rest > 0) sleep(rest)
}

// ── Launch mode: one visitor per iteration ──────────────────────────────────

function signedJson(method, path, body, extra) {
  return Object.assign(
    { "content-type": "application/json" },
    signedHeaders(KEY, method, path, body),
    extra || {},
  )
}

function refreshCookieOf(res) {
  for (const name of Object.keys(res.cookies || {})) {
    const c = res.cookies[name]
    if (name.indexOf("liaison_rt") >= 0 && c.length > 0 && c[0].value) return `${name}=${c[0].value}`
  }
  return null
}

function visitor() {
  const rand = `${__VU}-${__ITER}-${Date.now()}`
  const body = JSON.stringify({
    name: "Load visitor",
    email: `visitor-${rand}@load.invalid`,
    needs: NEEDS,
    turnstileToken: "-",
    signupKey: `load-${rand}-${"x".repeat(24)}`.slice(0, 120),
  })
  const t0 = Date.now()
  const start = () =>
    http.post(`${HOST}/api/demo/orgs`, body, {
      headers: signedJson("POST", "/api/demo/orgs", body),
      tags: { name: "demo-start" },
      timeout: "120s",
    })
  let r = start()
  // A busy box answers 202 "creating" and finishes the start behind the answer;
  // like the browser, ask again with the same signup key after the server's own
  // wait, for up to two minutes. Time to workspace counts the whole wait.
  while (r.status === 202 && Date.now() - t0 < 120_000) {
    signupsPreparing.add(1)
    sleep(Number(r.headers["Retry-After"]) || 2)
    r = start()
  }
  signups.add(1, { status: String(r.status) })
  if (r.status !== 201) {
    error("signup", { status: String(r.status) })
    sleep(5)
    return
  }
  const data = r.json().data
  const pooled = data.state === "ready"
  poolHit.add(pooled)
  let state = data.state
  while (state === "provisioning" && Date.now() - t0 < 300_000) {
    sleep(1)
    const path = `/api/demo/orgs/${data.orgId}/status`
    const s = http.get(`${HOST}${path}`, {
      headers: signedHeaders(KEY, "GET", path, ""),
      tags: { name: "demo-status" },
    })
    if (s.status === 200) state = s.json().data.state
  }
  ttw.add(Date.now() - t0, { pooled: pooled ? "yes" : "no", state, org: data.orgId })
  if (state !== "ready" && state !== "partial") {
    error("workspace_not_ready", { state: String(state) })
    return
  }
  const sess = {
    accessToken: data.accessToken,
    refreshCookie: refreshCookieOf(r),
    issuedAt: Date.now(),
  }
  // A fresh workspace was seeded behind the start, and the seed's app
  // registrations raised the visitor's permission version: the token the start
  // handed out is stale now, and its first use answers 401 by design (the web
  // client refreshes and retries). Refresh once here, as the web client's first
  // retry would, so that expected 401 is not counted as an error: it was one
  // http_401 per fresh visitor in every launch run (147 = 653 fresh - 506 never
  // ready, 223 = 884 - 661), every one followed by a verify that passed.
  if (!pooled) bearer(HOST, sess, true)
  const sinkPath = `/api/demo/harness/orgs/${data.orgId}/sink`
  const sink = http.get(`${HOST}${sinkPath}`, {
    headers: signedHeaders(KEY, "GET", sinkPath, ""),
    tags: { name: "harness-sink" },
  })
  const code = sink.status === 200 ? sink.json().data.demoCode : null
  if (!code) error("sink_code", { status: String(sink.status) })
  else {
    const vb = JSON.stringify({ code })
    const v = authed(HOST, sess, (h) =>
      http.post(`${HOST}/api/demo/verify`, vb, {
        headers: signedJson("POST", "/api/demo/verify", vb, h),
        tags: { name: "demo-verify" },
      }),
    )
    if (v.status !== 200) error("verify", { status: String(v.status) })
  }
  const thread = agentDm(sess)
  const until = Date.now() + WALK_S * 1000
  let n = 0
  while (Date.now() < until) {
    const began = Date.now()
    n++
    pageLoads(sess)
    if (n % 3 === 0) apiWrite(sess, `${rand}-${n}`)
    if (thread) runTurn(sess, thread)
    const rest = Math.min(TURN_INTERVAL_S - (Date.now() - began) / 1000, (until - Date.now()) / 1000)
    if (rest > 0) sleep(rest)
  }
}

export default function () {
  if (MODE === "deploys") deploysIteration()
  else visitor()
}

export function handleSummary(data) {
  const out = {}
  if (__ENV.K6_SUMMARY_FILE) out[__ENV.K6_SUMMARY_FILE] = JSON.stringify(data)
  return out
}
