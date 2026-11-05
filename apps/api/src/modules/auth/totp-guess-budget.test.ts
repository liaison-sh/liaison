// SPDX-License-Identifier: FSL-1.1-ALv2
// The second factor's wrong-code counter is per user, but it blocks at 5 only
// when the same source address also failed 3 times; from rotating addresses it
// blocks at 10, and its window is a fixed hour. So a holder of the first factor
// gets 10 TOTP guesses every hour, 240 a day. This drives two such windows
// through the real route (the window's expiry is simulated by expiring the
// counter, exactly what its TTL does) and counts the wrong codes checked.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { encryptionKey } from "~/lib/env"
import { redis } from "~/lib/redis"
import { issueToken } from "~/lib/token-store"
import { generateTotpSecret } from "~/modules/auth/totp"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

let userId = ""

beforeAll(async () => {
  await acquireTestLock()
  await clearRedisPatterns(["bruteforce:*", "challenge:*", "totp:*"])
  const u = await minimal.person((await createTestOrg()).id)
  userId = u.id
  await withSystemDb("totp-budget-enable", (db) =>
    db
      .update(users)
      .set({
        totpEnabled: true,
        totpSecret: encryptSecret(generateTotpSecret(), encryptionKey, CryptoContext.totpSecret),
      })
      .where(eq(users.id, userId)),
  )
})

afterAll(async () => {
  await clearRedisPatterns(["bruteforce:*", "challenge:*", "totp:*"])
  await releaseTestLock()
})

async function windowOfGuesses(windowIndex: number): Promise<number> {
  // A fresh first-factor pass: the challenge a password or magic link hands back.
  const challengeToken = await issueToken(redis, "challenge", { userId }, 300)
  let checked = 0
  for (let i = 0; i < 20; i++) {
    const res = await app.request("/api/auth/totp/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bun-socket-ip": `203.0.113.${windowIndex * 40 + i + 1}`,
      },
      // Six digits that are almost surely not the live code; a hit only
      // makes the test pass early, never fail.
      body: JSON.stringify({ challengeToken, code: String(100000 + windowIndex * 1000 + i) }),
    })
    if (res.status === 401) checked += 1
    if (res.status === 429) break
  }
  return checked
}

describe("TOTP code guessing is bounded per account over a day, not only per hour", () => {
  it("two hourly windows from rotating peers do not add up to more than a daily budget", async () => {
    const first = await windowOfGuesses(0)
    // The per-user counter's fixed one-hour TTL elapses (the brute-force key
    // `bruteforce:email:totp:<userId>`), as it would an hour later.
    await redis.del(`bruteforce:email:totp:${userId}`)
    const second = await windowOfGuesses(1)
    console.log(`totp windows: ${first} + ${second} wrong codes checked`)
    expect(first + second).toBeLessThanOrEqual(10)
  }, 60_000)
})
