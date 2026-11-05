// SPDX-License-Identifier: FSL-1.1-ALv2
// The per-account wrong-password counter is hourly and, from rotating source
// addresses, blocks at 10: a known address buys 10 password guesses every
// hour, 240 a day. A daily per-account budget bounds that whatever the source
// address. The hour boundary is simulated by expiring the hourly counter,
// exactly what its TTL does.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { redis } from "~/lib/redis"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

let email = ""

beforeAll(async () => {
  await acquireTestLock()
  await clearRedisPatterns(["bruteforce:*"])
  email = (await minimal.person((await createTestOrg()).id)).email.toLowerCase()
})

afterAll(async () => {
  await clearRedisPatterns(["bruteforce:*"])
  await releaseTestLock()
})

async function windowOfGuesses(windowIndex: number): Promise<number> {
  let checked = 0
  for (let i = 0; i < 20; i++) {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bun-socket-ip": `198.51.100.${windowIndex * 40 + i + 1}`,
      },
      body: JSON.stringify({ email, password: `not-the-password-${windowIndex}-${i}` }),
    })
    if (res.status === 401) checked += 1
    if (res.status === 429) break
  }
  return checked
}

describe("password guessing is bounded per account over a day, not only per hour", () => {
  it("hourly windows from rotating peers stop at the daily budget", async () => {
    let total = 0
    for (let w = 0; w < 4; w++) {
      total += await windowOfGuesses(w)
      await redis.del(`bruteforce:email:${email}`)
    }
    expect(total).toBeLessThanOrEqual(30)
  }, 120_000)
})
