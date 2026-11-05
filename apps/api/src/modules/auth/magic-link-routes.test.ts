// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import type { EmailMessage, EmailProvider } from "~/infra/email"
import {
  ConsoleEmailProvider,
  EmailProviderError,
  EmailRateLimitError,
  emailFailureOutage,
  getEmailProvider,
  ResendEmailProvider,
  setEmailProvider,
  setSystemEmailProvider,
} from "~/infra/email"
import { _clearEmailOutage, readEmailOutage } from "~/infra/email-outage"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const MAGIC_EMAIL = "magic@test.com"
const JSON_HEADERS = { "Content-Type": "application/json" }

function post(path: string, body: unknown, host?: string) {
  return app.request(host ? `http://${host}${path}` : path, {
    method: "POST",
    headers: host ? { ...JSON_HEADERS, host } : JSON_HEADERS,
    body: JSON.stringify(body),
  })
}

/** Pull the emailed 6-digit code out of a captured sign-in email. */
function extractCode(email: EmailMessage): string {
  const source = email.text ?? email.html
  const m = source.match(/\b(\d{6})\b/)
  if (!m) throw new Error(`no 6-digit code in email: ${source.slice(0, 200)}`)
  return m[1]
}

/** Pull the magic-link token out of the captured email URL. */
function extractLinkToken(email: EmailMessage): string {
  const source = email.text ?? email.html
  const m = source.match(/token=([A-Za-z0-9_-]+)/)
  if (!m) throw new Error("no link token in email")
  return m[1]
}

/** Request a magic link and return { challengeId, code, token } for the account. */
async function requestChallenge(email = MAGIC_EMAIL, host?: string) {
  const prev: EmailProvider = getEmailProvider()
  const capture = new ConsoleEmailProvider()
  setEmailProvider(capture)
  try {
    // With org hosts the request is made on the org's host (lib/org-host.ts).
    const res = await post("/api/auth/magic-link/request", { email }, host)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { challengeId: string } }
    const sent = capture.sent.at(-1)
    return {
      challengeId: data.challengeId,
      sent,
      code: sent ? extractCode(sent) : null,
      token: sent ? extractLinkToken(sent) : null,
    }
  } finally {
    setEmailProvider(prev)
  }
}

