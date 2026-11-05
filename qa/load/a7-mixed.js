// SPDX-License-Identifier: FSL-1.1-ALv2
// A7 — Mixed workload, 50 concurrent VUs for 5 minutes.
// Distribution: 60% reads (threads/attention), 20% WS subscribe, 15% writes
// (post message), 5% search. Targets: A1–A6 drift < 10%; error rate < 0.5%.

import http from "k6/http"
import ws from "k6/ws"
import { check } from "k6"
import { Counter, Trend } from "k6/metrics"
import { login, authHeaders } from "./lib/auth.js"

const HOST = __ENV.HOST || "http://localhost:3000"
const EMAIL = __ENV.LOAD_EMAIL || "load@qa.local"
const PASSWORD = __ENV.LOAD_PASSWORD || "QaPass1!"

const errs = new Counter("a7_errors")
// Drift trend for A2 (WS delivery) measured *during* the mixed workload — the
// spec's "no A1–A6 target drifts > 10%" requires us to track it here, not
// only in the isolated A2 run. p95 threshold is the same 10% drift envelope
// as the other latency thresholds below.
const wsDriftMs = new Trend("a7_ws_delivery_ms", true)

export const options = {
  scenarios: {
    warmup: { executor: "constant-vus", vus: 10, duration: "60s", gracefulStop: "5s" },
    measured: {
      executor: "constant-vus",
      vus: 50,
      duration: "5m",
      startTime: "65s",
      gracefulStop: "15s",
      tags: { phase: "measured" },
    },
  },
  thresholds: {
    "http_req_failed{phase:measured}": ["rate<0.005"],
    // 10% drift envelope around each A4–A6 isolated threshold (300/200/200ms).
    "http_req_duration{phase:measured,name:attention-feed}": ["p(95)<330"],
    "http_req_duration{phase:measured,name:thread-list}": ["p(95)<220"],
    "http_req_duration{phase:measured,name:search}": ["p(95)<220"],
    // A2 in-mix drift envelope: 100ms isolated * 1.10 = 110ms.
    "a7_ws_delivery_ms{phase:measured}": ["p(95)<110"],
  },
}

export function setup() {
  return { token: login(HOST, EMAIL, PASSWORD) }
}

function freshTicket(token) {
  const r = http.post(`${HOST}/api/auth/ws-ticket`, null, { headers: authHeaders(token) })
  if (r.status !== 200) return ""
  const body = JSON.parse(r.body)
  return (body.data && body.data.ticket) || body.ticket || ""
}

function pick() {
  const r = Math.random()
  if (r < 0.6) return "read"
  if (r < 0.8) return "ws"
  if (r < 0.95) return "write"
  return "search"
}

export default function (data) {
  const action = pick()
  const headers = { ...authHeaders(data.token), "content-type": "application/json" }
  if (action === "read") {
    const which = Math.random() < 0.5 ? "attention-feed" : "thread-list"
    const url = which === "attention-feed" ? "/api/attention-items" : "/api/threads?limit=50"
    const r = http.get(`${HOST}${url}`, { headers, tags: { phase: "measured", name: which } })
    if (r.status !== 200) errs.add(1)
  } else if (action === "ws") {
    // WS tickets are single-use (consumed via Redis getdel in the /ws
    // handshake), so a per-VU iteration must mint its own — sharing one from
    // setup() means only the first iteration ever connects.
    const ticket = freshTicket(data.token)
    if (!ticket) return
    const url = `${HOST.replace(/^http/, "ws")}/ws?ticket=${ticket}`
    ws.connect(url, {}, (socket) => {
      socket.on("open", () => {
        socket.send(JSON.stringify({ type: "hello", lastEventId: 0 }))
        // Trigger a server-side emit so we can measure WS delivery latency in
        // the mixed workload — same loadtest endpoint A2 uses.
        http.post(`${HOST}/api/__loadtest/ws-emit`, null, { headers })
      })
      socket.on("message", (msg) => {
        try {
          const m = JSON.parse(msg)
          const p = m && m.type === "event" ? m.payload : null
          if (!p) return
          const ts = p.data && p.data._serverEmittedAt
          if (p.app === "kernel" && p.entity === "loadtest" && p.action === "emit" && ts) {
            wsDriftMs.add(Date.now() - ts)
          }
        } catch {}
      })
      socket.setTimeout(() => socket.close(), 2000)
    })
  } else if (action === "write") {
    const threadId = __ENV.LOAD_WRITE_THREAD_ID
    if (!threadId) return
    // sendMessageSchema expects `content`, not `body` — the earlier script
    // sent `body` and 400'd on every write, dragging the mixed error rate to
    // 12.5% even with all reads/WS/search succeeding.
    const r = http.post(
      `${HOST}/api/threads/${threadId}/messages`,
      JSON.stringify({ content: `load message ${Date.now()}` }),
      { headers, tags: { phase: "measured", name: "post-message" } },
    )
    if (r.status >= 300) errs.add(1)
  } else {
    const r = http.get(`${HOST}/api/search?q=alpha`, {
      headers,
      tags: { phase: "measured", name: "search" },
    })
    check(r, { "search ok": (res) => res.status === 200 })
  }
}
