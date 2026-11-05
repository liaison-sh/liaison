// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { seedApiKey, seedInbox, ts } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

let env: WorkerEnv
let world: TestWorld

beforeAll(async () => {
  // TRUSTED_PROXY_HOPS=1 so the spawned server honors x-forwarded-for and each
  // uniqueIp() gets its own anonymous rate-limit bucket. Without it the server
  // falls back to the socket IP (127.0.0.1) for every request, so C3's
  // intentional limit-exhaustion bleeds 429s into C4/C14.
  const r = await setupScenario({ seed: 720, serverEnv: { TRUSTED_PROXY_HOPS: "1" } })
  env = r.env
  world = r.world
}, 60_000) // setupScenario spawns a server + builds a world; bun's 5s hook cap (not raised by bunfig) is too tight on slower hosts

afterAll(async () => {
  await teardownScenario(env, world)
})

// Anonymous ticket creation is rate-limited per client IP (5/min). Tests share
// one Redis instance, so each request needs a globally-unique source IP or one
// scenario's traffic (e.g. C3, which intentionally exhausts an IP's budget)
// bleeds 429s into the next. `Date.now() % 200` collided across adjacent tests;
// a monotonic counter over the reserved 198.18.0.0/15 benchmarking range never
// repeats within a run.
let ipCounter = 0
function uniqueIp(): string {
  ipCounter += 1
  return `198.18.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`
}