describe("passwordless magic-link login", () => {
  beforeAll(async () => {
    await acquireTestLock()
    // Passwordless bootstrap — no password supplied. This also asserts the
    // primary registration path works without a password.
    const res = await post("/api/auth/register", { email: MAGIC_EMAIL, name: "Magic Admin" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { accessToken: string } }
    expect(body.data.accessToken).toBeDefined()
  })

  beforeEach(async () => {
    // Through the prefix-aware helper: under a namespaced test run a bare
    // `redis.keys("bruteforce:*")` matches nothing, and this file then spends
    // one 5-attempt per-email brute-force budget across all seven challenge
    // requests, so the last two answer 429 instead of logging in.
    await clearRedisPatterns(["magic:*", "magic-rate:*", "magic-verify-rate:*", "bruteforce:*"])
    // Ensure the account is not mid-TOTP from the last test.
    await sql`UPDATE kernel.users SET totp_enabled = false WHERE email = ${MAGIC_EMAIL}`
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("request always returns 200 + challengeId (no enumeration)", async () => {
    const res = await post("/api/auth/magic-link/request", { email: "nobody@test.com" })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { challengeId: string } }
    expect(typeof data.challengeId).toBe("string")
    expect(data.challengeId.length).toBeGreaterThan(0)
  })

  it("does not send an email for an unknown address", async () => {
    const prev = getEmailProvider()
    const capture = new ConsoleEmailProvider()
    setEmailProvider(capture)
    try {
      await post("/api/auth/magic-link/request", { email: "nobody@test.com" })
      expect(capture.sent.length).toBe(0)
    } finally {
      setEmailProvider(prev)
    }
  })

  it("sends a Liaison-branded email with a 6-digit code and a magic link", async () => {
    const { sent } = await requestChallenge()
    expect(sent).toBeDefined()
    if (!sent) throw new Error("no email captured")
    expect(sent.to).toBe(MAGIC_EMAIL)
    expect(sent.html).toStartWith("<!doctype html>")
    expect(sent.html).toContain(">Liaison<")
    // 6-digit code present in both parts.
    expect(sent.text ?? "").toMatch(/\b\d{6}\b/)
    // Magic link points at the frontend verify page with challengeId + token.
    expect(sent.html).toContain("/login/magic?challengeId=")
    expect(sent.html).toContain("token=")
  })

  it("the magic link is on the org's host with org hosts, and BASE_URL's link without", async () => {
    const [org] = await sql<{ slug: string }[]>`
      SELECT o.slug FROM kernel.organizations o JOIN kernel.users u ON u.org_id = o.id
      WHERE u.email = ${MAGIC_EMAIL}`
    const saved = env.LIAISON_ORG_HOST_TEMPLATE
    try {
      env.LIAISON_ORG_HOST_TEMPLATE = undefined
      const off = await requestChallenge()
      expect(off.sent?.text ?? "").toContain(
        `${env.BASE_URL}/login/magic?challengeId=${encodeURIComponent(off.challengeId)}&token=${off.token}`,
      )

      env.LIAISON_ORG_HOST_TEMPLATE = "https://{slug}.example.com"
      const on = await requestChallenge(MAGIC_EMAIL, `${org.slug}.example.com`)
      expect(on.sent?.text ?? "").toContain(
        `https://${org.slug}.example.com/login/magic?challengeId=${encodeURIComponent(on.challengeId)}&token=${on.token}`,
      )
    } finally {
      env.LIAISON_ORG_HOST_TEMPLATE = saved
    }
  })

  it("logs in with the 6-digit code", async () => {
    const { challengeId, code } = await requestChallenge()
    const res = await post("/api/auth/magic-link/verify", { challengeId, code })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { accessToken: string } }
    expect(body.data.accessToken).toBeDefined()
  })

  it("logs in with the magic-link token", async () => {
    const { challengeId, token } = await requestChallenge()
    const res = await post("/api/auth/magic-link/verify", { challengeId, token })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { accessToken: string } }
    expect(body.data.accessToken).toBeDefined()
  })

  it("rejects a wrong code but keeps the challenge alive for retries", async () => {
    const { challengeId, code } = await requestChallenge()
    const wrong = code === "000000" ? "111111" : "000000"

    const bad = await post("/api/auth/magic-link/verify", { challengeId, code: wrong })
    expect(bad.status).toBe(401)

    // The correct code still works after a single wrong guess.
    const ok = await post("/api/auth/magic-link/verify", { challengeId, code })
    expect(ok.status).toBe(200)
  })

  it("locks out and burns the challenge after 5 wrong codes", async () => {
    const { challengeId, code } = await requestChallenge()
    const wrong = code === "000000" ? "111111" : "000000"

    for (let i = 0; i < 5; i++) {
      const r = await post("/api/auth/magic-link/verify", { challengeId, code: wrong })
      expect(r.status).toBe(401)
    }
    // 6th attempt trips the cap.
    const capped = await post("/api/auth/magic-link/verify", { challengeId, code: wrong })
    expect(capped.status).toBe(429)

    // Challenge is burned — even the correct code no longer works.
    const dead = await post("/api/auth/magic-link/verify", { challengeId, code })
    expect(dead.status).toBe(401)
  })

  it("rejects an unknown/expired challenge", async () => {
    const res = await post("/api/auth/magic-link/verify", {
      challengeId: "totally-made-up-challenge-id",
      code: "123456",
    })
    expect(res.status).toBe(401)
  })

  it("consumes the challenge on success (single use)", async () => {
    const { challengeId, code } = await requestChallenge()
    const first = await post("/api/auth/magic-link/verify", { challengeId, code })
    expect(first.status).toBe(200)
    const second = await post("/api/auth/magic-link/verify", { challengeId, code })
    expect(second.status).toBe(401)
  })

  it("hands off to TOTP when the account has 2FA enabled", async () => {
    await sql`UPDATE kernel.users SET totp_enabled = true WHERE email = ${MAGIC_EMAIL}`
    const { challengeId, code } = await requestChallenge()
    const res = await post("/api/auth/magic-link/verify", { challengeId, code })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { totpRequired?: boolean; challengeToken?: string; accessToken?: string }
    }
    expect(body.data.totpRequired).toBe(true)
    expect(typeof body.data.challengeToken).toBe("string")
    expect(body.data.accessToken).toBeUndefined()
  })

  // A demo box refuses every outbound mail for the whole instance, so a sign-in
  // code requested there can never arrive. The request used to answer 200 and
  // issue a challenge anyway, and the phone sat on "enter the 6-digit code".
  // It must say so instead, with ONE instance-wide answer: the same status and
  // body for an account that exists and for one that does not.
  //
  // Mutation that proves it bites: delete the demo check at the top of the
  // `/magic-link/request` route and both requests answer 200, a challenge is
  // stored for the real account, and every assertion below fails.
  it("answers an instance-wide 'no email here' refusal, identical for any address, and issues nothing", async () => {
    DemoModeTestAccess.set(true)
    try {
      const known = await post("/api/auth/magic-link/request", { email: MAGIC_EMAIL })
      const unknown = await post("/api/auth/magic-link/request", { email: "nobody@test.com" })

      expect(known.status).toBe(403)
      expect(unknown.status).toBe(403)
      const knownBody = (await known.json()) as { error: { code: string; message: string } }
      const unknownBody = (await unknown.json()) as { error: { code: string; message: string } }
      expect(knownBody.error.code).toBe("EMAIL_SIGN_IN_UNAVAILABLE")
      expect(knownBody.error.message).toContain("password")
      // Anti-enumeration: the refusal is about the instance, never the account.
      expect(unknownBody).toEqual(knownBody)

      const [{ id }] = await sql`SELECT id FROM kernel.users WHERE email = ${MAGIC_EMAIL}`
      expect(await redis.get(`magic:user:${id}`)).toBeNull()
    } finally {
      DemoModeTestAccess.set(null)
    }
  })

  // The mail provider refuses (daily quota, seen live): the page must not say a code was sent, and
  // the answer must stay the same for any address. A send is only attempted for a known address, so
  // nothing about the outage may depend on which address asks.
  describe("POST /api/auth/magic-link/request while the mail provider refuses", () => {
    const quota = () =>
      new Response(JSON.stringify({ name: "daily_quota_exceeded", message: "quota" }), {
        status: 429,
      })
    let calls = 0
    let answer: () => Response = quota
    const provider = new ResendEmailProvider({
      apiKey: "re_test",
      from: "no-reply@test.com",
      fetch: async () => {
        calls += 1
        return answer()
      },
    })
    const request = (email: string) => post("/api/auth/magic-link/request", { email })
    const body = async (res: Response) =>
      (await res.json()) as { error?: { code: string; message: string } }
    const refused = async (res: Response) => {
      expect(res.status).toBe(403)
      return (await body(res)).error
    }

    beforeAll(async () => {
      await sql`INSERT INTO kernel.users (org_id, email, name, status)
        SELECT org_id, ${"outage@test.com"}, 'Outage', 'active' FROM kernel.users WHERE email = ${MAGIC_EMAIL}
        ON CONFLICT DO NOTHING`
    })
    beforeEach(async () => {
      await clearRedisPatterns(["magic:*", "magic-rate:*", "bruteforce:*"])
      await _clearEmailOutage()
      calls = 0
      answer = quota
      setSystemEmailProvider(provider)
    })
    afterAll(async () => {
      setSystemEmailProvider(null)
      await _clearEmailOutage()
    })

    it("the request whose send is refused is told the truth; afterwards any address gets the same answer, nothing sent", async () => {
      const first = await refused(await request("outage@test.com"))
      expect(first?.code).toBe("EMAIL_PROVIDER_UNAVAILABLE")
      expect(calls).toBe(1)
      expect((await readEmailOutage())?.kind).toBe("quota")
      await clearRedisPatterns(["magic:*", "magic-rate:*", "bruteforce:*"])
      const known = await refused(await request("outage@test.com"))
      const unknown = await refused(await request("nobody-here@test.com"))
      expect(unknown).toEqual(known)
      expect(known).toEqual(first)
      expect(calls).toBe(1)
    })

    it("/diag says so, for the operator's alert", async () => {
      await refused(await request("outage@test.com"))
      const diag = await app.request("/diag", {
        headers: { authorization: `Bearer ${env.MONITOR_TOKEN}` },
      })
      expect(diag.status).toBe(200)
      expect(((await diag.json()) as { systemEmail: unknown }).systemEmail).toMatchObject({
        outage: { kind: "quota", detail: "daily_quota_exceeded" },
      })
    })

    it("an unknown address alone starts nothing and is told what it is always told", async () => {
      const res = await request("nobody-here@test.com")
      expect(res.status).toBe(200)
      expect(await readEmailOutage()).toBeNull()
      expect(calls).toBe(0)
    })

    it("a probe per minute: refused again stays down for everybody, an accepted send ends it for everybody", async () => {
      await refused(await request("outage@test.com"))
      await clearRedisPatterns(["magic:*", "magic-rate:*", "bruteforce:*"])
      await redis.del("system-email:outage-probe")
      await refused(await request("outage@test.com"))
      expect(calls).toBe(2)
      // An unknown address as the probe: nothing is sent, nothing changes, the same answer.
      await redis.del("system-email:outage-probe")
      await refused(await request("nobody-here@test.com"))
      expect(calls).toBe(2)
      answer = () => new Response(JSON.stringify({ id: "m1" }), { status: 200 })
      await redis.del("system-email:outage-probe")
      await clearRedisPatterns(["magic:*", "magic-rate:*", "bruteforce:*"])
      expect((await request("outage@test.com")).status).toBe(200)
      expect(await readEmailOutage()).toBeNull()
      expect((await request("nobody-here@test.com")).status).toBe(200)
    })

    it("one address refused by the provider says nothing about the provider", async () => {
      answer = () =>
        new Response(JSON.stringify({ name: "validation_error", message: "bad to" }), {
          status: 422,
        })
      expect((await request("outage@test.com")).status).toBe(200)
      expect(await readEmailOutage()).toBeNull()
    })

    it("a sending-rate 429 is a moment, not an outage", async () => {
      answer = () =>
        new Response(JSON.stringify({ name: "rate_limit_exceeded", message: "slow" }), {
          status: 429,
          headers: { "Retry-After": "1" },
        })
      expect((await request("outage@test.com")).status).toBe(200)
      expect(await readEmailOutage()).toBeNull()
    })

    it("password reset says the same, for any address", async () => {
      await refused(await request("outage@test.com"))
      const known = await post("/api/auth/password-reset/request", { email: "outage@test.com" })
      const unknown = await post("/api/auth/password-reset/request", {
        email: "nobody-here@test.com",
      })
      expect((await refused(known))?.code).toBe("EMAIL_PROVIDER_UNAVAILABLE")
      expect((await refused(unknown))?.code).toBe("EMAIL_PROVIDER_UNAVAILABLE")
    })
  })
})

