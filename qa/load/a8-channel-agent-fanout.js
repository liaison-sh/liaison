// SPDX-License-Identifier: FSL-1.1-ALv2
// A8 — Channel fan-out with tens of always-present agent members.
//
// Home channels carry one personal agent per human plus the named role agents,
// so a single message fans out to a membership an order of magnitude larger
// than a DM. This scenario pins that the fan-out stays complete and inside A2's
// latency envelope when the channel's participant rows are mostly agents.
//
// The test:
//  1. Five human VUs open a WS connection each and subscribe from "now".
//  2. VU 1 posts a burst of BURST_MESSAGES messages to the seeded channel.
//  3. Every VU counts the distinct kernel:message:create frames it receives for
//     that thread, and records delivery latency from the server's own
//     `createdAt` stamp into A2's `ws_delivery_ms` Trend.
//  4. check() fails the run if any VU saw fewer than BURST_MESSAGES messages.
//
// Preconditions on the target (staging only, never a local dev server):
//  - the channel and its agent members are seeded, so the thread named by LOAD_CHANNEL_THREAD_ID carries at least
//    EXPECTED_AGENT_PARTICIPANTS agent participant rows. Agent participants are
//    rows, not sockets: they cost fan-out work without connecting.
//  - the load user (LOAD_EMAIL) is a participant of that channel.

import ws from "k6/ws"
import http from "k6/http"
import { check, fail } from "k6"
import { Trend } from "k6/metrics"
import { login, authHeaders } from "./lib/auth.js"

const HOST = __ENV.HOST || "http://localhost:3000"
const EMAIL = __ENV.LOAD_EMAIL || "load@qa.local"
const PASSWORD = __ENV.LOAD_PASSWORD || "QaPass1!"
const THREAD_ID = __ENV.LOAD_CHANNEL_THREAD_ID || ""

// Same Trend name and same p95 budget as a2-ws-delivery.js: this scenario is
// A2's delivery target measured on a channel-sized membership, not a new target.
// DECISION (slice 4a, measured on the first staging run): a8 measures from the
// server's own createdAt stamp, and a kernel message reaches the socket only on
// the outbox worker's next tick (apps/api/src/infra/events/outbox-worker.ts,
// POLL_INTERVAL_MS = 1000 outside NODE_ENV=test), so every sample carries a
// 0 to 1 s wait that A2's in-process emit never sees (A2 measured p(95) 7 ms on
// the same box, a8 1.01 s, a flat 0 to 1 s spread). The budget is therefore
// one outbox tick plus A2's 100 ms socket-hop envelope, with a small margin.
// It pins fan-out, not the poll: a per-recipient cost would show as a right
// tail past this ceiling, never as a flat spread under it.
const OUTBOX_POLL_INTERVAL_MS = 1000
const WS_DELIVERY_P95_MS = OUTBOX_POLL_INTERVAL_MS + 100 + 100
const HUMAN_CONNECTIONS = 5
const EXPECTED_AGENT_PARTICIPANTS = 40
const BURST_MESSAGES = 100
const BURST_INTERVAL_MS = 200
const BURST_START_MS = 5000
const SOCKET_LIFETIME_MS = BURST_START_MS + BURST_MESSAGES * BURST_INTERVAL_MS + 10000

const wsLatency = new Trend("ws_delivery_ms", true)

export const options = {
  scenarios: {
    fanout: {
      executor: "per-vu-iterations",
      vus: HUMAN_CONNECTIONS,
      iterations: 1,
      maxDuration: "5m",
      gracefulStop: "30s",
      tags: { phase: "measured" },
    },
  },
  thresholds: {
    "ws_delivery_ms{phase:measured}": [`p(95)<${WS_DELIVERY_P95_MS}`],
    checks: ["rate==1.0"],
  },
}

export function setup() {
  if (!THREAD_ID) fail("a8: LOAD_CHANNEL_THREAD_ID is required (the seeded channel thread)")
  const token = login(HOST, EMAIL, PASSWORD)
  const r = http.get(`${HOST}/api/threads/${THREAD_ID}`, { headers: authHeaders(token) })
  if (!check(r, { "channel thread readable": (res) => res.status === 200 })) {
    fail(`a8: thread ${THREAD_ID}: ${r.status} ${r.body}`)
  }
  // The read side does not expose participant_type yet (that is the Home UI's
  // slice), so the agent-member count is a precondition of the seed rather than
  // something this script can assert. Record what it expects so a run against an
  // unseeded box is readable in the output.
  console.log(
    `a8: channel ${THREAD_ID}, expecting >= ${EXPECTED_AGENT_PARTICIPANTS} agent participant rows from the seed`,
  )
  return { token }
}

function freshTicket(token) {
  // WS tickets are single-use (consumed via Redis getdel on /ws connect), so
  // every VU mints its own — see a2-ws-delivery.js's setup note.
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
  const headers = { ...authHeaders(data.token), "content-type": "application/json" }
  const seen = {}
  let received = 0

  const res = ws.connect(url, {}, (socket) => {
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "hello", lastEventId: 0 }))
    })
    socket.on("message", (msg) => {
      try {
        const m = JSON.parse(msg)
        const p = m && m.type === "event" ? m.payload : null
        if (!p || p.app !== "kernel" || p.entity !== "message" || p.action !== "create") return
        const d = p.data || {}
        if (d.threadId !== THREAD_ID) return
        const id = d.id || p.entityId
        if (!id || seen[id]) return
        seen[id] = true
        received++
        const createdAt = d.createdAt ? Date.parse(d.createdAt) : NaN
        if (!Number.isNaN(createdAt)) wsLatency.add(Date.now() - createdAt)
      } catch {}
    })

    // One VU drives the burst; the other four are pure receivers, which is what
    // makes an incomplete fan-out visible rather than self-inflicted.
    if (__VU === 1) {
      let sent = 0
      socket.setTimeout(() => {
        socket.setInterval(() => {
          if (sent >= BURST_MESSAGES) return
          sent++
          http.post(
            `${HOST}/api/threads/${THREAD_ID}/messages`,
            JSON.stringify({ content: `a8 fanout ${sent} ${Date.now()}` }),
            { headers, tags: { phase: "measured", name: "post-message" } },
          )
        }, BURST_INTERVAL_MS)
      }, BURST_START_MS)
    }

    socket.setTimeout(() => socket.close(), SOCKET_LIFETIME_MS)
  })

  check(res, { "ws connected": (r) => r && r.status === 101 })
  check(received, {
    "every burst message reached this connection": (n) => n >= BURST_MESSAGES,
  })
}