async function postCreate(
  body: unknown,
  init?: { headers?: Record<string, string>; method?: string },
): Promise<Response> {
  const url = `${env.serverUrl}/webhooks/${world.org.id}/tickets/create`
  return fetch(url, {
    method: init?.method ?? "POST",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("tickets-email scenarios", () => {
  describe("S0 smoke + public webhook anonymous create", () => {
    it("anonymous create returns 200 with ticketId when default inbox exists", async () => {
      const inbox = await seedInbox(env, {
        orgId: world.org.id,
        name: "S0 Support",
        emailAddress: `s0-${Date.now()}@org.test`,
        isDefaultForCreate: true,
      })
      const subject = `Smoke ${Date.now()}`
      const res = await postCreate({
        subject,
        fromEmail: "alice@cust.test",
        textBody: "help me",
      })
      if (res.status !== 200) {
        const body = await res.text()
        throw new Error(`expected 200 got ${res.status}: ${body}`)
      }
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data?: { ticketId?: string; ticketHandle?: string } }
      expect(body.data?.ticketId).toBeDefined()

      const rows = await env.db.sql.unsafe(
        `SELECT id, source_inbox_id, channel FROM ${ts(env)}.tickets WHERE org_id = $1 AND subject = $2`,
        [world.org.id, subject],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].source_inbox_id).toBe(inbox.id)
      expect(rows[0].channel).toBe("web_form")

      const messages = await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ts(env)}.messages WHERE org_id = $1 AND ticket_id = $2`,
        [world.org.id, rows[0].id],
      )
      expect(messages[0].n).toBe(1)
    })
  })

  describe("D2 anonymous honeypot drop", () => {
    it("returns 200 with received:true and creates no ticket", async () => {
      await seedInbox(env, {
        orgId: world.org.id,
        name: "D2 Support",
        emailAddress: `d2-${Date.now()}@org.test`,
        isDefaultForCreate: false,
      })
      const subject = `Honeypot ${Date.now()}`
      const res = await postCreate({
        subject,
        fromEmail: "bot@spammer.test",
        textBody: "spam",
        honeypot: "filled",
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data?: { received?: boolean } }
      expect(body.data?.received).toBe(true)

      const rows = await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ts(env)}.tickets WHERE org_id = $1 AND subject = $2`,
        [world.org.id, subject],
      )
      expect(rows[0].n).toBe(0)
    })
  })

  describe("D3 anonymous replay returns duplicate", () => {
    it("second submission of same body within 60s returns duplicate flag", async () => {
      const subject = `Replay ${Date.now()}`
      const body = JSON.stringify({
        subject,
        fromEmail: "alice@cust.test",
        textBody: "first",
      })
      const headers = { "x-forwarded-for": uniqueIp() }
      const r1 = await postCreate(body, { headers })
      expect(r1.status).toBe(200)
      const r2 = await postCreate(body, { headers })
      expect(r2.status).toBe(200)
      const j2 = (await r2.json()) as { data?: { duplicate?: boolean; received?: boolean } }
      expect(j2.data?.duplicate).toBe(true)
      const rows = await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ts(env)}.tickets WHERE org_id = $1 AND subject = $2`,
        [world.org.id, subject],
      )
      expect(rows[0].n).toBe(1)
    })
  })

  describe("D7 body too large + CORS preflight", () => {
    it("returns 413 for bodies > 51200 bytes", async () => {
      const big = "x".repeat(60_000)
      const res = await postCreate({ blob: big })
      expect(res.status).toBe(413)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe("payload_too_large")
    })

    it("OPTIONS preflight returns 204 with permissive CORS headers", async () => {
      const url = `${env.serverUrl}/webhooks/${world.org.id}/tickets/create`
      const res = await fetch(url, {
        method: "OPTIONS",
        headers: { Origin: "https://customer.test" },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get("access-control-allow-origin")).toBe("https://customer.test")
      expect(res.headers.get("access-control-allow-methods")).toContain("POST")
    })
  })

  describe("D4 API-keyed externalRef idempotency", () => {
    it("second submission with same externalRef returns idempotent: true", async () => {
      const inbox = await seedInbox(env, {
        orgId: world.org.id,
        name: "D4 Support",
        emailAddress: `d4-${Date.now()}@org.test`,
      })
      const key = await seedApiKey(env, {
        orgId: world.org.id,
        createdBy: world.admin.id,
        label: "d4",
      })
      const externalRef = `ext-${Date.now()}`
      const body = {
        subject: `D4 idempotent ${Date.now()}`,
        fromEmail: "alice@cust.test",
        textBody: "first",
        externalRef,
        sourceInboxId: inbox.id,
      }
      const headers = { Authorization: `Bearer ${key.plaintext}` }
      const r1 = await postCreate(body, { headers })
      expect(r1.status).toBe(200)
      const j1 = (await r1.json()) as { data?: { ticketId?: string } }
      const r2 = await postCreate(body, { headers })
      expect(r2.status).toBe(200)
      const j2 = (await r2.json()) as {
        data?: { ticketId?: string; idempotent?: boolean }
      }
      expect(j2.data?.idempotent).toBe(true)
      expect(j2.data?.ticketId).toBe(j1.data?.ticketId)
    })
  })

  describe("D6 API-keyed revoked key returns 401", () => {
    it("rejects with invalid_api_key", async () => {
      const key = await seedApiKey(env, {
        orgId: world.org.id,
        createdBy: world.admin.id,
        label: "revoked",
        revoked: true,
      })
      const res = await postCreate(
        {
          subject: `Revoked ${Date.now()}`,
          fromEmail: "alice@cust.test",
          textBody: "x",
        },
        { headers: { Authorization: `Bearer ${key.plaintext}` } },
      )
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe("invalid_api_key")
    })
  })

  describe("D6 API-keyed missing inbox returns 422", () => {
    it("rejects with inbox_required when no default inbox exists for the org", async () => {
      // Build an isolated org with no default inbox.
      const orgSlug = `iso-d6-${Date.now()}`
      const orgRows = await env.db.sql.unsafe(
        `INSERT INTO ${ks(env)}.organizations (id, name, slug, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, now(), now()) RETURNING id`,
        [`Isolated D6 ${Date.now()}`, orgSlug],
      )
      const orgId = orgRows[0].id as string
      const url = `${env.serverUrl}/webhooks/${orgId}/tickets/create`
      const key = await seedApiKey(env, {
        orgId,
        createdBy: world.admin.id,
        label: "no-inbox",
      })
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key.plaintext}`,
        },
        body: JSON.stringify({
          subject: "missing inbox",
          fromEmail: "x@y.test",
          textBody: "x",
        }),
      })
      expect(res.status).toBe(422)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe("inbox_required")
    })
  })

  describe("C3 anonymous rate-limit 429 + Retry-After", () => {
    it("6th rapid request from same IP returns 429 with Retry-After header", async () => {
      // Fresh org with default inbox so rate-limit is the only gate.
      const orgRows = await env.db.sql.unsafe(
        `INSERT INTO ${ks(env)}.organizations (id, name, slug, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, now(), now()) RETURNING id`,
        [`C3 ${Date.now()}`, `c3-${Date.now()}`],
      )
      const orgId = orgRows[0].id as string
      await seedInbox(env, {
        orgId,
        // This throwaway org has no users of its own; the connection's NOT NULL
        // created_by just needs a valid users row, so reuse the world admin.
        createdBy: world.admin.id,
        emailAddress: `c3-${Date.now()}@org.test`,
        isDefaultForCreate: true,
      })

      const ip = uniqueIp()
      const url = `${env.serverUrl}/webhooks/${orgId}/tickets/create`
      let last: Response | null = null
      for (let i = 0; i < 6; i++) {
        // Unique payload per request so anonymous replay guard does not mask the limiter.
        last = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": ip,
          },
          body: JSON.stringify({
            subject: `rl-${i}-${Date.now()}`,
            fromEmail: "alice@cust.test",
            textBody: `body-${i}-${Date.now()}`,
          }),
        })
        if (last.status === 429) break
      }
      if (!last) throw new Error("no response captured")
      expect(last.status).toBe(429)
      expect(last.headers.get("retry-after")).toBeTruthy()
      const body = (await last.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe("rate_limited")
    })
  })

  describe("C4 anonymous create — no default inbox → 503", () => {
    it("returns 503 no_default_inbox in a fresh org without a default inbox", async () => {
      const orgRows = await env.db.sql.unsafe(
        `INSERT INTO ${ks(env)}.organizations (id, name, slug, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, now(), now()) RETURNING id`,
        [`C4 ${Date.now()}`, `c4-${Date.now()}`],
      )
      const orgId = orgRows[0].id as string
      const url = `${env.serverUrl}/webhooks/${orgId}/tickets/create`
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": uniqueIp(),
        },
        body: JSON.stringify({
          subject: `C4 ${Date.now()}`,
          fromEmail: "alice@cust.test",
          textBody: "anon",
        }),
      })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe("no_default_inbox")
    })
  })

  describe("C8 API-keyed duplicate without externalRef → 409", () => {
    it("second submission with same body and no externalRef returns 409 duplicate_delivery", async () => {
      await seedInbox(env, {
        orgId: world.org.id,
        emailAddress: `c8-${Date.now()}@org.test`,
        isDefaultForCreate: false,
      })
      const key = await seedApiKey(env, {
        orgId: world.org.id,
        createdBy: world.admin.id,
        label: "c8",
      })
      const body = {
        subject: `C8 dup ${Date.now()}`,
        fromEmail: "alice@cust.test",
        textBody: `c8-${Date.now()}`,
      }
      const headers = { Authorization: `Bearer ${key.plaintext}` }
      const r1 = await postCreate(body, { headers })
      if (r1.status !== 200) {
        throw new Error(`r1 expected 200, got ${r1.status}: ${await r1.text()}`)
      }
      const r2 = await postCreate(body, { headers })
      expect(r2.status).toBe(409)
      const j2 = (await r2.json()) as { error?: { code?: string } }
      expect(j2.error?.code).toBe("duplicate_delivery")
    })
  })

  describe("C10 API-keyed origin disallowed → 403", () => {
    it("rejects when Origin is not in the key's allowedOrigins list", async () => {
      await seedInbox(env, {
        orgId: world.org.id,
        emailAddress: `c10-${Date.now()}@org.test`,
        isDefaultForCreate: false,
      })
      const key = await seedApiKey(env, {
        orgId: world.org.id,
        createdBy: world.admin.id,
        label: "c10",
        allowedOrigins: ["https://allowed.test"],
      })
      const res = await postCreate(
        {
          subject: `C10 ${Date.now()}`,
          fromEmail: "alice@cust.test",
          textBody: "x",
        },
        {
          headers: {
            Authorization: `Bearer ${key.plaintext}`,
            Origin: "https://blocked.test",
          },
        },
      )
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe("origin_disallowed")
    })
  })

  describe("C14 anonymous payload field-stripping", () => {
    it("anonymous tier ignores priority/assignedTo/team/externalRef and sets defaults", async () => {
      await seedInbox(env, {
        orgId: world.org.id,
        emailAddress: `c14-${Date.now()}@org.test`,
        isDefaultForCreate: true,
      })
      const subject = `C14 strip ${Date.now()}`
      const externalRef = `ext-c14-${Date.now()}`
      const res = await postCreate(
        {
          subject,
          fromEmail: "alice@cust.test",
          textBody: "anon",
          priority: "urgent",
          assignedTo: "00000000-0000-0000-0000-000000000123",
          team: "support",
          externalRef,
        },
        { headers: { "x-forwarded-for": uniqueIp() } },
      )
      expect(res.status).toBe(200)
      const rows = await env.db.sql.unsafe(
        `SELECT priority, assigned_to, team, external_ref
         FROM ${ts(env)}.tickets WHERE org_id = $1 AND subject = $2`,
        [world.org.id, subject],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].priority).toBe("normal")
      expect(rows[0].assigned_to).toBeNull()
      expect(rows[0].team).toBeNull()
      expect(rows[0].external_ref).toBeNull()
    })
  })
})

function ks(env: WorkerEnv): string {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}
