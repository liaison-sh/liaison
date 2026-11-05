// SPDX-License-Identifier: FSL-1.1-ALv2
// An emailed step-up code (6 digits) guards factor changes, mailbox reset and
// account deletion for a session that already exists. Each code allows 5 wrong
// tries, a new code may be requested 10 times an hour, and each new code resets
// the wrong-try count: a stolen session buys 50 guesses an hour. This counts
// how many wrong step-up codes one account checks in an hour's burst.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
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
