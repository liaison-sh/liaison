// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S11d: the moments an operator or an org admin should hear about raise ONE
// structured security signal, through the real code paths that reach them: a
// guess ceiling on each sign-in factor (password, TOTP, step-up code and
// password, sign-in code), a brute-force lockout, and an MCP client
// registering. Each signal is counted on /diag, logged with `alert`, and, when
// it belongs to an org, becomes a system_alert in that org's admins' feed.
//
// The ceilings are reached by seeding each counter one short of its limit, then
// sending one real wrong answer: the signal must come from the answer that
// crosses, and only from that one.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret, hashPassword, hashToken } from "~/lib/crypto"
import { encryptionKey, env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { issueToken } from "~/lib/token-store"
import { recordFailedAttempt } from "~/middleware/brute-force"
import { processTranslationEvent } from "~/modules/attention/translator"
import { requestMagicLink, verifyMagicLink } from "~/modules/auth/magic-link"
import {
  assertStepUp,
  STEP_UP_MAX_WRONG_CODES_PER_DAY,
  STEP_UP_MAX_WRONG_PASSWORDS,
  stepUpCodeKey,
  stepUpPasswordFailKey,
} from "~/modules/auth/step-up"
import { generateTotpSecret } from "~/modules/auth/totp"
import {
  emitSecurityEvent,
  getSecurityEventDiag,
  securityAppEvent,
  securityLogger,
} from "~/modules/security/security-events"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const REDIS_PATTERNS = ["bruteforce:*", "challenge:*", "totp:*", "magic:*", "stepup:*", "step-up:*"]

let admin: minimal.Person
let member: minimal.Person

function count(key: string): number {
  return getSecurityEventDiag()[key]?.count ?? 0
}

/** The outbox rows this org got for security signals, newest first. */
async function securityOutbox(orgId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM kernel.pending_events
    WHERE org_id = ${orgId} AND payload->>'entity' = 'security_event'
    ORDER BY seq DESC`
  return rows.map((r) => r.payload)
}

let peer = 0
function nextPeer(): string {
  peer += 1
  return `198.18.${Math.floor(peer / 250)}.${(peer % 250) + 1}`
}

beforeAll(async () => {
  await acquireTestLock()
  await clearRedisPatterns(REDIS_PATTERNS)
  admin = await minimal.orgAdmin((await createTestOrg()).id)
  member = await minimal.person(admin.orgId)
})

afterEach(async () => {
  await clearRedisPatterns(REDIS_PATTERNS)
})

afterAll(async () => {
  await sql`DELETE FROM kernel.attention_events WHERE org_id = ${admin.orgId}`
  await clearRedisPatterns(REDIS_PATTERNS)
  await releaseTestLock()
})

describe("emitSecurityEvent", () => {
  it("logs with an alert tag, counts on /diag, and queues an org event for the account's org", async () => {
    const warn = spyOn(securityLogger, "warn")
    try {
      const before = count("guess_ceiling:password")
      await emitSecurityEvent({ kind: "guess_ceiling", factor: "password", userId: member.id })
      expect(count("guess_ceiling:password")).toBe(before + 1)
      const line = warn.mock.calls.find(
        (call) => (call[0] as { securityEvent?: string }).securityEvent === "guess_ceiling",
      )
      expect(line?.[0]).toMatchObject({
        alert: "security_guess_ceiling",
        factor: "password",
        userId: member.id,
      })
    } finally {
      warn.mockRestore()
    }
    const [event] = await securityOutbox(admin.orgId)
    expect(event).toMatchObject({
      app: "kernel",
      entity: "security_event",
      action: "create",
      orgId: admin.orgId,
      data: { securityEvent: "guess_ceiling", factor: "password", subjectUserId: member.id },
    })
  })

  it("is served on /diag to the monitor", async () => {
    const prev = env.MONITOR_TOKEN
    ;(env as { MONITOR_TOKEN: string }).MONITOR_TOKEN = "monitor-secret-for-security-events"
    try {
      await emitSecurityEvent({ kind: "lockout", scope: "address", detail: { ip: "192.0.2.1" } })
      const res = await app.request("/diag", {
        headers: { authorization: "Bearer monitor-secret-for-security-events" },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        securityEvents: Record<string, { count: number; lastAt: string }>
      }
      expect(body.securityEvents["lockout:address"]?.count).toBeGreaterThan(0)
    } finally {
      ;(env as { MONITOR_TOKEN: string }).MONITOR_TOKEN = prev
    }
  })

  it("reaches the org's admins as a system alert, and not its other members", async () => {
    const event = securityAppEvent(
      { kind: "guess_ceiling", factor: "totp", userId: member.id, orgId: admin.orgId },
      "Member",
    )
    await processTranslationEvent(event)
    const rows = await sql<{ user_id: string; kind: string; summary: string }[]>`
      SELECT user_id, kind, summary FROM kernel.attention_events
      WHERE org_id = ${admin.orgId} AND entity_id = ${event.entityId as string}`
    expect(rows.map((r) => r.user_id)).toContain(admin.id)
    expect(rows.map((r) => r.user_id)).not.toContain(member.id)
    expect(rows[0]?.kind).toBe("system_alert")
    expect(rows[0]?.summary).toContain("two-factor")
  })

  it("throttles a repeating signal's org alert but counts every one (clamav_unavailable)", async () => {
    const before = count("clamav_unavailable")
    const rowsBefore = (await securityOutbox(admin.orgId)).filter(
      (e) => (e.data as { securityEvent?: string }).securityEvent === "clamav_unavailable",
    ).length
    for (let i = 0; i < 3; i++) {
      await emitSecurityEvent({
        kind: "clamav_unavailable",
        orgId: admin.orgId,
        orgAlertEveryMs: 60 * 60 * 1000,
        detail: { where: "tickets", reason: "connect ECONNREFUSED" },
      })
    }
    expect(count("clamav_unavailable")).toBe(before + 3)
    const rows = (await securityOutbox(admin.orgId)).filter(
      (e) => (e.data as { securityEvent?: string }).securityEvent === "clamav_unavailable",
    )
    expect(rows.length).toBe(rowsBefore + 1)
    expect((rows[0]?.data as { summary?: string } | undefined)?.summary ?? "").toContain(
      "virus scanner could not be reached",
    )
  })

  it("never throws into the request that raised it", async () => {
    await emitSecurityEvent({ kind: "guess_ceiling", factor: "totp", userId: "not-a-uuid" })
  })
})

describe("the sites that raise a security signal", () => {
  it("password: the wrong password that reaches the daily ceiling", async () => {
    await redis.set(`bruteforce:account:password:${member.email}`, "29", "EX", 3600)
    const before = count("guess_ceiling:password")
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bun-socket-ip": nextPeer() },
      body: JSON.stringify({ email: member.email, password: "definitely-wrong-1" }),
    })
    expect(res.status).toBe(401)
    expect(count("guess_ceiling:password")).toBe(before + 1)
    // The next refusal is past the ceiling, not a second crossing.
    await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bun-socket-ip": nextPeer() },
      body: JSON.stringify({ email: member.email, password: "definitely-wrong-2" }),
    })
    expect(count("guess_ceiling:password")).toBe(before + 1)
  })

  it("TOTP: the wrong code that reaches the daily ceiling", async () => {
    await withSystemDb("security-events-totp", (db) =>
      db
        .update(users)
        .set({
          totpEnabled: true,
          totpSecret: encryptSecret(generateTotpSecret(), encryptionKey, CryptoContext.totpSecret),
        })
        .where(eq(users.id, member.id)),
    )
    try {
      await redis.set(`bruteforce:account:totp:${member.id}`, "9", "EX", 3600)
      const challengeToken = await issueToken(redis, "challenge", { userId: member.id }, 300)
      const before = count("guess_ceiling:totp")
      const res = await app.request("/api/auth/totp/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-bun-socket-ip": nextPeer() },
        body: JSON.stringify({ challengeToken, code: "000001" }),
      })
      expect(res.status).toBe(401)
      expect(count("guess_ceiling:totp")).toBe(before + 1)
      expect((await securityOutbox(admin.orgId))[0]).toMatchObject({
        data: { securityEvent: "guess_ceiling", factor: "totp", subjectUserId: member.id },
      })
    } finally {
      await withSystemDb("security-events-totp-off", (db) =>
        db
          .update(users)
          .set({ totpEnabled: false, totpSecret: null })
          .where(eq(users.id, member.id)),
      )
    }
  })

  it("step-up: the wrong emailed code that reaches the daily ceiling", async () => {
    await redis.set(stepUpCodeKey(member.id), hashToken("123456"), "EX", 600)
    await redis.set(
      `bruteforce:account:step-up-code:${member.id}`,
      String(STEP_UP_MAX_WRONG_CODES_PER_DAY - 1),
      "EX",
      3600,
    )
    const before = count("guess_ceiling:step_up_code")
    await expect(assertStepUp(member.id, null, { stepUpCode: "654321" })).rejects.toThrow()
    expect(count("guess_ceiling:step_up_code")).toBe(before + 1)
  })

  it("step-up: the wrong password that reaches the window's ceiling", async () => {
    const hash = await hashPassword("the-right-password-1")
    await redis.set(
      stepUpPasswordFailKey(member.id),
      String(STEP_UP_MAX_WRONG_PASSWORDS - 1),
      "EX",
      600,
    )
    const before = count("guess_ceiling:step_up_password")
    await expect(
      assertStepUp(member.id, hash, { currentPassword: "a-wrong-password" }),
    ).rejects.toThrow()
    expect(count("guess_ceiling:step_up_password")).toBe(before + 1)
  })

  it("sign-in code: the wrong code that reaches the account's ceiling", async () => {
    const { challengeId } = await requestMagicLink(member.email, undefined)
    await redis.set(`magic:wrong:${member.id}`, "9", "EX", 3600)
    const before = count("guess_ceiling:sign_in_code")
    await expect(verifyMagicLink({ challengeId, code: "000000" })).rejects.toThrow()
    expect(count("guess_ceiling:sign_in_code")).toBe(before + 1)
  })

  it("lockout: the failure that reaches an identifier's or an address's block threshold", async () => {
    const identifier = `security-events-${crypto.randomUUID()}`
    const ip = nextPeer()
    const idBefore = count("lockout:identifier")
    const ipBefore = count("lockout:address")
    for (let i = 0; i < 5; i++) await recordFailedAttempt(redis, identifier, ip)
    expect(count("lockout:identifier")).toBe(idBefore + 1)
    for (let i = 0; i < 16; i++) await recordFailedAttempt(redis, `${identifier}-${i}`, ip)
    // 21 failures from the address: one crossing at 20, and the identifier
    // counters of the other keys never reached theirs.
    expect(count("lockout:address")).toBe(ipBefore + 1)
    expect(count("lockout:identifier")).toBe(idBefore + 1)
  })

  it("MCP: a client registering", async () => {
    const before = count("mcp_client_registered")
    const res = await app.request("/mcp/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bun-socket-ip": nextPeer() },
      body: JSON.stringify({
        client_name: "Security Events Test",
        redirect_uris: ["https://client.example.com/callback"],
      }),
    })
    expect(res.status).toBe(201)
    expect(count("mcp_client_registered")).toBe(before + 1)
  })
})
