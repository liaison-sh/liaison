// SPDX-License-Identifier: FSL-1.1-ALv2
// The emailed sign-in code is 6 digits. Each challenge allows 5 wrong guesses,
// but anyone can request a new challenge for a known address (the request
// answers the challenge id to the requester), so the guesses that matter are
// the ones an account accepts per unit of time ACROSS challenges. This drives
// the real routes from distinct socket peers, as a client rotating addresses
// would, and counts how many wrong codes one account lets through in a burst.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import type { EmailMessage } from "~/infra/email"
import { ConsoleEmailProvider, getEmailProvider, setEmailProvider } from "~/infra/email"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

let email = ""
const capture = new ConsoleEmailProvider()
let previous: ReturnType<typeof getEmailProvider>

beforeAll(async () => {
  await acquireTestLock()
  await clearRedisPatterns(["magic:*", "magic-rate:*", "magic-verify-rate:*", "bruteforce:*"])
  const user = await minimal.person((await createTestOrg()).id)
  email = user.email
  previous = getEmailProvider()
  setEmailProvider(capture)
})

afterAll(async () => {
  setEmailProvider(previous)
  await clearRedisPatterns(["magic:*", "magic-rate:*", "magic-verify-rate:*", "bruteforce:*"])
  await releaseTestLock()
})

function post(path: string, body: unknown, peer: string) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bun-socket-ip": peer },
    body: JSON.stringify(body),
  })
}

function codeOf(m: EmailMessage | undefined): string | null {
  const s = m ? (m.text ?? m.html) : ""
  return s.match(/\b(\d{6})\b/)?.[1] ?? null
}

describe("magic-link code guessing is bounded per account, not only per challenge", () => {
  it("an hour's burst of challenges from rotating peers does not buy dozens of code guesses", async () => {
    let wrongGuessesChecked = 0
    let challenges = 0
    for (let i = 0; i < 20; i++) {
      const peer = `203.0.113.${10 + i}`
      const mailsBefore = capture.sent.length
      const req = await post("/api/auth/magic-link/request", { email }, peer)
      if (req.status !== 200) continue
      const { data } = (await req.json()) as { data: { challengeId: string } }
      // Only a challenge whose mail went out is a real one; the uniform answer
      // past a cap carries an id that matches nothing.
      if (capture.sent.length === mailsBefore) continue
      const real = codeOf(capture.sent.at(-1))
      if (!real) continue
      challenges += 1
      for (let g = 0; g < 5; g++) {
        let guess = String((Number(real) + 1 + g) % 1_000_000).padStart(6, "0")
        if (guess === real) guess = "000000"
        const v = await post(
          "/api/auth/magic-link/verify",
          { challengeId: data.challengeId, code: guess },
          `198.51.100.${10 + i}`,
        )
        if (v.status === 401) wrongGuessesChecked += 1
        // A 429 burns the challenge; later guesses on it check nothing.
        if (v.status === 429) break
      }
    }
    console.log(
      `magic-link burst: ${challenges} challenges, ${wrongGuessesChecked} wrong codes checked`,
    )
    // A per-account ceiling on wrong codes (across challenges) keeps a burst to
    // a handful of guesses. At the audit SHA the burst gets 10 challenges x 5.
    expect(wrongGuessesChecked).toBeLessThanOrEqual(10)
  }, 120_000)

  it("past the account budget the code is refused even when right, and the emailed link still signs in", async () => {
    // A new hour for the issue cap and the address throttles; the account's
    // wrong-code budget from the burst above is still spent.
    await clearRedisPatterns([
      "magic:issued:*",
      "magic-rate:*",
      "magic-verify-rate:*",
      "bruteforce:*",
    ])
    const req = await post("/api/auth/magic-link/request", { email }, "203.0.113.200")
    expect(req.status).toBe(200)
    const { data } = (await req.json()) as { data: { challengeId: string } }
    const real = codeOf(capture.sent.at(-1))
    expect(real).not.toBeNull()
    const byCode = await post(
      "/api/auth/magic-link/verify",
      { challengeId: data.challengeId, code: real },
      "198.51.100.200",
    )
    expect(byCode.status).toBe(429)

    await clearRedisPatterns(["magic:issued:*"])
    const again = await post("/api/auth/magic-link/request", { email }, "203.0.113.201")
    const { data: d2 } = (await again.json()) as { data: { challengeId: string } }
    const mail = capture.sent.at(-1)
    const token = (mail?.text ?? mail?.html ?? "").match(/[?&]token=([^&\s"']+)/)?.[1]
    expect(token).toBeDefined()
    const byLink = await post(
      "/api/auth/magic-link/verify",
      { challengeId: d2.challengeId, token: decodeURIComponent(token as string) },
      "198.51.100.201",
    )
    expect(byLink.status).toBe(200)
  }, 60_000)

  it("an account gets at most a handful of challenges an hour, whatever the requesting address", async () => {
    await clearRedisPatterns(["magic:issued:*", "magic-rate:*", "bruteforce:*"])
    const before = capture.sent.length
    for (let i = 0; i < 9; i++) {
      await post("/api/auth/magic-link/request", { email }, `203.0.113.${100 + i}`)
    }
    expect(capture.sent.length - before).toBeLessThanOrEqual(5)
  }, 60_000)
})
