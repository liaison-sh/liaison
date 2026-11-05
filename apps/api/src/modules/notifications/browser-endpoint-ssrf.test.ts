// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A browser push endpoint is user-supplied and the server POSTs to it, so
// registration only accepts a public https URL (the send path re-checks and
// pins DNS: modules/push/web-push.test.ts).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("browser push endpoint registration refuses internal targets", () => {
  let session: minimal.Session
  beforeAll(async () => {
    await acquireTestLock()
    session = await minimal.session((await createTestOrg()).id)
  }, 120_000)
  afterAll(releaseTestLock)

  const register = (endpoint: string) =>
    app.request("/api/notifications/browser-subscriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: `web-${crypto.randomUUID()}`,
        subscription: { endpoint, keys: { p256dh: "p", auth: "a" } },
      }),
    })

  for (const endpoint of [
    "http://push.example/abc",
    "https://127.0.0.1/abc",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/abc",
    "https://[::1]/abc",
    "https://[64:ff9b::a00:1]/abc",
    "file:///etc/passwd",
  ]) {
    it(`rejects ${endpoint}`, async () => {
      expect((await register(endpoint)).status).toBe(400)
    })
  }

  it("accepts a public https push service URL", async () => {
    expect((await register(`https://push.example/${crypto.randomUUID()}`)).status).toBe(201)
  })
})
