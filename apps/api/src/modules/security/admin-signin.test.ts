// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An administrator signing in from an address not used in the last 90 days
// raises `admin_signin_new_ip`, through the real sign-in routes (password,
// sign-in code, the TOTP step): counted on /diag, queued for the org, and a
// system alert for the account and the org's other admins. A member's sign-in,
// a known address and an account's very first sign-in raise nothing. What is
// stored names no address.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import type { EmailProvider } from "~/infra/email"
import { ConsoleEmailProvider, getEmailProvider, setEmailProvider } from "~/infra/email"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { encryptionKey, env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { processTranslationEvent } from "~/modules/attention/translator"
import { generateCurrentCode, generateTotpSecret } from "~/modules/auth/totp"
import {
  SIGNIN_ADDRESS_RETENTION_SECONDS,
  signInAddressKey,
  signInHistoryKey,
  userAgentFamily,
} from "~/modules/security/admin-signin"
import { getSecurityEventDiag, securityAppEvent } from "~/modules/security/security-events"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const REDIS_PATTERNS = [
  "bruteforce:*",
  "challenge:*",
  "totp:*",
  "magic:*",
  "magic-rate:*",
  "magic-verify-rate:*",
  "signin:*",
]
const PASSWORD = "Passw0rd!"
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

let owner: minimal.Person
let admin: minimal.Person
let member: minimal.Person

function count(): number {
  return getSecurityEventDiag().admin_signin_new_ip?.count ?? 0
}

async function outbox(orgId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM kernel.pending_events
    WHERE org_id = ${orgId} AND payload->>'entity' = 'security_event'
      AND payload->'data'->>'securityEvent' = 'admin_signin_new_ip'
    ORDER BY seq DESC`
  return rows.map((r) => r.payload)
}

let peer = 0
function nextPeer(): string {
  peer += 1
  return `198.19.${Math.floor(peer / 250)}.${(peer % 250) + 1}`
}

async function passwordLogin(user: minimal.Person, ip: string): Promise<number> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bun-socket-ip": ip,
      "user-agent": CHROME_MAC,
    },
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
  })
  return res.status
}

beforeAll(async () => {
  await acquireTestLock()
  await clearRedisPatterns(REDIS_PATTERNS)
  owner = await minimal.orgAdmin((await createTestOrg()).id)
  admin = await minimal.person(owner.orgId, { role: "admin" })
  member = await minimal.person(owner.orgId)
})

afterEach(async () => {
  await clearRedisPatterns(REDIS_PATTERNS)
})

afterAll(async () => {
  await sql`DELETE FROM kernel.attention_events WHERE org_id = ${owner.orgId}`
  await clearRedisPatterns(REDIS_PATTERNS)
  await releaseTestLock()
})

describe("admin sign-in from a new address", () => {
  it("learns the first address silently, stays quiet on it, and signals a new one", async () => {
    const home = nextPeer()
    const before = count()
    expect(await passwordLogin(admin, home)).toBe(200)
    expect(await passwordLogin(admin, home)).toBe(200)
    expect(count()).toBe(before)

    const away = nextPeer()
    expect(await passwordLogin(admin, away)).toBe(200)
    expect(count()).toBe(before + 1)
    const [event] = await outbox(owner.orgId)
    expect(event).toMatchObject({
      orgId: owner.orgId,
      data: { securityEvent: "admin_signin_new_ip", subjectUserId: admin.id, method: "password" },
    })
    const summary = (event?.data as { summary?: string } | undefined)?.summary ?? ""
    expect(summary).toContain(away)
    expect(summary).toContain("Chrome on macOS")

    // Now known: no second signal from it.
    expect(await passwordLogin(admin, away)).toBe(200)
    expect(count()).toBe(before + 1)
  })

  it("stores a hash and a first-seen time with a 90-day expiry, never the address", async () => {
    const ip = nextPeer()
    expect(await passwordLogin(admin, ip)).toBe(200)
    for (const k of [signInAddressKey(admin.id, ip), signInHistoryKey(admin.id)]) {
      expect(k).not.toContain(ip)
      const v = (await redis.get(k)) ?? ""
      expect(v).not.toContain(ip)
      expect(Number.isNaN(Date.parse(v))).toBe(false)
      const ttl = await redis.ttl(k)
      expect(ttl).toBeGreaterThan(SIGNIN_ADDRESS_RETENTION_SECONDS - 60)
      expect(ttl).toBeLessThanOrEqual(SIGNIN_ADDRESS_RETENTION_SECONDS)
    }
  })

  it("trusts the resolved client address, not a forwarded header from a direct peer", async () => {
    const direct = nextPeer()
    expect(await passwordLogin(admin, direct)).toBe(200)
    const before = count()
    // A direct (untrusted) peer cannot pose as a new address by forging the header.
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bun-socket-ip": direct,
        "x-forwarded-for": "203.0.113.77",
      },
      body: JSON.stringify({ email: admin.email, password: PASSWORD }),
    })
    expect(res.status).toBe(200)
    expect(count()).toBe(before)
  })

  it("raises nothing for a member", async () => {
    expect(await passwordLogin(member, nextPeer())).toBe(200)
    const before = count()
    expect(await passwordLogin(member, nextPeer())).toBe(200)
    expect(count()).toBe(before)
    expect(await redis.exists(signInHistoryKey(member.id))).toBe(0)
  })

  it("signals on a sign-in code from a new address", async () => {
    expect(await passwordLogin(admin, nextPeer())).toBe(200)
    const before = count()
    const ip = nextPeer()
    const prev: EmailProvider = getEmailProvider()
    const capture = new ConsoleEmailProvider()
    setEmailProvider(capture)
    let challengeId: string
    try {
      const res = await app.request("/api/auth/magic-link/request", {
        method: "POST",
        headers: { "content-type": "application/json", "x-bun-socket-ip": ip },
        body: JSON.stringify({ email: admin.email }),
      })
      expect(res.status).toBe(200)
      challengeId = ((await res.json()) as { data: { challengeId: string } }).data.challengeId
    } finally {
      setEmailProvider(prev)
    }
    const sent = capture.sent.at(-1)
    const code = (sent?.text ?? sent?.html ?? "").match(/\b(\d{6})\b/)?.[1]
    expect(code).toBeDefined()
    const res = await app.request("/api/auth/magic-link/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bun-socket-ip": ip },
      body: JSON.stringify({ challengeId, code }),
    })
    expect(res.status).toBe(200)
    expect(count()).toBe(before + 1)
    expect((await outbox(owner.orgId))[0]).toMatchObject({ data: { method: "magic_link" } })
  })

  it("signals on the TOTP step that completes a sign-in from a new address", async () => {
    const secret = generateTotpSecret()
    await withSystemDb("admin-signin-totp-on", (db) =>
      db
        .update(users)
        .set({
          totpEnabled: true,
          totpSecret: encryptSecret(secret, encryptionKey, CryptoContext.totpSecret),
          totpLastUsedAt: null,
        })
        .where(eq(users.id, admin.id)),
    )
    try {
      const home = nextPeer()
      const away = nextPeer()
      // History first (a completed sign-in from home), then a fresh address.
      await redis.set(signInHistoryKey(admin.id), new Date().toISOString(), "EX", 3600)
      await redis.set(signInAddressKey(admin.id, home), new Date().toISOString(), "EX", 3600)
      const before = count()
      const first = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-bun-socket-ip": away },
        body: JSON.stringify({ email: admin.email, password: PASSWORD }),
      })
      const { data } = (await first.json()) as { data: { challengeToken: string } }
      // The password step alone is no sign-in.
      expect(count()).toBe(before)
      const res = await app.request("/api/auth/totp/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-bun-socket-ip": away },
        body: JSON.stringify({
          challengeToken: data.challengeToken,
          code: generateCurrentCode(secret),
        }),
      })
      expect(res.status).toBe(200)
      expect(count()).toBe(before + 1)
      expect((await outbox(owner.orgId))[0]).toMatchObject({ data: { method: "totp" } })
    } finally {
      await withSystemDb("admin-signin-totp-off", (db) =>
        db
          .update(users)
          .set({ totpEnabled: false, totpSecret: null })
          .where(eq(users.id, admin.id)),
      )
    }
  })

  it("is served on /diag under securityEvents.admin_signin_new_ip", async () => {
    const prev = env.MONITOR_TOKEN
    ;(env as { MONITOR_TOKEN: string }).MONITOR_TOKEN = "monitor-secret-admin-signin"
    try {
      expect(await passwordLogin(admin, nextPeer())).toBe(200)
      expect(await passwordLogin(admin, nextPeer())).toBe(200)
      const res = await app.request("/diag", {
        headers: { authorization: "Bearer monitor-secret-admin-signin" },
      })
      const body = (await res.json()) as {
        securityEvents: Record<string, { count: number; lastAt: string }>
      }
      expect(body.securityEvents.admin_signin_new_ip?.count).toBeGreaterThan(0)
    } finally {
      ;(env as { MONITOR_TOKEN: string }).MONITOR_TOKEN = prev
    }
  })

  it("alerts the account itself and the org's admins, and no other member", async () => {
    const event = securityAppEvent(
      {
        kind: "admin_signin_new_ip",
        userId: admin.id,
        orgId: owner.orgId,
        detail: { ip: "192.0.2.9", method: "password", client: "Firefox on Linux" },
      },
      "Test Admin",
    )
    await processTranslationEvent(event)
    const rows = await sql<{ user_id: string; kind: string; summary: string }[]>`
      SELECT user_id, kind, summary FROM kernel.attention_events
      WHERE org_id = ${owner.orgId} AND entity_id = ${event.entityId as string}`
    const ids = rows.map((r) => r.user_id)
    expect(ids).toContain(admin.id)
    expect(ids).toContain(owner.id)
    expect(ids).not.toContain(member.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(rows[0]?.kind).toBe("system_alert")
    expect(rows[0]?.summary).toContain("192.0.2.9")
  })

  it("names a coarse client family", () => {
    expect(userAgentFamily(CHROME_MAC)).toBe("Chrome on macOS")
    expect(
      userAgentFamily("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"),
    ).toBe("Firefox on Linux")
    expect(userAgentFamily(undefined)).toBe("unknown client")
  })
})
