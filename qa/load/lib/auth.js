// SPDX-License-Identifier: FSL-1.1-ALv2
// Shared k6 login helper. Issues a session and returns an access token.

import http from "k6/http"
import { check, fail } from "k6"

export function login(host, email, password) {
  const r = http.post(
    `${host}/api/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { "content-type": "application/json" } },
  )
  if (!check(r, { "login ok": (res) => res.status === 200 })) {
    fail(`login failed: ${r.status} ${r.body}`)
  }
  const body = JSON.parse(r.body)
  // Server may return { data: { accessToken } } or set cookie + return user only.
  const token = (body.data && body.data.accessToken) || body.accessToken
  if (!token) fail("login: no access token in response body")
  return token
}

export function authHeaders(token) {
  return { Authorization: `Bearer ${token}` }
}
