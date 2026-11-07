// SPDX-License-Identifier: FSL-1.1-ALv2
// An emailed step-up code (6 digits) guards factor changes, mailbox reset and
// account deletion for a session that already exists. Each code allows 5 wrong
// tries, a new code may be requested 10 times an hour, and each new code resets
// the wrong-try count: a stolen session buys 50 guesses an hour. This counts
// how many wrong step-up codes one account checks in an hour's burst.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { ResendEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { _clearEmailOutage } from "~/infra/email-outage"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

let s: minimal.Session

beforeAll(async () => {
  await acquireTestLock()
  await clearRedisPatterns(["totp-stepup-rate:*", "stepup:*", "step-up:*"])
  s = await minimal.session((await createTestOrg()).id)
})
afterAll(async () => {
  await clearRedisPatterns(["totp-stepup-rate:*", "stepup:*", "step-up:*"])
  await releaseTestLock()
})

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("a step-up refused because mail is off", () => {
  it("leaves no resend cooldown: after the outage the page gets a code, not a wait for one never sent", async () => {
    await clearRedisPatterns(["totp-stepup-rate:*", "totp-stepup-cooldown:*"])
    const purpose = "mcp_connect"
    const refusing = new ResendEmailProvider({
      apiKey: "re_test",
      from: "no-reply@test.com",
      fetch: async () =>
        new Response(JSON.stringify({ name: "daily_quota_exceeded", message: "quota" }), {
          status: 429,
        }),
    })
    let accepted = 0
    const accepting = new ResendEmailProvider({
      apiKey: "re_test",
      from: "no-reply@test.com",
      fetch: async () => {
        accepted += 1
        return new Response(JSON.stringify({ id: "m1" }), { status: 200 })
      },
    })
    try {
      setSystemEmailProvider(refusing)
      const refused = await post("/api/auth/totp/step-up", { purpose })
      expect(refused.status).toBe(403)
      setSystemEmailProvider(accepting)
      const next = await post("/api/auth/totp/step-up", { purpose })
      expect(next.status).toBe(200)
      expect(((await next.json()) as { data: { sent: boolean } }).data.sent).toBe(true)
      expect(accepted).toBe(1)
    } finally {
      setSystemEmailProvider(null)
      await _clearEmailOutage()
    }
  })
})

describe("step-up code guessing is bounded per account, not only per code", () => {
  it("an hour of fresh step-up codes does not buy dozens of guesses", async () => {
    let wrongChecked = 0
    for (let i = 0; i < 12; i++) {
      const req = await post("/api/auth/totp/step-up", {})
      if (req.status !== 200) break
      for (let g = 0; g < 5; g++) {
        const res = await post("/api/auth/totp/setup", { stepUpCode: String(100000 + i * 10 + g) })
        if (res.status === 422) wrongChecked += 1
      }
    }
    console.log(`step-up burst: ${wrongChecked} wrong codes checked`)
    expect(wrongChecked).toBeLessThanOrEqual(10)
  }, 60_000)
})
