// SPDX-License-Identifier: FSL-1.1-ALv2
// A6 — Thread list p95 < 200ms returning ~100 threads under sustained load.

import http from "k6/http"
import { check } from "k6"
import { login, authHeaders } from "./lib/auth.js"

const HOST = __ENV.HOST || "http://localhost:3000"
const EMAIL = __ENV.LOAD_EMAIL || "load@qa.local"
const PASSWORD = __ENV.LOAD_PASSWORD || "QaPass1!"

export const options = {
  scenarios: {
    warmup: { executor: "constant-vus", vus: 10, duration: "60s", gracefulStop: "5s" },
    measured: {
      executor: "constant-vus",
      vus: 50,
      duration: "5m",
      startTime: "65s",
      gracefulStop: "10s",
      tags: { phase: "measured" },
    },
  },
  thresholds: {
    "http_req_duration{phase:measured,name:thread-list}": ["p(95)<200"],
  },
}

export function setup() {
  return { token: login(HOST, EMAIL, PASSWORD) }
}

export default function (data) {
  const r = http.get(`${HOST}/api/threads?limit=100`, {
    headers: authHeaders(data.token),
    tags: { phase: "measured", name: "thread-list" },
  })
  check(r, { "threads 200": (res) => res.status === 200 })
}
