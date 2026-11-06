// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ON side of the gate: POST /api/demo/orgs actually run, THROUGH THE REAL
// GLOBAL MIDDLEWARE.
//
// The previous version of this file built a bare `new Hono()` and mounted the
// two demo lines on it, so nothing here covered the interaction with the body
// limit, the limiter ordering or the request timeout -- which is precisely how
// a route that did two minutes of work shipped under a thirty second timeout.
// This app is assembled from the middleware app.ts EXPORTS and uses in the same
// order, so the stack in front of the handler is the stack in production.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { Hono } from "hono"
import { type AppEnv, apiBodyLimitMiddleware, apiRequestTimeoutMiddleware, app } from "~/app"
import { sql } from "~/db"
import { capturedDemoMail, type EmailMessage, setDemoSystemMailProvider } from "~/infra/email"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import { resetOperatorOrgCache } from "~/modules/apps/operator-org"
import { pruneElapsedNetworkBudgets, rekeyPlainBudgetAddresses } from "~/modules/demo/demo-budget"
import {
  enableDemoDoorForTest,
  passingTurnstileToken,
  restoreDemoDoorEnv,
} from "~/modules/demo/demo-door.test-fixtures"
import {
  DEMO_LEAD_NOTICE_VERSION,
  DEMO_LEAD_RETENTION_DAYS,
  eraseExpiredDemoIdentities,
  optOutDemoLead,
  purgeStaleDemoLeads,
} from "~/modules/demo/demo-leads"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker } from "~/modules/demo/demo-org"
import { DEMO_COMPANY_NAME, DemoSeederTestAccess, setDemoSeeder } from "~/modules/demo/demo-seeder"
import { demoBudgetEmailKey } from "~/modules/demo/demo-verification"
import {
  DEMO_INTERNAL_LOGIN_DOMAIN,
  demoOrgSlug,
  demoSignupAnswer,
  mountDemoRoutes,
  useDemoRateLimit,
} from "~/modules/demo/routes"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

// app.ts's own order: body limit, demo limiter, (global limiter, off in test),
// request timeout, error handler, then the routes.
const demoApp = new Hono<AppEnv>()
demoApp.use("/api/*", apiBodyLimitMiddleware)
useDemoRateLimit(demoApp, redis)
demoApp.use("/api/*", apiRequestTimeoutMiddleware)
demoApp.onError(errorHandler)
mountDemoRoutes(demoApp)

let peer = 0
/** A fresh SOCKET PEER per call, so one test never spends another's budget. */
function nextPeer(): string {
  peer += 1
  return `198.51.100.${peer % 250}`
}

interface SignupOptions {
  /** A client-supplied X-Forwarded-For, i.e. the header an attacker controls. */
  spoofedForwardedFor?: string
}

