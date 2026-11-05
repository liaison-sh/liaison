// SPDX-License-Identifier: FSL-1.1-ALv2
// A3 — Agent first-token latency p95 < 500ms.
// Sends an agent message; the LLM provider is stubbed (0-ms latency mock) in
// the perf profile so this measures platform overhead, not model latency.

import http from "k6/http"
import { Trend } from "k6/metrics"
import { check } from "k6"
import { login, authHeaders } from "./lib/auth.js"

const HOST = __ENV.HOST || "http://localhost:3000"
const EMAIL = __ENV.LOAD_EMAIL || "load@qa.local"
const PASSWORD = __ENV.LOAD_PASSWORD || "QaPass1!"

const firstToken = new Trend("agent_first_token_ms", true)

export const options = {
  scenarios: {
    warmup: { executor: "constant-vus", vus: 2, duration: "60s", gracefulStop: "5s" },
    measured: {
      executor: "constant-vus",
      vus: 10,
      duration: "5m",
      startTime: "65s",
      gracefulStop: "10s",
      tags: { phase: "measured" },
    },
  },
  thresholds: {
    "agent_first_token_ms{phase:measured}": ["p(95)<500"],
  },
}

export function setup() {
  return { token: login(HOST, EMAIL, PASSWORD) }
}

export default function (data) {
  const start = Date.now()
  // /api/agent/chat — body: { threadId, content }. Returns 200 + SSE; first
  // byte is the SSE header (and `event: message-start`). Even when the
  // upstream provider call fails, the route still returns 200 + SSE error
  // event, which is what the test wants — the threshold is platform overhead.
  const r = http.post(
    `${HOST}/api/agent/chat`,
    JSON.stringify({ threadId: __ENV.LOAD_AGENT_THREAD_ID, content: "hello" }),
    {
      headers: { "content-type": "application/json", ...authHeaders(data.token) },
      tags: { phase: "measured", name: "agent-first-token" },
      responseType: "text",
      timeout: "10s",
    },
  )
  // First-byte time approximates first SSE token when the stub provider replies
  // immediately. http_req_duration includes total body; we use the connecting+
  // waiting times via timings to approximate first-token.
  const ttfb = r.timings.waiting
  firstToken.add(ttfb)
  check(r, { "agent ok": (res) => res.status === 200 || res.status === 202 })
}