describe("what counts as the provider refusing", () => {
  const smtp = (over: Record<string, unknown>) => Object.assign(new Error("smtp"), over)
  it.each([
    [new EmailRateLimitError(1000, "daily_quota_exceeded"), "quota"],
    [new EmailRateLimitError(1000, "monthly_quota_exceeded"), "quota"],
    [new EmailRateLimitError(1000), null],
    [new EmailProviderError("Resend network error: x"), "unreachable"],
    [new EmailProviderError("Resend 500: x", 500), "unreachable"],
    [new EmailProviderError('Resend 403: {"name":"invalid_api_key"}', 403), "credentials"],
    [
      new EmailProviderError('Resend 403: {"name":"validation_error","message":"domain"}', 403),
      null,
    ],
    [new EmailProviderError("Resend 422: x", 422), null],
    [smtp({ code: "EAUTH", responseCode: 535 }), "credentials"],
    [smtp({ code: "ECONNECTION" }), "unreachable"],
    [smtp({ code: "ETIMEDOUT" }), "unreachable"],
    [smtp({ code: "EDNS" }), "unreachable"],
    [smtp({ code: "EENVELOPE", responseCode: 550, response: "550 no such user" }), null],
    [
      smtp({
        code: "EMESSAGE",
        responseCode: 550,
        response: "550 5.4.5 Daily user sending limit exceeded",
      }),
      "quota",
    ],
    [
      smtp({
        code: "EENVELOPE",
        responseCode: 452,
        response: "452 4.3.1 Insufficient system storage",
      }),
      "unreachable",
    ],
    [smtp({ code: "EENVELOPE", responseCode: 421, response: "421 try later" }), "unreachable"],
    [new Error("anything else"), null],
  ] as const)("%#", (err, kind) => {
    expect(emailFailureOutage(err)?.kind ?? null).toBe(kind)
  })
})
