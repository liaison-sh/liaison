// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { ks, seedInbox, seedTicket, ts } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

let env: WorkerEnv
let world: TestWorld
let url: string

beforeAll(async () => {
  const r = await setupScenario({ seed: 760 })
  env = r.env
  world = r.world
  url = env.serverUrl
}, 120_000)

afterAll(async () => {
  await teardownScenario(env, world)
})

describe("tickets-email cross-cutting (D group)", () => {
  describe("D1 cross-org isolation: reply token cannot cross org boundary", () => {
    it("inbound to org B addressed with org A's token does not match A's ticket", async () => {
      const orgIdA = world.org.id

      // Spin up an isolated org B in the same worker.
      const orgBSlug = `iso-d1-${Date.now()}`
      const orgRows = await env.db.sql.unsafe(
        `INSERT INTO ${ks(env)}.organizations (id, name, slug, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, now(), now()) RETURNING id`,
        [`Cross-org D1 ${Date.now()}`, orgBSlug],
      )
      const orgIdB = orgRows[0].id as string

      // Seed default tickets settings for org B so createTicket can proceed.
      const orgBSettings = {
        fileSizeLimitMb: 50,
        storageQuotaGb: 10,
        auditRetentionDays: 90,
        rateLimitPerMinute: 100,
        tickets: {
          sla: {
            targets: { low: 86400, normal: 28800, high: 7200, urgent: 3600 },
            businessHours: {
              timezone: "UTC",
              weekly: {
                mon: [["09:00", "18:00"]],
                tue: [["09:00", "18:00"]],
                wed: [["09:00", "18:00"]],
                thu: [["09:00", "18:00"]],
                fri: [["09:00", "18:00"]],
                sat: [],
                sun: [],
              },
              holidays: [],
            },
          },
        },
      }
      // Cast through text → json → jsonb to coerce a string param into a real
      // jsonb object (postgres-js otherwise stores the text as a JSON STRING).
      await env.db.sql.unsafe(
        `UPDATE ${ks(env)}.organizations
         SET settings = $2::text::jsonb
         WHERE id = $1`,
        [orgIdB, JSON.stringify(orgBSettings)],
      )

      // Org A has a ticket with replyToken X.
      const inboxA = await seedInbox(env, {
        orgId: orgIdA,
        emailAddress: `dA-${Date.now()}@org.test`,
        name: "Org A inbox",
        isDefaultForCreate: true,
      })
      const ticketA = await seedTicket(env, {
        orgId: orgIdA,
        subject: `Org A ticket ${Date.now()}`,
        sourceInboxId: inboxA.id,
      })

      // Org B has its own default inbox.
      await seedInbox(env, {
        orgId: orgIdB,
        emailAddress: `dB-${Date.now()}@org.test`,
        name: "Org B inbox",
        isDefaultForCreate: true,
      })

      // Verify the UPDATE landed.
      const settingsCheck = await env.db.sql.unsafe(
        `SELECT id, settings FROM ${ks(env)}.organizations WHERE id = $1`,
        [orgIdB],
      )
      if (!settingsCheck[0]) {
        throw new Error(`org B not found: ${orgIdB}`)
      }
      console.log("[D1 debug] org B settings:", JSON.stringify(settingsCheck[0].settings))

      // Anonymous webhook submission to Org B with org A's token in the payload.
      const subject = `Cross-org D1 ${Date.now()}`
      const res = await fetch(`${url}/webhooks/${orgIdB}/tickets/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": `198.51.100.${Date.now() % 200}`,
        },
        body: JSON.stringify({
          subject,
          fromEmail: "alice@cust.test",
          textBody: `Re: anything (with token tkt_${ticketA.replyToken})`,
        }),
      })
      if (res.status !== 200) {
        throw new Error(`expected 200, got ${res.status}: ${await res.text()}`)
      }

      // Org A's ticket message count must remain 0 (no append crossed orgs).
      const orgAMessages = await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ts(env)}.messages WHERE org_id = $1 AND ticket_id = $2`,
        [orgIdA, ticketA.id],
      )
      expect(orgAMessages[0].n).toBe(0)

      // Org B got a fresh ticket with the submitted subject.
      const orgBTickets = await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ts(env)}.tickets WHERE org_id = $1 AND subject = $2`,
        [orgIdB, subject],
      )
      expect(orgBTickets[0].n).toBe(1)
    })
  })

  describe("D2 schema invariants visible to live worker", () => {
    it("messages table has partial unique on (org_id, external_message_id) WHERE not null", async () => {
      const rows = await env.db.sql.unsafe(
        `
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1
          AND tablename = 'messages'
          AND indexdef ILIKE '%external_message_id%'
          AND indexdef ILIKE '%WHERE%'
      `,
        [`${env.schemaPrefix}app_tickets`],
      )
      expect(rows.length).toBeGreaterThan(0)
    })

    it("inboxes table has partial unique on (org_id) WHERE is_default_for_create = true", async () => {
      const rows = await env.db.sql.unsafe(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = $1
           AND tablename = 'inboxes'
           AND indexdef ILIKE '%is_default_for_create%'
           AND indexdef ILIKE '%WHERE%'`,
        [`${env.schemaPrefix}app_tickets`],
      )
      expect(rows.length).toBeGreaterThan(0)
    })

    it("inboxes.is_default_for_create is bool not-null default false", async () => {
      const rows = await env.db.sql.unsafe(
        `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'inboxes'
           AND column_name = 'is_default_for_create'`,
        [`${env.schemaPrefix}app_tickets`],
      )
      expect(rows.length).toBe(1)
      expect(rows[0].data_type).toBe("boolean")
      expect(rows[0].is_nullable).toBe("NO")
      expect(String(rows[0].column_default)).toMatch(/false/)
    })
  })
})