function signup(body: unknown, socketPeer: string, opts: SignupOptions = {}) {
  // Every Start carries needs and a Turnstile token; a test that is about
  // something else gets passing ones.
  if (body && typeof body === "object" && !Array.isArray(body)) {
    body = { needs: ["support"], turnstileToken: passingTurnstileToken(), ...body }
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-bun-socket-ip": socketPeer,
  }
  if (opts.spoofedForwardedFor) headers["X-Forwarded-For"] = opts.spoofedForwardedFor
  return demoApp.request("/api/demo/orgs", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

/** What the web client sends: a random key it keeps until the signup answers. */
function newSignupKey(): string {
  return randomBytes(24).toString("base64url")
}

interface SignupBody {
  orgId: string
  orgSlug: string
  userId: string
  state: string
  statusUrl: string
  expiresAt: string
  accessToken: string
  needs: string[]
}

async function readSignup(response: Response): Promise<SignupBody> {
  const body = (await response.json()) as { data: SignupBody }
  return body.data
}

/** What the last stub seed run was asked for. The route's own contract. */
let lastSeedRequest: { orgName: string; owner?: { email: string; name: string } } | null = null

/** Stand-in for seed/tiers/demo/seed-org.ts: adopts the org, seeds nothing. */
function stubSeeder() {
  setDemoSeeder(async ({ orgSlug, orgName, locale, owner }) => {
    lastSeedRequest = { orgName, owner }
    const { orgId } = await ensureOrg({
      slug: orgSlug,
      name: orgName,
      locale,
      // What the real seeder passes, and what must never reach a demo org.
      credits: { currency: "EUR", initial: "25.00000000" },
    })
    return { ok: true, orgId }
  })
}

/** Wait for the background seed to reach a terminal state. */
async function waitForSeed(orgId: string, socketPeer: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const response = await demoApp.request(`/api/demo/orgs/${orgId}/status`, {
      headers: { "x-bun-socket-ip": socketPeer },
    })
    const body = (await response.json()) as { data: { state: string } }
    if (body.data.state !== "provisioning") return body.data.state
    await new Promise((r) => setTimeout(r, 50))
  }
  return "provisioning"
}

describe("POST /api/demo/orgs", () => {
  beforeAll(async () => {
    await acquireTestLock()
    DemoModeTestAccess.set(true)
    enableDemoDoorForTest()
    stubSeeder()
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    restoreDemoDoorEnv()
    DemoSeederTestAccess.reset()
    await releaseTestLock()
  })

  afterEach(async () => {
    await clearRedisPatterns(["ratelimit:*", "bruteforce:*", "demo:*"])
    invalidateDemoMarker()
  })

  it("creates a marked org and returns a session that works, before the seed", async () => {
    const socketPeer = nextPeer()
    const response = await signup(
      { name: "Acme Supplies", email: "Visitor@Example.com" },
      socketPeer,
    )
    expect(response.status).toBe(201)
    const data = await readSignup(response)
    expect(data.orgSlug.startsWith("demo-acme-supplies-")).toBe(true)
    // The workspace is handed over WHILE it fills in, which is the whole shape.
    expect(data.state).toBe("provisioning")
    expect(data.statusUrl).toBe(`/api/demo/orgs/${data.orgId}/status`)

    // The marker is on the row, with the visitor variant and a real expiry —
    // and the returned expiry is the MARKER's, not a second `new Date()`.
    const [row] = await sql<{ demo: { variant: string; expiresAt: string } | null }[]>`
      SELECT settings->'demo' AS demo FROM kernel.organizations WHERE id = ${data.orgId}`
    expect(row.demo?.variant).toBe("visitor")
    expect(row.demo?.expiresAt).toBe(data.expiresAt)
    expect(Date.parse(data.expiresAt)).toBeGreaterThan(Date.now())

    // The caller is this org's admin, on a GENERATED login: the address they
    // typed is not an identity and never lands in kernel.users.
    const [user] = await sql<{ email: string; role: string }[]>`
      SELECT u.email, r.name AS role
      FROM kernel.users u
      JOIN kernel.user_roles ur ON ur.user_id = u.id
      JOIN kernel.roles r ON r.id = ur.role_id
      WHERE u.id = ${data.userId}`
    expect(user.email.endsWith(`@${DEMO_INTERNAL_LOGIN_DOMAIN}`)).toBe(true)
    expect(user.role).toBe("admin")
    const [typed] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM kernel.users WHERE email = 'visitor@example.com'`
    expect(Number(typed.count)).toBe(0)

    // The typed address is the LEAD, lowercased, with the notice it was shown.
    const leads = await sql<{ email: string; name: string; notice_version: string }[]>`
      SELECT email, name, notice_version FROM kernel.demo_leads WHERE demo_org_id = ${data.orgId}`
    expect([...leads]).toEqual([
      {
        email: "visitor@example.com",
        name: "Acme Supplies",
        notice_version: DEMO_LEAD_NOTICE_VERSION,
      },
    ])

    // Exactly one personal agent for the visitor (ensureUser makes it; the
    // route used to make a second one, @acmes-agent2) and the org's @base.
    const agentRows = await sql<{ kind: string; handle: string }[]>`
      SELECT kind, handle FROM kernel.agents WHERE org_id = ${data.orgId} ORDER BY kind`
    expect(agentRows.filter((a) => a.kind === "personal")).toEqual([
      { kind: "personal", handle: "@acmes-agent" },
    ])
    expect(agentRows.filter((a) => a.kind === "system").map((a) => a.handle)).toEqual(["@base"])

    // The WORKSPACE is the fictional company, not something the caller named:
    // `name` in the request body is the caller's own name, and the org is the
    // company they are being handed. The slug still carries their name so an
    // operator reading the org list recognises the row.
    const [org] = await sql<{ name: string; slug: string }[]>`
      SELECT name, slug FROM kernel.organizations WHERE id = ${data.orgId}`
    expect(org.name).toBe(DEMO_COMPANY_NAME)
    expect(org.slug).toBe(data.orgSlug)

    // The session is real: it authenticates against the REAL app, not this one.
    const me = await app.request("/api/users/me", {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    })
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { data: { id: string } }
    expect(meBody.data.id).toBe(data.userId)

    expect(await waitForSeed(data.orgId, socketPeer)).toBe("ready")

    // And the seeder was told who owns the workspace, so the seeded world is
    // attached to THIS caller rather than to a seeded persona. Without the
    // owner the founder persona takes the admin seat back and the visitor lands
    // in a company that is not theirs.
    expect(lastSeedRequest?.orgName).toBe(DEMO_COMPANY_NAME)
    expect(lastSeedRequest?.owner?.email).toBe(user.email)
    expect(lastSeedRequest?.owner?.name).toBe("Acme Supplies")
  })

  // BLOCKER 1. Without seeding behind the response this signup sits for the
  // whole seed and is cut off by apiRequestTimeoutMiddleware at
  // REQUEST_TIMEOUT_MS, handing the visitor a 504 over an org that was created
  // anyway. The seeder here never returns at all, so the only way to answer is
  // not to wait for it.
  it("answers immediately even when the seeder never returns", async () => {
    setDemoSeeder(() => new Promise(() => {}))
    try {
      const started = Date.now()
      const response = await signup({ name: "Slow Seed", email: "slow@example.com" }, nextPeer())
      const elapsed = Date.now() - started
      expect(response.status).toBe(201)
      expect(elapsed).toBeLessThan(env.REQUEST_TIMEOUT_MS / 2)
      const data = await readSignup(response)
      expect(data.state).toBe("provisioning")
      // And the workspace it handed over is complete enough to use.
      const me = await app.request("/api/users/me", {
        headers: { Authorization: `Bearer ${data.accessToken}` },
      })
      expect(me.status).toBe(200)
    } finally {
      stubSeeder()
    }
  })

  // SECURITY. Typing an existing visitor's address into "Start the demo" from a
  // fresh browser used to sign the caller straight into THAT visitor's org: the
  // adopt claim was keyed on the socket peer and the address, and behind a
  // proxy every visitor shares the peer. Every start is a new org now.
  it("creates a new org on every start, even with the same address and peer", async () => {
    const socketPeer = nextPeer()
    const body = { name: "Retrier", email: "retry@example.com" }
    const first = await signup(body, socketPeer)
    expect(first.status).toBe(201)
    const a = await readSignup(first)
    await waitForSeed(a.orgId, socketPeer)

    const second = await signup(body, socketPeer)
    expect(second.status).toBe(201)
    const b = await readSignup(second)
    expect(b.orgId).not.toBe(a.orgId)
    expect(b.userId).not.toBe(a.userId)

    // The second session cannot read the first workspace: its token is bound to
    // its own org, and the first org's users are not visible from it.
    const meB = await app.request("/api/users/me", {
      headers: { Authorization: `Bearer ${b.accessToken}` },
    })
    expect(((await meB.json()) as { data: { id: string } }).data.id).toBe(b.userId)
    const ownPreview = await app.request(`/api/users/${b.userId}/preview`, {
      headers: { Authorization: `Bearer ${b.accessToken}` },
    })
    expect(ownPreview.status).toBe(200)
    const otherPreview = await app.request(`/api/users/${a.userId}/preview`, {
      headers: { Authorization: `Bearer ${b.accessToken}` },
    })
    expect(otherPreview.status).not.toBe(200)

    // Two orgs, two leads (scoped to this run's orgs: the namespace database
    // outlives a run).
    const [count] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM kernel.organizations
      WHERE slug LIKE 'demo-retrier-%' AND id IN (${a.orgId}::uuid, ${b.orgId}::uuid)`
    expect(Number(count.count)).toBe(2)
    const [leads] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM kernel.demo_leads
      WHERE email = 'retry@example.com' AND demo_org_id IN (${a.orgId}::uuid, ${b.orgId}::uuid)`
    expect(Number(leads.count)).toBe(2)
  })

  // The address of a REAL account on this instance must not reach it, and must
  // not end up in a second org beside it (which would make that person's
  // email-only sign-in ambiguous and refuse it).
  it("never reaches or shadows a real account holding the typed address", async () => {
    const realOrg = await createTestOrg()
    const { userId: realUserId } = await ensureUser({
      orgId: realOrg.id,
      email: "real.person@example.com",
      name: "Real Person",
      password: "a-real-password-1",
      role: "admin",
    })
    const data = await readSignup(
      await signup({ name: "Impostor", email: "Real.Person@example.com" }, nextPeer()),
    )
    expect(data.orgId).not.toBe(realOrg.id)
    expect(data.userId).not.toBe(realUserId)
    const rows = await sql<{ org_id: string }[]>`
      SELECT org_id FROM kernel.users WHERE email = 'real.person@example.com'`
    expect(rows.map((r) => r.org_id)).toEqual([realOrg.id])
    // The real person still signs in by address alone.
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "real.person@example.com", password: "a-real-password-1" }),
    })
    expect(login.status).toBe(200)
  })

  it("does not let a different caller adopt a workspace by guessing the address", async () => {
    const body = { name: "Mine", email: "mine@example.com" }
    const mine = await readSignup(await signup(body, nextPeer()))
    const theirs = await readSignup(await signup(body, nextPeer()))
    expect(theirs.orgId).not.toBe(mine.orgId)
  })

  // A LOST RESPONSE. Seen live on the demo box: a signup whose synchronous half
  // outlived the client's 30 s timeout made an org, a lead and a session the
  // caller never received, and nothing else could ever sign anyone into that
  // org (verifying the address by link signs nobody in). The client now sends
  // a random signup key with Start and resends it on every retry, each with a
  // fresh Turnstile token; the key, never the address, brings the caller back.
  describe("a signup key", () => {
    async function orgCount(slugPrefix: string): Promise<number> {
      const [row] = await sql<{ count: string }[]>`
        SELECT count(*) AS count FROM kernel.organizations WHERE slug LIKE ${`${slugPrefix}%`}`
      return Number(row?.count ?? 0)
    }

    it("hands a retry the workspace its lost response held, with no second org or lead", async () => {
      const socketPeer = nextPeer()
      const signupKey = newSignupKey()
      const startedAt = new Date().toISOString()
      const body = { name: "Lost Reply", email: "lost@example.com", signupKey }
      const lost = await signup(body, socketPeer)
      expect(lost.status).toBe(201)
      const first = await readSignup(lost) // what the visitor never saw

      const retry = await signup(body, socketPeer)
      expect(retry.status).toBe(201)
      const again = await readSignup(retry)
      expect(again.orgId).toBe(first.orgId)
      expect(again.userId).toBe(first.userId)
      const me = await app.request("/api/users/me", {
        headers: { Authorization: `Bearer ${again.accessToken}` },
      })
      expect(((await me.json()) as { data: { id: string } }).data.id).toBe(first.userId)

      expect(await orgCount("demo-lost-reply-")).toBe(1)
      const [leads] = await sql<{ count: string }[]>`
        SELECT count(*) AS count FROM kernel.demo_leads
        WHERE email = 'lost@example.com' AND created_at >= ${startedAt}`
      expect(Number(leads?.count)).toBe(1)
      // The code went out once, with the first request.
      expect(capturedDemoMail().sent.filter((m) => m.to === "lost@example.com")).toHaveLength(1)
    })

    it("spends no signup budget on a retry, however many there are", async () => {
      const socketPeer = nextPeer()
      const signupKey = newSignupKey()
      const body = { name: "Patient", email: "patient@example.com", signupKey }
      const first = await readSignup(await signup(body, socketPeer))
      for (let i = 0; i < env.LIAISON_DEMO_SIGNUPS_PER_IP_PER_HOUR + 2; i++) {
        const retry = await signup(body, socketPeer)
        expect(retry.status).toBe(201)
        expect((await readSignup(retry)).orgId).toBe(first.orgId)
      }
      // The budget still has room for the starts it was meant for.
      expect((await signup({ name: "Next", email: "next@example.com" }, socketPeer)).status).toBe(
        201,
      )
    })

    it("still checks Turnstile on a retry first", async () => {
      const socketPeer = nextPeer()
      const signupKey = newSignupKey()
      const body = { name: "Bot Retry", email: "botretry@example.com", signupKey }
      await readSignup(await signup(body, socketPeer))
      const refused = await signup(
        { ...body, turnstileToken: passingTurnstileToken("demo_code") },
        socketPeer,
      )
      expect(refused.status).toBe(400)
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        "turnstile_failed",
      )
    })

    it("answers the first request's needs, ignoring a retry's", async () => {
      const socketPeer = nextPeer()
      const signupKey = newSignupKey()
      const body = { name: "Picky", email: "picky@example.com", signupKey }
      const first = await readSignup(await signup({ ...body, needs: ["support"] }, socketPeer))
      const again = await readSignup(await signup({ ...body, needs: ["sales"] }, socketPeer))
      expect(again.orgId).toBe(first.orgId)
      expect(again.needs).toEqual(["support"])
    })

    it("tells a retry that arrives while the first is still running to wait, never a second org", async () => {
      const socketPeer = nextPeer()
      const signupKey = newSignupKey()
      const body = { name: "Slow Box", email: "slow@example.com", signupKey }
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => {
        release = r
      })
      let entered: () => void = () => {}
      const inSend = new Promise<void>((r) => {
        entered = r
      })
      // The synchronous half held open at its last step, the code mail.
      setDemoSystemMailProvider({
        async send(message: EmailMessage) {
          entered()
          await gate
          await capturedDemoMail().send(message)
        },
        verify: async () => true,
      })
      try {
        const firstRequest = signup(body, socketPeer)
        await inSend
        const waiting = await signup(body, socketPeer)
        expect(waiting.status).toBe(202)
        expect(Number(waiting.headers.get("retry-after"))).toBeGreaterThan(0)
        const waitBody = (await waiting.json()) as { data: { state: string; accessToken?: string } }
        expect(waitBody.data.state).toBe("creating")
        expect(waitBody.data.accessToken).toBeUndefined()

        release()
        const first = await firstRequest
        expect(first.status).toBe(201)
        const made = await readSignup(first)
        const after = await signup(body, socketPeer)
        expect(after.status).toBe(201)
        expect((await readSignup(after)).orgId).toBe(made.orgId)
        expect(await orgCount("demo-slow-box-")).toBe(1)
      } finally {
        release()
        setDemoSystemMailProvider(undefined)
      }
    })

    it("answers a start that runs past its budget 'being prepared' (202) instead of holding it to a 504; the retry gets that workspace", async () => {
      const socketPeer = nextPeer()
      const signupKey = newSignupKey()
      const startedAt = new Date().toISOString()
      const body = { name: "Busy Box", email: "busybox@example.com", signupKey }
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => {
        release = r
      })
      // The start's own work held open at its last step, the code mail: a box
      // too busy to make the workspace inside the budget.
      setDemoSystemMailProvider({
        async send(message: EmailMessage) {
          await gate
          await capturedDemoMail().send(message)
        },
        verify: async () => true,
      })
      const budget = demoSignupAnswer.budgetMs
      demoSignupAnswer.budgetMs = 300
      try {
        const began = Date.now()
        const first = await signup(body, socketPeer)
        expect(Date.now() - began).toBeLessThan(5_000)
        expect(first.status).toBe(202)
        expect(Number(first.headers.get("retry-after"))).toBe(demoSignupAnswer.retryAfterSeconds)
        const waitBody = (await first.json()) as {
          data: { state: string; retryAfter?: number; accessToken?: string }
        }
        expect(waitBody.data.state).toBe("creating")
        expect(waitBody.data.retryAfter).toBe(demoSignupAnswer.retryAfterSeconds)
        expect(waitBody.data.accessToken).toBeUndefined()

        // Still being made: a retry is told to wait, and makes nothing.
        expect((await signup(body, socketPeer)).status).toBe(202)

        release()
        let made: Response | null = null
        for (let i = 0; i < 50 && !made; i++) {
          const retry = await signup(body, socketPeer)
          if (retry.status === 201) made = retry
          else {
            expect(retry.status).toBe(202)
            await new Promise((r) => setTimeout(r, 100))
          }
        }
        expect(made).not.toBeNull()
        const signedIn = await readSignup(made as Response)
        const me = await app.request("/api/users/me", {
          headers: { Authorization: `Bearer ${signedIn.accessToken}` },
        })
        expect(((await me.json()) as { data: { id: string } }).data.id).toBe(signedIn.userId)
        expect(await orgCount("demo-busy-box-")).toBe(1)
        const [leads] = await sql<{ count: string }[]>`
          SELECT count(*) AS count FROM kernel.demo_leads
          WHERE email = 'busybox@example.com' AND created_at >= ${startedAt}`
        expect(Number(leads?.count)).toBe(1)
        expect(capturedDemoMail().sent.filter((m) => m.to === "busybox@example.com")).toHaveLength(
          1,
        )
      } finally {
        demoSignupAnswer.budgetMs = budget
        release()
        setDemoSystemMailProvider(undefined)
      }
    })

    it("answers 409 once the workspace it made has expired or is no demo org any more", async () => {
      const socketPeer = nextPeer()
      const expiredKey = newSignupKey()
      const expiredBody = {
        name: "Timed Out",
        email: "timedout@example.com",
        signupKey: expiredKey,
      }
      const expired = await readSignup(await signup(expiredBody, socketPeer))
      await sql`
        UPDATE kernel.organizations
        SET settings = jsonb_set(settings, '{demo,expiresAt}', to_jsonb(${new Date(Date.now() - 60_000).toISOString()}::text))
        WHERE id = ${expired.orgId}`
      invalidateDemoMarker()
      const late = await signup(expiredBody, socketPeer)
      expect(late.status).toBe(409)
      expect(((await late.json()) as { data?: unknown }).data).toBeUndefined()

      const goneKey = newSignupKey()
      const goneBody = { name: "Gone Away", email: "gone@example.com", signupKey: goneKey }
      const gone = await readSignup(await signup(goneBody, socketPeer))
      await sql`UPDATE kernel.organizations SET settings = settings - 'demo' WHERE id = ${gone.orgId}`
      invalidateDemoMarker()
      expect((await signup(goneBody, socketPeer)).status).toBe(409)
    })

    it("resumes on the key alone: another key, no key or the address is a new org", async () => {
      const socketPeer = nextPeer()
      const body = { name: "Key Holder", email: "holder@example.com" }
      const a = await readSignup(await signup({ ...body, signupKey: newSignupKey() }, socketPeer))
      const b = await readSignup(await signup({ ...body, signupKey: newSignupKey() }, socketPeer))
      const c = await readSignup(await signup(body, nextPeer()))
      expect(new Set([a.orgId, b.orgId, c.orgId]).size).toBe(3)
      expect(await orgCount("demo-key-holder-")).toBeGreaterThanOrEqual(3)
    })

    it("binds the key to the start's network: the same key from elsewhere is a new start", async () => {
      const signupKey = newSignupKey()
      const body = { name: "Moved Away", email: "moved@example.com", signupKey }
      const home = await readSignup(await signup(body, "198.51.100.77"))
      const elsewhere = await signup(body, "203.0.113.77")
      expect(elsewhere.status).toBe(201)
      expect((await readSignup(elsewhere)).orgId).not.toBe(home.orgId)
    })

    it("stores only a hash of the key, under a TTL", async () => {
      const signupKey = newSignupKey()
      await readSignup(
        await signup({ name: "Hashed", email: "hashed@example.com", signupKey }, nextPeer()),
      )
      const prefix = redis.options.keyPrefix ?? ""
      const keys = (await redis.keys(`${prefix}demo:signup-key:*`)).map((k) =>
        k.slice(prefix.length),
      )
      expect(keys.length).toBeGreaterThan(0)
      for (const key of keys) {
        expect(key).not.toContain(signupKey)
        expect(await redis.get(key)).not.toContain(signupKey)
        expect(await redis.ttl(key)).toBeGreaterThan(0)
      }
    })

    it("refuses a signup key too short to be unguessable", async () => {
      const response = await signup(
        { name: "Short Key", email: "short@example.com", signupKey: "abc" },
        nextPeer(),
      )
      expect(response.status).toBe(400)
    })
  })

  // BLOCKER 1. A failed seed must leave a usable, emptier org, never a wedged
  // one, and the status route must reach a terminal state so a poller stops.
  it("leaves a usable org when the seed fails, and says so", async () => {
    setDemoSeeder(async () => {
      throw new Error("seeder exploded")
    })
    try {
      const socketPeer = nextPeer()
      const response = await signup({ name: "Unseeded", email: "u@example.com" }, socketPeer)
      expect(response.status).toBe(201)
      const data = await readSignup(response)
      const [row] = await sql<{ demo: { variant: string } | null }[]>`
        SELECT settings->'demo' AS demo FROM kernel.organizations WHERE id = ${data.orgId}`
      expect(row.demo?.variant).toBe("visitor")
      const me = await app.request("/api/users/me", {
        headers: { Authorization: `Bearer ${data.accessToken}` },
      })
      expect(me.status).toBe(200)
      expect(await waitForSeed(data.orgId, socketPeer)).toBe("failed")
    } finally {
      stubSeeder()
    }
  })

  // BLOCKER 3, third half. The seeder asks ensureOrg for 25 EUR of real
  // credits per signup. The route creates the org first (so the grant never
  // fires) and zeroes the balance after seeding regardless.
  it("never hands a demo org real credits", async () => {
    const socketPeer = nextPeer()
    const data = await readSignup(
      await signup({ name: "Free Money", email: "money@example.com" }, socketPeer),
    )
    await waitForSeed(data.orgId, socketPeer)
    const [balance] = await sql<{ included: string; purchased: string }[]>`
      SELECT included_balance AS included, purchased_balance AS purchased
      FROM kernel.credit_balances WHERE org_id = ${data.orgId}`
    expect(Number(balance.included)).toBe(0)
    expect(Number(balance.purchased)).toBe(0)
  })

  it("gives each visitor their own org, never the same slug twice", async () => {
    const a = await readSignup(await signup({ name: "Acme", email: "a@example.com" }, nextPeer()))
    const b = await readSignup(await signup({ name: "Acme", email: "b@example.com" }, nextPeer()))
    expect(a.orgSlug).not.toBe(b.orgSlug)
    expect(a.orgId).not.toBe(b.orgId)
  })

  it("refuses the request that exceeds the per-peer hourly budget, with 429", async () => {
    const socketPeer = nextPeer()
    const limit = env.LIAISON_DEMO_SIGNUPS_PER_IP_PER_HOUR
    for (let i = 0; i < limit; i++) {
      const ok = await signup({ name: `Burst ${i}`, email: `burst${i}@example.com` }, socketPeer)
      expect(ok.status).toBe(201)
    }
    const refused = await signup({ name: "One too many", email: "over@example.com" }, socketPeer)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0)
    const [count] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM kernel.organizations WHERE slug LIKE 'demo-one-too-many-%'`
    expect(Number(count.count)).toBe(0)
  })

  // BLOCKER 2. The limiter used to key on getClientIp, which is
  // X-Forwarded-For offset by TRUSTED_PROXY_HOPS: one client-supplied header
  // per request bought a fresh bucket and therefore unbounded org creation.
  // Every request here carries a DIFFERENT spoofed X-Forwarded-For and the
  // SAME socket peer, so the budget must still be spent exactly once.
  it("cannot be bypassed by a client-supplied X-Forwarded-For", async () => {
    const socketPeer = nextPeer()
    const limit = env.LIAISON_DEMO_SIGNUPS_PER_IP_PER_HOUR
    for (let i = 0; i < limit; i++) {
      const ok = await signup({ name: `Spoof ${i}`, email: `spoof${i}@example.com` }, socketPeer, {
        spoofedForwardedFor: `203.0.113.${i + 10}`,
      })
      expect(ok.status).toBe(201)
    }
    const refused = await signup(
      { name: "Spoofed over", email: "spoofover@example.com" },
      socketPeer,
      { spoofedForwardedFor: "203.0.113.200" },
    )
    expect(refused.status).toBe(429)
    const [count] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM kernel.organizations WHERE slug LIKE 'demo-spoofed-over-%'`
    expect(Number(count.count)).toBe(0)
  })

  it("keeps a different visitor's budget separate", async () => {
    const busy = nextPeer()
    for (let i = 0; i < env.LIAISON_DEMO_SIGNUPS_PER_IP_PER_HOUR; i++) {
      await signup({ name: `Busy ${i}`, email: `busy${i}@example.com` }, busy)
    }
    expect((await signup({ name: "Busy again", email: "x@example.com" }, busy)).status).toBe(429)
    expect((await signup({ name: "Fresh", email: "fresh@example.com" }, nextPeer())).status).toBe(
      201,
    )
  })

  // Polling the workspace you were just given must not spend the budget that
  // created it, or a visitor watching their own demo fill in locks themselves
  // out of it.
  it("does not spend the signup budget on readiness polls", async () => {
    const socketPeer = nextPeer()
    const data = await readSignup(
      await signup({ name: "Poller", email: "poll@example.com" }, socketPeer),
    )
    for (let i = 0; i < 20; i++) {
      const status = await demoApp.request(`/api/demo/orgs/${data.orgId}/status`, {
        headers: { "x-bun-socket-ip": socketPeer },
      })
      expect(status.status).toBe(200)
    }
    expect(
      (await signup({ name: "After polls", email: "after@example.com" }, socketPeer)).status,
    ).toBe(201)
  })

  it("404s the status of an org that is not a demo org", async () => {
    const { orgId } = await ensureOrg({ slug: `plain-${Date.now()}`, name: "Plain Co" })
    const response = await demoApp.request(`/api/demo/orgs/${orgId}/status`, {
      headers: { "x-bun-socket-ip": nextPeer() },
    })
    expect(response.status).toBe(404)
    const junk = await demoApp.request("/api/demo/orgs/not-a-uuid/status", {
      headers: { "x-bun-socket-ip": nextPeer() },
    })
    expect(junk.status).toBe(404)
  })

  it("refuses to create an org when demo mode is off", async () => {
    DemoModeTestAccess.set(false)
    try {
      const response = await signup({ name: "Sneaky", email: "sneaky@example.com" }, nextPeer())
      expect(response.status).toBe(404)
      const [count] = await sql<{ count: string }[]>`
        SELECT count(*) AS count FROM kernel.organizations WHERE slug LIKE 'demo-sneaky-%'`
      expect(Number(count.count)).toBe(0)
    } finally {
      DemoModeTestAccess.set(true)
    }
  })

  it("validates its input instead of creating junk", async () => {
    for (const body of [
      {},
      { name: "", email: "a@example.com" },
      { name: "Fine", email: "not-an-email" },
      { name: "x".repeat(81), email: "a@example.com" },
      { name: "Fine", email: 42 },
    ]) {
      const response = await signup(body, nextPeer())
      expect(response.status).toBe(400)
    }
  })

  // The body limit really is in front of the handler here, which is the point
  // of assembling this app from app.ts's own middleware.
  it("is behind the global body limit", async () => {
    const response = await signup(
      { name: "Huge", email: "huge@example.com", padding: "x".repeat(2 * 1024 * 1024) },
      nextPeer(),
    )
    expect(response.status).toBe(413)
  })
})

describe("demo leads: export and opt-out", () => {
  const savedOperator = env.LIAISON_OPERATOR_ORG_ID

  beforeAll(async () => {
    await acquireTestLock()
    DemoModeTestAccess.set(true)
    enableDemoDoorForTest()
    stubSeeder()
  })

  afterAll(async () => {
    env.LIAISON_OPERATOR_ORG_ID = savedOperator
    resetOperatorOrgCache()
    DemoModeTestAccess.set(null)
    restoreDemoDoorEnv()
    DemoSeederTestAccess.reset()
    await releaseTestLock()
  })

  afterEach(async () => {
    await clearRedisPatterns(["ratelimit:*", "bruteforce:*", "demo:*"])
    invalidateDemoMarker()
  })

  function exportLeads(bearer: string | null, format?: "csv") {
    return demoApp.request(`/api/demo/leads${format ? "?format=csv" : ""}`, {
      headers: {
        "x-bun-socket-ip": nextPeer(),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
    })
  }

  it("exports only to the instance operator's org, and the lead outlives its demo org", async () => {
    const socketPeer = nextPeer()
    const visitor = await readSignup(
      await signup({ name: "=Lead, Person", email: "Lead@Example.com" }, socketPeer),
    )
    await waitForSeed(visitor.orgId, socketPeer)

    // No session: refused.
    expect((await exportLeads(null)).status).toBe(401)
    // A visitor is the admin of their own org, and still refused.
    expect((await exportLeads(visitor.accessToken)).status).toBe(403)

    const operatorOrg = await createTestOrg()
    env.LIAISON_OPERATOR_ORG_ID = operatorOrg.id
    resetOperatorOrgCache()
    const operator = await minimal.session(operatorOrg.id, { role: "admin" })
    const member = await minimal.session(operatorOrg.id)
    expect((await exportLeads(member.bearer)).status).toBe(403)

    // The demo org goes (the reaper's job); the lead stays.
    await sql`DELETE FROM kernel.organizations WHERE id = ${visitor.orgId}`

    const json = await exportLeads(operator.bearer)
    expect(json.status).toBe(200)
    const rows = ((await json.json()) as { data: Array<Record<string, unknown>> }).data
    const lead = rows.find((r) => r.demoOrgId === visitor.orgId)
    expect(lead?.email).toBe("lead@example.com")
    expect(lead?.name).toBe("=Lead, Person")
    expect(lead?.optedOutAt).toBeNull()
    expect(String(lead?.optOutToken).length).toBeGreaterThanOrEqual(32)
    // The export says whether the address was confirmed, and what was picked.
    expect(lead?.verified).toBe(false)
    expect(lead?.notifyManagedAt).toBeNull()
    expect(lead?.needs).toEqual(["support"])

    const csv = await exportLeads(operator.bearer, "csv")
    expect(csv.status).toBe(200)
    expect(csv.headers.get("content-type")).toContain("text/csv")
    const text = await csv.text()
    expect(text.split("\r\n")[0]).toBe(
      "email,name,created_at,notice_version,demo_org_id,opted_out_at,opt_out_token,unsubscribe_url,verified,verified_at,notify_managed_at,needs,identity_erased_at",
    )
    // Each row carries the link a message uses to unsubscribe.
    const unsubscribe = new URL(String(lead?.unsubscribeUrl))
    expect(unsubscribe.pathname).toBe("/demo/unsubscribe")
    expect(unsubscribe.searchParams.get("token")).toBe(String(lead?.optOutToken))
    // A name a spreadsheet would run as a formula is defused, and quoted.
    expect(text).toContain(`lead@example.com,"'=Lead, Person",`)

    // Opt out by the token, without a session; the same answer for a bad token.
    const token = String(lead?.optOutToken)
    const optOut = await demoApp.request("/api/demo/leads/opt-out", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bun-socket-ip": nextPeer() },
      body: JSON.stringify({ token }),
    })
    expect(optOut.status).toBe(200)
    const bogus = await demoApp.request(`/api/demo/leads/opt-out?token=${"x".repeat(43)}`, {
      method: "POST",
      headers: { "x-bun-socket-ip": nextPeer() },
    })
    expect(bogus.status).toBe(200)
    expect(await bogus.json()).toEqual({ data: { optedOut: true } })
    // Opted out: the address stays (do-not-contact), the name goes.
    const [after] = await sql<{ opted_out_at: Date | null; email: string; name: string }[]>`
      SELECT opted_out_at, email, name FROM kernel.demo_leads WHERE opt_out_token = ${token}`
    expect(after.opted_out_at).not.toBeNull()
    expect(after.email).toBe("lead@example.com")
    expect(after.name).toBe("")
  })

  it("purges leads past retention, keeping recent ones and the opted-out list", async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const old = new Date(
      Date.now() - (DEMO_LEAD_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString()
    await sql`
      INSERT INTO kernel.demo_leads (email, name, notice_version, opt_out_token, created_at, opted_out_at)
      VALUES
        (${`stale-${tag}@example.com`}, 'Stale', 'v', ${`stale-${tag}-${"t".repeat(40)}`}, ${old}, NULL),
        (${`out-${tag}@example.com`}, '', 'v', ${`out-${tag}-${"t".repeat(40)}`}, ${old}, ${old}),
        (${`fresh-${tag}@example.com`}, 'Fresh', 'v', ${`fresh-${tag}-${"t".repeat(40)}`}, now(), NULL)`
    expect(await purgeStaleDemoLeads()).toBeGreaterThanOrEqual(1)
    const left = await sql<{ email: string }[]>`
      SELECT email FROM kernel.demo_leads WHERE email LIKE ${`%-${tag}@example.com`} ORDER BY email`
    expect(left.map((r) => r.email)).toEqual([`fresh-${tag}@example.com`, `out-${tag}@example.com`])
  })

  it("empties the identity of expired rows not on the news list, and only those", async () => {
    const tag = Date.now().toString(36)
    const old = new Date(Date.now() - 73 * 3600_000).toISOString()
    const seed = async (
      who: string,
      over: { notified?: boolean; verified?: boolean; out?: boolean; at?: string } = {},
    ) =>
      sql`
        INSERT INTO kernel.demo_leads
          (email, email_normalized, email_cap_key, signup_network, name, notice_version,
           opt_out_token, needs, created_at, notify_managed_at, verified_at, opted_out_at)
        VALUES (${`${who}-${tag}@example.com`}, ${`${who}-${tag}@example.com`}, 'example.com',
                '203.0.113.0/24', ${over.out ? "" : "Ada"}, 'v', ${`${who}-${tag}-${"t".repeat(40)}`},
                ${["support"]}, ${over.at ?? old},
                ${over.notified ? old : null}, ${over.verified ? old : null}, ${over.out ? old : null})`
    await seed("plain")
    await seed("ticked", { notified: true })
    await seed("verified", { verified: true })
    await seed("listed", { notified: true, verified: true })
    await seed("out", { out: true })
    await seed("fresh", { at: new Date().toISOString() })

    expect(await eraseExpiredDemoIdentities()).toBeGreaterThanOrEqual(3)
    const rows = await sql<
      {
        token: string
        email: string
        name: string
        email_normalized: string | null
        email_cap_key: string | null
        signup_network: string | null
        notify_managed_at: Date | null
        needs: string[]
        created_at: Date
      }[]
    >`
      SELECT opt_out_token AS token, email, name, email_normalized, email_cap_key, signup_network,
             notify_managed_at, needs, created_at
        FROM kernel.demo_leads WHERE opt_out_token LIKE ${`%-${tag}-%`}`
    const of = (who: string) => rows.find((r) => r.token.startsWith(`${who}-`))
    for (const who of ["plain", "ticked", "verified"]) {
      expect(of(who)).toMatchObject({
        email: "",
        name: "",
        email_normalized: null,
        email_cap_key: null,
        signup_network: null,
        notify_managed_at: null,
        needs: ["support"],
      })
      expect(new Date(of(who)?.created_at as Date).toISOString()).toBe(old)
    }
    expect(of("listed")).toMatchObject({ email: `listed-${tag}@example.com`, name: "Ada" })
    expect(of("out")).toMatchObject({ email: `out-${tag}@example.com`, name: "" })
    expect(of("fresh")).toMatchObject({ email: `fresh-${tag}@example.com`, name: "Ada" })
    // Nothing left to do: a second sweep touches none of these rows.
    const before = await sql`SELECT identity_erased_at FROM kernel.demo_leads
                              WHERE opt_out_token LIKE ${`plain-${tag}-%`}`
    await eraseExpiredDemoIdentities()
    const after = await sql`SELECT identity_erased_at FROM kernel.demo_leads
                             WHERE opt_out_token LIKE ${`plain-${tag}-%`}`
    expect(after).toEqual(before)
  })

  it("one unsubscribe covers every row with the same address", async () => {
    const tag = Date.now().toString(36)
    const mailbox = `same-${tag}@example.com`
    for (const n of ["a", "b"]) {
      await sql`INSERT INTO kernel.demo_leads (email, email_normalized, name, notice_version, opt_out_token)
                VALUES (${mailbox}, ${mailbox}, 'Ada', 'v', ${`${n}-${tag}-${"t".repeat(40)}`})`
    }
    expect(await optOutDemoLead(`a-${tag}-${"t".repeat(40)}`)).toBe(true)
    const rows = await sql<{ name: string; out: boolean }[]>`
      SELECT name, opted_out_at IS NOT NULL AS out FROM kernel.demo_leads WHERE email = ${mailbox}`
    expect([...rows]).toEqual([
      { name: "", out: true },
      { name: "", out: true },
    ])
  })

  it("the news checkbox is the consent: on the row only when ticked", async () => {
    const start = async (email: string, newsOptIn?: boolean) => {
      const res = await demoApp.request("/api/demo/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-bun-socket-ip": "203.0.113.77" },
        body: JSON.stringify({
          name: "Ada",
          email,
          needs: ["support"],
          turnstileToken: passingTurnstileToken(),
          ...(newsOptIn === undefined ? {} : { newsOptIn }),
        }),
      })
      expect(res.status).toBe(201)
    }
    const tag = Date.now().toString(36)
    await start(`ticked-${tag}@example.com`, true)
    await start(`unticked-${tag}@example.com`)
    const rows = await sql<{ email: string; notified: boolean }[]>`
      SELECT email, notify_managed_at IS NOT NULL AS notified FROM kernel.demo_leads
       WHERE email LIKE ${`%-${tag}@example.com`} ORDER BY email`
    expect([...rows]).toEqual([
      { email: `ticked-${tag}@example.com`, notified: true },
      { email: `unticked-${tag}@example.com`, notified: false },
    ])
  })

  it("budgets never hold a plain address: the ledger and Redis move once", async () => {
    await sql`DELETE FROM kernel.demo_spend WHERE budget = 'email'`
    const address = "moved@example.com"
    await sql`INSERT INTO kernel.demo_spend (budget, key, period, spent_micro_eur)
              VALUES ('email', ${address}, 'life', 150), ('email', ${demoBudgetEmailKey(address)}, 'life', 50)`
    await redis.set(`demo:b:s:email:${address}`, "150")
    await rekeyPlainBudgetAddresses()
    const rows = await sql<{ key: string; spent: string }[]>`
      SELECT key, spent_micro_eur::text AS spent FROM kernel.demo_spend WHERE budget = 'email'`
    expect([...rows]).toEqual([{ key: demoBudgetEmailKey(address), spent: "200" }])
    expect(await redis.exists(`demo:b:s:email:${address}`)).toBe(0)
    await sql`DELETE FROM kernel.demo_spend WHERE budget = 'email'`
  })

  it("a network's counter is deleted once its UTC day is over; today's and the others stay", async () => {
    await sql`DELETE FROM kernel.demo_spend WHERE budget IN ('net', 'box')`
    await sql`INSERT INTO kernel.demo_spend (budget, key, period, spent_micro_eur)
              VALUES ('net', '203.0.113.0/24', '2026-11-05', 10),
                     ('net', '203.0.113.0/24', '2026-11-06', 20),
                     ('box', 'box', '2026-11-05', 30)`
    const pruned = await pruneElapsedNetworkBudgets(Date.parse("2026-11-06T00:10:00.000Z"))
    expect(pruned).toBe(1)
    const rows = await sql<{ budget: string; period: string }[]>`
      SELECT budget, period FROM kernel.demo_spend WHERE budget IN ('net', 'box') ORDER BY budget, period`
    expect([...rows]).toEqual([
      { budget: "box", period: "2026-11-05" },
      { budget: "net", period: "2026-11-06" },
    ])
    await sql`DELETE FROM kernel.demo_spend WHERE budget IN ('net', 'box')`
  })
})

describe("demoOrgSlug", () => {
  it("is url-safe, recognisable and never repeats", () => {
    const a = demoOrgSlug("Acme Supplies & Co.")
    const b = demoOrgSlug("Acme Supplies & Co.")
    expect(a).toMatch(/^demo-acme-supplies-co-[0-9a-f]{12}$/)
    expect(a).not.toBe(b)
  })

  it("survives a name with nothing slug-shaped in it", () => {
    expect(demoOrgSlug("...")).toMatch(/^demo-workspace-[0-9a-f]{12}$/)
    expect(demoOrgSlug("Éclair Ltée")).toMatch(/^demo-eclair-ltee-[0-9a-f]{12}$/)
  })
})
