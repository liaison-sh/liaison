// SPDX-License-Identifier: FSL-1.1-ALv2
// A2 — WebSocket message delivery p95 < 100ms.
// Measures the time from server emitting a kernel event to the client onmessage.
//
// The test:
//  1. Each VU opens a WS connection.
//  2. Each VU calls `POST /api/__loadtest/ws-emit` periodically over HTTP.
//  3. That endpoint broadcasts an ephemeral `kernel:loadtest:emit` event
//     stamped with `_serverEmittedAt: Date.now()` on the server.
//  4. The WS handler on the same VU receives it and records
//     `Date.now() - _serverEmittedAt` to the `ws_delivery_ms` Trend.
//
// Requires the server to be started with ENABLE_LOAD_TEST_ENDPOINT=true.

import ws from "k6/ws"
import http from "k6/http"
import { check, fail } from "k6"
import { Trend } from "k6/metrics"
import { login, authHeaders } from "./lib/auth.js"

const HOST = __ENV.HOST || "http://localhost:3000"
const EMAIL = __ENV.LOAD_EMAIL || "load@qa.local"
const PASSWORD = __ENV.LOAD_PASSWORD || "QaPass1!"

const wsLatency = new Trend("ws_delivery_ms", true)

export const options = {
  scenarios: {
    warmup: {
      executor: "constant-vus",
      vus: 5,
      duration: "60s",
      startTime: "0s",
      gracefulStop: "5s",
      tags: { phase: "warmup" },
    },
    measured: {
      executor: "constant-vus",
      vus: 20,
      duration: "5m",
      startTime: "65s",
      gracefulStop: "10s",
      tags: { phase: "measured" },
    },
  },
  thresholds: {
    "ws_delivery_ms{phase:measured}": ["p(95)<100"],
  },
}

export function setup() {
  // Only the token is shareable across VUs. WS tickets are single-use
  // (consumed via Redis getdel on /ws connect), so each VU iteration must
  // mint its own. Returning the ticket from setup() — as the original
  // version did — meant the first connect consumed it and every other VU
  // saw 99.96% failures, hot-looping on instant ws.connect() rejections.
  return { token: login(HOST, EMAIL, PASSWORD) }
}

function freshTicket(token) {
  const r = http.post(`${HOST}/api/auth/ws-ticket`, null, { headers: authHeaders(token) })
  if (!check(r, { "ws ticket ok": (res) => res.status === 200 })) {
    fail(`ws-ticket: ${r.status} ${r.body}`)
  }
  const body = JSON.parse(r.body)
  return (body.data && body.data.ticket) || body.ticket
}

export default function (data) {
  const ticket = freshTicket(data.token)
  const url = `${HOST.replace(/^http/, "ws")}/ws?ticket=${ticket}`
  const headers = authHeaders(data.token)
  const res = ws.connect(url, {}, (socket) => {
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "hello", lastEventId: 0 }))
    })
    socket.on("message", (msg) => {
      try {
        const m = JSON.parse(msg)
        // Server frames events as { type: "event", payload: { app, entity,
        // action, data, ... } } — see WebSocketManager.broadcast(). The
        // first attempt unwrapped from the top level and silently captured
        // zero samples (k6 v2.0.0 treats no-samples thresholds as pass).
        const p = m && m.type === "event" ? m.payload : null
        if (!p) return
        const ts = p.data && p.data._serverEmittedAt
        if (p.app === "kernel" && p.entity === "loadtest" && p.action === "emit" && ts) {
          wsLatency.add(Date.now() - ts)
        }
      } catch {}
    })
    // Trigger one server-side emit per second per VU for 10s, then close.
    socket.setInterval(() => {
      http.post(`${HOST}/api/__loadtest/ws-emit`, null, { headers })
    }, 1000)
    socket.setTimeout(() => socket.close(), 10000)
  })
  check(res, { "ws connected": (r) => r && r.status === 101 })
}
