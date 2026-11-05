// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import IORedis from "ioredis"
import { type GmailHttpFixture, startGmailHttpFixture } from "~/tests/fixtures/email/gmail-http"
import { signMockOidcToken, startMockOidc } from "./helpers/mock-oidc"
import { ks, seedConnectedAccount, seedInbox, seedTicket, ts } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

let env: WorkerEnv
let world: TestWorld
let oidc: { url: string; stop: () => void }
let gmailFixture: GmailHttpFixture

const PUBSUB_AUDIENCE = "https://liaison.test/webhooks/gmail-push"
const PUBSUB_SERVICE_ACCOUNT = "gmail-api-push@system.gserviceaccount.com"
const OIDC_PORT = 14571

beforeAll(async () => {
  oidc = await startMockOidc(OIDC_PORT)
  gmailFixture = await startGmailHttpFixture()

  const r = await setupScenario({
    seed: 750,
    serverEnv: {
      TICKETS_GMAIL_PUSH_JWKS_URL: `${oidc.url}/jwks`,
      TICKETS_GMAIL_PUSH_ISSUER: oidc.url,
      TICKETS_E2E_GMAIL_API_BASE_URL: gmailFixture.apiBaseUrl,
      TICKETS_E2E_IMAP_FAKE: "redis",
    },
  })
  env = r.env
  world = r.world

  // Seed app config + tickets settings for the org so verifier reads
  // gmailPushAudience/serviceAccount and sla settings exist.
  await env.db.sql.unsafe(
    `UPDATE ${ks(env)}.apps
       SET config = jsonb_build_object(
         'gmailPushAudience', $2::text,
         'gmailPushServiceAccount', $3::text
       )
     WHERE org_id = $1 AND name = 'tickets'`,
    [world.org.id, PUBSUB_AUDIENCE, PUBSUB_SERVICE_ACCOUNT],
  )
}, 120_000)

afterAll(async () => {
  await gmailFixture.close()
  oidc.stop()
  await teardownScenario(env, world)
})

async function postGmailPush(opts: {
  accountEmail: string
  historyId: string
  pubsubMessageId: string
  orgId?: string
}): Promise<Response> {
  const token = await signMockOidcToken({
    audience: PUBSUB_AUDIENCE,
    subject: PUBSUB_SERVICE_ACCOUNT,
    email: PUBSUB_SERVICE_ACCOUNT,
  })
  const data = Buffer.from(
    JSON.stringify({ emailAddress: opts.accountEmail, historyId: opts.historyId }),
  ).toString("base64")
  const url = `${env.serverUrl}/webhooks/${opts.orgId ?? world.org.id}/tickets/gmail-push`
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        data,
        messageId: opts.pubsubMessageId,
        publishTime: new Date().toISOString(),
      },
      subscription: "projects/liaison-test/subscriptions/gmail-push",
    }),
  })
}

function gmailMessageFixture(opts: {
  id: string
  from: string
  to: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string[]
}): Parameters<GmailHttpFixture["queueMessage"]>[2] {
  const headers = [
    { name: "Message-Id", value: `<${opts.id}@cust.test>` },
    { name: "From", value: opts.from },
    { name: "To", value: opts.to },
    { name: "Subject", value: opts.subject },
    { name: "Date", value: new Date().toUTCString() },
  ]
  if (opts.inReplyTo) headers.push({ name: "In-Reply-To", value: opts.inReplyTo })
  if (opts.references?.length) {
    headers.push({ name: "References", value: opts.references.join(" ") })
  }
  return {
    id: opts.id,
    threadId: `T-${opts.id}`,
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers,
      body: { data: Buffer.from(opts.body, "utf-8").toString("base64") },
    },
  }
}

async function awaitTicketRow(
  predicate: string,
  args: Array<string | number | boolean | null>,
  timeoutMs = 45_000,
): Promise<Record<string, unknown> | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const rows = await env.db.sql.unsafe(
      `SELECT * FROM ${ts(env)}.tickets WHERE ${predicate} LIMIT 1`,
      args,
    )
    if (rows[0]) return rows[0] as Record<string, unknown>
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

// The IMAP fixture keys are written exactly as the SERVER reads them: under its
// own prefix (`env.redisPrefix`) and nothing else. `~/lib/redis` would add this
// test process's REDIS_PREFIX in front (ioredis keyPrefix), a key the server
// never looks at whenever the run gives the test process a prefix of its own.
let fixtureRedisClient: IORedis | null = null
function fixtureRedis(): IORedis {
  fixtureRedisClient ??= new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379")
  return fixtureRedisClient
}

describe("tickets-email inbound (A group)", () => {
  afterAll(() => {
    fixtureRedisClient?.disconnect()
    fixtureRedisClient = null
  })

  describe("A1 Gmail Push creates a new ticket", () => {
    it("verifies OIDC, fetches via Gmail HTTP fixture, runs matcher → ticket created", async () => {
      const accountEmail = `a1-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      // Seed metadata.gmail.historyId so incremental sync runs (initial sync would enqueue a job).
      await env.db.sql.unsafe(
        `UPDATE ${ks(env)}.connected_accounts
          SET metadata = jsonb_build_object('gmail', jsonb_build_object('historyId', '100'))
          WHERE id = $1`,
        [ca.id],
      )
      await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "A1 inbox",
      })

      const subject = `A1 push ${Date.now()}`
      gmailFixture.queueHistory(accountEmail, {
        history: [{ id: "200", messagesAdded: [{ message: { id: "g1" } }] }],
        historyId: "200",
      })
      gmailFixture.queueMessage(
        accountEmail,
        "g1",
        gmailMessageFixture({
          id: "g1",
          from: "alice@cust.test",
          to: accountEmail,
          subject,
          body: "first inbound",
        }),
      )

      const res = await postGmailPush({
        accountEmail,
        historyId: "200",
        pubsubMessageId: `pm-a1-${Date.now()}`,
      })
      const body = await res.text()
      if (res.status !== 200) {
        throw new Error(`gmail-push expected 200 got ${res.status}: ${body}`)
      }
      console.log("[A1] gmail-push response:", body)

      const ticket = await awaitTicketRow(`org_id = $1 AND subject = $2`, [world.org.id, subject])
      if (!ticket) {
        const fixtureLog = gmailFixture.requests()
        const accounts = await env.db.sql.unsafe(
          `SELECT identifier, metadata FROM ${ks(env)}.connected_accounts WHERE id = $1`,
          [ca.id],
        )
        const audit = await env.db.sql.unsafe(
          `SELECT action, metadata FROM ${ks(env)}.audit_log WHERE org_id = $1 AND app = 'tickets' ORDER BY id DESC LIMIT 5`,
          [world.org.id],
        )
        throw new Error(
          `expected ticket; not found. fixture-requests=${JSON.stringify(fixtureLog)} account=${JSON.stringify(accounts[0])} audit=${JSON.stringify(audit)}`,
        )
      }
      expect(ticket.channel).toBe("email")
      expect(ticket.source_inbox_id).toBeDefined()

      const cursorRow = await env.db.sql.unsafe(
        `SELECT metadata FROM ${ks(env)}.connected_accounts WHERE id = $1`,
        [ca.id],
      )
      const meta = cursorRow[0]?.metadata as { gmail?: { historyId?: string } }
      expect(meta?.gmail?.historyId).toBe("200")
    }, 60_000)
  })

  describe("A2 Gmail Push appends via reply token", () => {
    it("inbound with +tkt_<token> on To: appends to existing ticket", async () => {
      const accountEmail = `a2-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      await env.db.sql.unsafe(
        `UPDATE ${ks(env)}.connected_accounts
          SET metadata = jsonb_build_object('gmail', jsonb_build_object('historyId', '300'))
          WHERE id = $1`,
        [ca.id],
      )
      const inbox = await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "A2 inbox",
      })
      const seeded = await seedTicket(env, {
        orgId: world.org.id,
        subject: `A2 token ${Date.now()}`,
        sourceInboxId: inbox.id,
        status: "awaiting_customer",
      })
      const [local, domain] = accountEmail.split("@")
      const tokenAddr = `${local}+tkt_${seeded.replyToken}@${domain}`
      gmailFixture.queueHistory(accountEmail, {
        history: [{ id: "400", messagesAdded: [{ message: { id: "g2" } }] }],
        historyId: "400",
      })
      gmailFixture.queueMessage(
        accountEmail,
        "g2",
        gmailMessageFixture({
          id: "g2",
          from: "alice@cust.test",
          to: tokenAddr,
          subject: "Re: anything",
          body: "follow-up",
        }),
      )
      const res = await postGmailPush({
        accountEmail,
        historyId: "400",
        pubsubMessageId: `pm-a2-${Date.now()}`,
      })
      expect(res.status).toBe(200)
      const messages = await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ts(env)}.messages WHERE org_id = $1 AND ticket_id = $2`,
        [world.org.id, seeded.id],
      )
      expect(messages[0].n).toBe(1)
      const ticket = await env.db.sql.unsafe(
        `SELECT status FROM ${ts(env)}.tickets WHERE id = $1`,
        [seeded.id],
      )
      expect(ticket[0].status).toBe("open")
    }, 60_000)
  })

  describe("A7 Gmail Push auto-responder dropped", () => {
    it("Auto-Submitted: auto-replied → matcher drops, no ticket inserted", async () => {
      const accountEmail = `a7-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      await env.db.sql.unsafe(
        `UPDATE ${ks(env)}.connected_accounts
          SET metadata = jsonb_build_object('gmail', jsonb_build_object('historyId', '500'))
          WHERE id = $1`,
        [ca.id],
      )
      await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "A7 inbox",
      })
      const subject = `A7 auto ${Date.now()}`
      gmailFixture.queueHistory(accountEmail, {
        history: [{ id: "600", messagesAdded: [{ message: { id: "g7" } }] }],
        historyId: "600",
      })
      gmailFixture.queueMessage(accountEmail, "g7", {
        id: "g7",
        threadId: "T-g7",
        labelIds: ["INBOX"],
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Message-Id", value: "<a7@cust.test>" },
            { name: "From", value: "noreply@cust.test" },
            { name: "To", value: accountEmail },
            { name: "Subject", value: subject },
            { name: "Auto-Submitted", value: "auto-replied" },
          ],
          body: { data: Buffer.from("vacation", "utf-8").toString("base64") },
        },
      })
      const res = await postGmailPush({
        accountEmail,
        historyId: "600",
        pubsubMessageId: `pm-a7-${Date.now()}`,
      })
      expect(res.status).toBe(200)
      const rows = await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ts(env)}.tickets WHERE org_id = $1 AND subject = $2`,
        [world.org.id, subject],
      )
      expect(rows[0].n).toBe(0)
    }, 60_000)
  })

  describe("A3 Gmail Push appends via In-Reply-To header (token-stripped)", () => {
    it("inbound with In-Reply-To matching prior outbound external_message_id appends to ticket", async () => {
      const accountEmail = `a3-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      await env.db.sql.unsafe(
        `UPDATE ${ks(env)}.connected_accounts
          SET metadata = jsonb_build_object('gmail', jsonb_build_object('historyId', '700'))
          WHERE id = $1`,
        [ca.id],
      )
      const inbox = await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "A3 inbox",
      })
      const seeded = await seedTicket(env, {
        orgId: world.org.id,
        subject: `A3 thread ${Date.now()}`,
        sourceInboxId: inbox.id,
        status: "awaiting_customer",
      })
      // Seed a prior outbound message whose external_message_id will be the In-Reply-To target.
      const priorExternalId = `<a3-prior-${Date.now()}@org.test>`
      await env.db.sql.unsafe(
        `INSERT INTO ${ts(env)}.messages (
           id, org_id, ticket_id, kind, from_email, to_emails, subject, text_body,
           snippet, external_message_id, sent_at, created_at, updated_at
         ) VALUES (
           gen_random_uuid(), $1, $2, 'outbound', $3, '[]'::jsonb, 'A3 prior',
           'prior body', 'prior body', $4, now() - interval '1 hour',
           now() - interval '1 hour', now() - interval '1 hour'
         )`,
        [world.org.id, seeded.id, accountEmail, priorExternalId],
      )

      gmailFixture.queueHistory(accountEmail, {
        history: [{ id: "800", messagesAdded: [{ message: { id: "g3" } }] }],
        historyId: "800",
      })
      gmailFixture.queueMessage(
        accountEmail,
        "g3",
        gmailMessageFixture({
          id: "g3",
          from: "alice@cust.test",
          to: accountEmail,
          subject: "Re: anything",
          body: "header-threaded reply",
          inReplyTo: priorExternalId,
        }),
      )
      const res = await postGmailPush({
        accountEmail,
        historyId: "800",
        pubsubMessageId: `pm-a3-${Date.now()}`,
      })
      expect(res.status).toBe(200)
      const messages = await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ts(env)}.messages WHERE org_id = $1 AND ticket_id = $2 AND kind = 'inbound'`,
        [world.org.id, seeded.id],
      )
      expect(messages[0].n).toBe(1)
    }, 60_000)
  })

  describe("A4 subject-handle fallback + cross-org isolation", () => {
    it("subject [#handle] from org A does not match in org B; org B gets a new ticket", async () => {
      const { hashPassword } = await import("~/lib/crypto")
      const { api } = await import("@liaison/test-helpers")

      // Bootstrap org B in the same worker by direct DB seeds + login → triggers
      // ensureAppsForOrg in the worker process, which registers the gmail-push
      // webhook handler for org B.
      const orgBSlug = `iso-a4-${Date.now()}`
      const orgRows = await env.db.sql.unsafe(
        `INSERT INTO ${ks(env)}.organizations (id, name, slug, settings, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3::text::jsonb, now(), now()) RETURNING id`,
        [
          `A4 cross-org ${Date.now()}`,
          orgBSlug,
          JSON.stringify({
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
          }),
        ],
      )
      const orgIdB = orgRows[0].id as string

      // Apps row for tickets in org B + push config (org-level, since the
      // verifier reads gmailPushAudience/gmailPushServiceAccount from app config).
      await env.db.sql.unsafe(
        `INSERT INTO ${ks(env)}.apps (id, org_id, name, version, status, config, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'tickets', '1', 'active', $2::text::jsonb, now(), now())`,
        [
          orgIdB,
          JSON.stringify({
            gmailPushAudience: PUBSUB_AUDIENCE,
            gmailPushServiceAccount: PUBSUB_SERVICE_ACCOUNT,
          }),
        ],
      )

      // Admin role + needed scopes for ensureAppsForOrg trigger via the apps API.
      const roleRows = await env.db.sql.unsafe(
        `INSERT INTO ${ks(env)}.roles (id, org_id, name, description, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'a4-admin', 'A4 admin', now(), now()) RETURNING id`,
        [orgIdB],
      )
      const roleId = roleRows[0].id as string
      for (const scope of [
        "kernel:*",
        "tickets:*",
        "tickets:tickets:read",
        "tickets:tickets:write",
        "tickets:approve",
      ]) {
        await env.db.sql.unsafe(
          `INSERT INTO ${ks(env)}.role_scope_grants (role_id, scope) VALUES ($1, $2)`,
          [roleId, scope],
        )
      }
      await env.db.sql.unsafe(
        `INSERT INTO ${ks(env)}.role_dimension_grants (role_id, dimension_key, dimension_values)
         VALUES ($1, '*', '["*"]'::jsonb)`,
        [roleId],
      )

      const adminEmail = `a4-admin-${Date.now()}@org.test`
      const adminPassword = "Pass1234!"
      const passwordHash = await hashPassword(adminPassword)
      const userRows = await env.db.sql.unsafe(
        `INSERT INTO ${ks(env)}.users (id, org_id, email, name, password_hash, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'A4 admin', $3, 'active', now(), now()) RETURNING id`,
        [orgIdB, adminEmail, passwordHash],
      )
      const adminUserId = userRows[0].id as string
      await env.db.sql.unsafe(
        `INSERT INTO ${ks(env)}.user_roles (user_id, role_id, org_id) VALUES ($1, $2, $3)`,
        [adminUserId, roleId, orgIdB],
      )

      // Login → token. Login does not call ensureAppsForOrg, but
      // /api/attention-items does — hit it once to register tickets handlers
      // (incl. webhook) for org B.
      const login = await api(env.serverUrl, "/api/auth/login", {
        body: { email: adminEmail, password: adminPassword },
      })
      if (login.status !== 200) {
        throw new Error(`A4 login failed: ${login.status} ${JSON.stringify(login.body)}`)
      }
      const adminToken = login.body.data.accessToken
      const init = await api(env.serverUrl, "/api/attention-items", {
        token: adminToken,
      })
      if (init.status !== 200) {
        throw new Error(`A4 ensureAppsForOrg failed for org B: ${JSON.stringify(init.body)}`)
      }

      const accountB = `a4b-${Date.now()}@org.test`
      const caB = await seedConnectedAccount(env, {
        orgId: orgIdB,
        email: accountB,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      await env.db.sql.unsafe(
        `UPDATE ${ks(env)}.connected_accounts
          SET metadata = jsonb_build_object('gmail', jsonb_build_object('historyId', '900'))
          WHERE id = $1`,
        [caB.id],
      )
      await seedInbox(env, {
        orgId: orgIdB,
        connectedAccountId: caB.id,
        emailAddress: accountB,
        name: "A4 org B inbox",
      })

      // Seed a ticket with a known handle in org A.
      const inboxA = await seedInbox(env, {
        orgId: world.org.id,
        emailAddress: `a4a-${Date.now()}@org.test`,
        name: "A4 org A inbox",
      })
      const ticketA = await seedTicket(env, {
        orgId: world.org.id,
        subject: `A4 origA ${Date.now()}`,
        sourceInboxId: inboxA.id,
      })

      // Push to org B with org A's handle in the subject and no token/in-reply-to.
      gmailFixture.queueHistory(accountB, {
        history: [{ id: "1000", messagesAdded: [{ message: { id: "g4" } }] }],
        historyId: "1000",
      })
      const subject = `Re: [#${ticketA.handle}] A4 ${Date.now()}`
      gmailFixture.queueMessage(
        accountB,
        "g4",
        gmailMessageFixture({
          id: "g4",
          from: "alice@cust.test",
          to: accountB,
          subject,
          body: "body",
        }),
      )
      const res = await postGmailPush({
        accountEmail: accountB,
        historyId: "1000",
        pubsubMessageId: `pm-a4-${Date.now()}`,
        orgId: orgIdB,
      })
      const pushBody = await res.text()
      if (res.status !== 200) {
        const audit = await env.db.sql.unsafe(
          `SELECT action, metadata FROM ${ks(env)}.audit_log WHERE org_id = $1 ORDER BY id DESC LIMIT 5`,
          [orgIdB],
        )
        throw new Error(
          `A4 push expected 200, got ${res.status}: ${pushBody}; audit=${JSON.stringify(audit)}`,
        )
      }

      // Org A's ticket message_count must remain 0 (handle did not cross orgs).
      const orgAMsgs = await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ts(env)}.messages WHERE org_id = $1 AND ticket_id = $2`,
        [world.org.id, ticketA.id],
      )
      expect(orgAMsgs[0].n).toBe(0)

      // Org B got a new ticket with the submitted subject.
      const orgBTicket = await awaitTicketRow(`org_id = $1 AND subject = $2`, [orgIdB, subject])
      if (!orgBTicket) {
        const allOrgB = await env.db.sql.unsafe(
          `SELECT id, subject FROM ${ts(env)}.tickets WHERE org_id = $1 ORDER BY created_at DESC LIMIT 5`,
          [orgIdB],
        )
        const fixtureLog = gmailFixture.requests().filter((r) => r.account === accountB)
        const audit = await env.db.sql.unsafe(
          `SELECT action, metadata FROM ${ks(env)}.audit_log WHERE org_id = $1 AND app = 'tickets' ORDER BY id DESC LIMIT 5`,
          [orgIdB],
        )
        throw new Error(
          `A4: orgB ticket not found. push body: ${pushBody}. orgB tickets: ${JSON.stringify(allOrgB)}. fixture: ${JSON.stringify(fixtureLog)}. audit: ${JSON.stringify(audit)}`,
        )
      }
      expect(orgBTicket).not.toBeNull()
    }, 60_000)
  })

  describe("A5 merge resolution forwards inbound to leaf", () => {
    it("inbound to merged ticket A's reply token routes to leaf ticket B", async () => {
      const accountEmail = `a5-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      await env.db.sql.unsafe(
        `UPDATE ${ks(env)}.connected_accounts
          SET metadata = jsonb_build_object('gmail', jsonb_build_object('historyId', '1100'))
          WHERE id = $1`,
        [ca.id],
      )
      const inbox = await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "A5 inbox",
      })
      const ticketB = await seedTicket(env, {
        orgId: world.org.id,
        subject: `A5 leaf ${Date.now()}`,
        sourceInboxId: inbox.id,
        status: "open",
      })
      const ticketA = await seedTicket(env, {
        orgId: world.org.id,
        subject: `A5 merged ${Date.now()}`,
        sourceInboxId: inbox.id,
        status: "closed",
        closedReason: "merged",
        mergedIntoTicketId: ticketB.id,
      })

      const [local, domain] = accountEmail.split("@")
      const tokenAddr = `${local}+tkt_${ticketA.replyToken}@${domain}`
      gmailFixture.queueHistory(accountEmail, {
        history: [{ id: "1200", messagesAdded: [{ message: { id: "g5" } }] }],
        historyId: "1200",
      })
      gmailFixture.queueMessage(
        accountEmail,
        "g5",
        gmailMessageFixture({
          id: "g5",
          from: "alice@cust.test",
          to: tokenAddr,
          subject: "Re: anything",
          body: "merged-routed",
        }),
      )
      const res = await postGmailPush({
        accountEmail,
        historyId: "1200",
        pubsubMessageId: `pm-a5-${Date.now()}`,
      })
      expect(res.status).toBe(200)

      const aMsgs = await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ts(env)}.messages WHERE org_id = $1 AND ticket_id = $2`,
        [world.org.id, ticketA.id],
      )
      expect(aMsgs[0].n).toBe(0)
      const bMsgs = await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ts(env)}.messages WHERE org_id = $1 AND ticket_id = $2 AND kind = 'inbound'`,
        [world.org.id, ticketB.id],
      )
      expect(bMsgs[0].n).toBe(1)
    }, 60_000)
  })

  describe("A6 advisory lock serializes concurrent appends", () => {
    it("two concurrent pushes against same ticket result in exactly 2 inbound messages", async () => {
      const accountEmail = `a6-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      await env.db.sql.unsafe(
        `UPDATE ${ks(env)}.connected_accounts
          SET metadata = jsonb_build_object('gmail', jsonb_build_object('historyId', '1300'))
          WHERE id = $1`,
        [ca.id],
      )
      const inbox = await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "A6 inbox",
      })
      const seeded = await seedTicket(env, {
        orgId: world.org.id,
        subject: `A6 race ${Date.now()}`,
        sourceInboxId: inbox.id,
        status: "open",
      })
      const [local, domain] = accountEmail.split("@")
      const tokenAddr = `${local}+tkt_${seeded.replyToken}@${domain}`

      // Two distinct messages addressed to the ticket via reply token, same history.
      gmailFixture.queueHistory(accountEmail, {
        history: [{ id: "1400", messagesAdded: [{ message: { id: "g6a" } }] }],
        historyId: "1400",
      })
      gmailFixture.queueHistory(accountEmail, {
        history: [{ id: "1500", messagesAdded: [{ message: { id: "g6b" } }] }],
        historyId: "1500",
      })
      gmailFixture.queueMessage(
        accountEmail,
        "g6a",
        gmailMessageFixture({
          id: "g6a",
          from: "alice@cust.test",
          to: tokenAddr,
          subject: "race A",
          body: "body A",
        }),
      )
      gmailFixture.queueMessage(
        accountEmail,
        "g6b",
        gmailMessageFixture({
          id: "g6b",
          from: "alice@cust.test",
          to: tokenAddr,
          subject: "race B",
          body: "body B",
        }),
      )
      const r1 = postGmailPush({
        accountEmail,
        historyId: "1400",
        pubsubMessageId: `pm-a6a-${Date.now()}`,
      })
      const r2 = postGmailPush({
        accountEmail,
        historyId: "1500",
        pubsubMessageId: `pm-a6b-${Date.now()}`,
      })
      const [res1, res2] = await Promise.all([r1, r2])
      expect(res1.status).toBe(200)
      expect(res2.status).toBe(200)

      // Wait for both to land.
      const start = Date.now()
      let count = 0
      while (Date.now() - start < 45_000) {
        const rows = await env.db.sql.unsafe(
          `SELECT count(*)::int AS n FROM ${ts(env)}.messages WHERE org_id = $1 AND ticket_id = $2 AND kind = 'inbound'`,
          [world.org.id, seeded.id],
        )
        count = rows[0].n
        if (count >= 2) break
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(count).toBe(2)
    }, 60_000)
  })

  describe("A8 duplicate Gmail Push delivery dropped", () => {
    it("two sequential pushes with the same external_message_id create one inbound", async () => {
      const accountEmail = `a8-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      await env.db.sql.unsafe(
        `UPDATE ${ks(env)}.connected_accounts
          SET metadata = jsonb_build_object('gmail', jsonb_build_object('historyId', '1600'))
          WHERE id = $1`,
        [ca.id],
      )
      await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "A8 inbox",
      })
      const subject = `A8 dup ${Date.now()}`
      const externalId = `a8-dup-${Date.now()}`
      // Queue identical message responses for two history responses.
      for (const historyId of ["1700", "1700"]) {
        gmailFixture.queueHistory(accountEmail, {
          history: [{ id: historyId, messagesAdded: [{ message: { id: externalId } }] }],
          historyId,
        })
        gmailFixture.queueMessage(
          accountEmail,
          externalId,
          gmailMessageFixture({
            id: externalId,
            from: "alice@cust.test",
            to: accountEmail,
            subject,
            body: "dup",
          }),
        )
      }
      const r1 = await postGmailPush({
        accountEmail,
        historyId: "1700",
        pubsubMessageId: `pm-a8-1-${Date.now()}`,
      })
      expect(r1.status).toBe(200)
      const r2 = await postGmailPush({
        accountEmail,
        historyId: "1700",
        pubsubMessageId: `pm-a8-2-${Date.now()}`,
      })
      expect(r2.status).toBe(200)

      const ticket = await awaitTicketRow(`org_id = $1 AND subject = $2`, [world.org.id, subject])
      expect(ticket).not.toBeNull()
      if (!ticket) throw new Error("Expected A8 ticket to be created")
      const msgs = await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ts(env)}.messages WHERE org_id = $1 AND ticket_id = $2 AND kind = 'inbound'`,
        [world.org.id, ticket.id as string],
      )
      expect(msgs[0].n).toBe(1)
    }, 60_000)
  })

  describe("A12 Gmail incremental cron creates ticket via cron path", () => {
    it("triggerCronJob('gmail-incremental-sync') runs matcher and advances cursor", async () => {
      const accountEmail = `a12-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      await env.db.sql.unsafe(
        `UPDATE ${ks(env)}.connected_accounts
          SET metadata = jsonb_build_object('gmail', jsonb_build_object('historyId', '1800'))
          WHERE id = $1`,
        [ca.id],
      )
      await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "A12 inbox",
      })
      const subject = `A12 cron ${Date.now()}`
      gmailFixture.queueHistory(accountEmail, {
        history: [{ id: "1900", messagesAdded: [{ message: { id: "g12" } }] }],
        historyId: "1900",
      })
      gmailFixture.queueMessage(
        accountEmail,
        "g12",
        gmailMessageFixture({
          id: "g12",
          from: "alice@cust.test",
          to: accountEmail,
          subject,
          body: "via cron",
        }),
      )

      const { triggerCronJob } = await import("./helpers/run-cron")
      await triggerCronJob(env, "app-tickets", "gmail-incremental-sync", {
        orgId: world.org.id,
        connectedAccountId: ca.id,
      })
      const ticket = await awaitTicketRow(`org_id = $1 AND subject = $2`, [world.org.id, subject])
      expect(ticket).not.toBeNull()

      // The cron job processes messages, then writes the new historyId
      // cursor. `awaitTicketRow` above resolves the moment the ticket row
      // lands; the cursor UPDATE can still be in-flight in the worker. Poll
      // until the cursor advances rather than racing it.
      const deadline = Date.now() + 5000
      let historyId: string | undefined
      while (Date.now() < deadline) {
        const cursorRow = await env.db.sql.unsafe(
          `SELECT metadata FROM ${ks(env)}.connected_accounts WHERE id = $1`,
          [ca.id],
        )
        const meta = cursorRow[0]?.metadata as { gmail?: { historyId?: string } }
        historyId = meta?.gmail?.historyId
        if (historyId === "1900") break
        await Bun.sleep(100)
      }
      expect(historyId).toBe("1900")

      const calls = gmailFixture.requests().filter((r) => r.account === accountEmail)
      expect(calls.some((c) => c.route === "history.list")).toBe(true)
      expect(calls.some((c) => c.route === "messages.get")).toBe(true)
    }, 60_000)
  })

  describe("A13 Gmail Push invalid OIDC is rejected", () => {
    it("missing bearer returns 401, no fixture call, no ticket inserted", async () => {
      const accountEmail = `a13-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "A13 inbox",
      })
      const before = gmailFixture.requests().length
      const url = `${env.serverUrl}/webhooks/${world.org.id}/tickets/gmail-push`
      const data = Buffer.from(
        JSON.stringify({ emailAddress: accountEmail, historyId: "9999" }),
      ).toString("base64")
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            data,
            messageId: `pm-a13-${Date.now()}`,
            publishTime: new Date().toISOString(),
          },
          subscription: "projects/liaison-test/subscriptions/gmail-push",
        }),
      })
      expect(res.status).toBe(401)
      // No new fixture calls were made for this account.
      const after = gmailFixture
        .requests()
        .slice(before)
        .filter((r) => r.account === accountEmail)
      expect(after.length).toBe(0)
      const tickets = await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ts(env)}.tickets WHERE org_id = $1 AND subject ILIKE 'A13%'`,
        [world.org.id],
      )
      expect(tickets[0].n).toBe(0)
    }, 15_000)
  })

  describe("A11 inbound latency rows are queryable for Push and IMAP", () => {
    it("Gmail Push and IMAP cron each leave at least one queryable inbound message with non-negative latency", async () => {
      const redis = fixtureRedis()
      const { triggerCronJob } = await import("./helpers/run-cron")
      const startedAt = new Date(Date.now() - 1000).toISOString()

      // Gmail Push path.
      const gmailEmail = `a11g-${Date.now()}@org.test`
      const caG = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: gmailEmail,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      await env.db.sql.unsafe(
        `UPDATE ${ks(env)}.connected_accounts
          SET metadata = jsonb_build_object('gmail', jsonb_build_object('historyId', '2000'))
          WHERE id = $1`,
        [caG.id],
      )
      await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: caG.id,
        emailAddress: gmailEmail,
        name: "A11 gmail inbox",
      })
      const gSubject = `A11 push ${Date.now()}`
      gmailFixture.queueHistory(gmailEmail, {
        history: [{ id: "2100", messagesAdded: [{ message: { id: "g11" } }] }],
        historyId: "2100",
      })
      gmailFixture.queueMessage(
        gmailEmail,
        "g11",
        gmailMessageFixture({
          id: "g11",
          from: "alice@cust.test",
          to: gmailEmail,
          subject: gSubject,
          body: "latency-gmail",
        }),
      )
      const pushRes = await postGmailPush({
        accountEmail: gmailEmail,
        historyId: "2100",
        pubsubMessageId: `pm-a11g-${Date.now()}`,
      })
      expect(pushRes.status).toBe(200)
      await awaitTicketRow(`org_id = $1 AND subject = $2`, [world.org.id, gSubject])

      // IMAP path.
      const imapEmail = `a11i-${Date.now()}@org.test`
      const caI = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: imapEmail,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: caI.id,
        emailAddress: imapEmail,
        name: "A11 imap inbox",
      })
      const iSubject = `A11 imap ${Date.now()}`
      const queueKey = `${env.redisPrefix}tickets:imap-fixture:${imapEmail.toLowerCase()}:queue`
      await redis.rpush(
        queueKey,
        JSON.stringify({
          messageId: `<a11i-${Date.now()}@cust.test>`,
          subject: iSubject,
          from: { email: "alice@cust.test", name: "Alice" },
          to: [{ email: imapEmail }],
          textBody: "latency-imap",
          sentAt: new Date().toISOString(),
        }),
      )
      await triggerCronJob(env, "app-tickets", "imap-incremental-sync", {
        orgId: world.org.id,
        connectedAccountId: caI.id,
      })
      await awaitTicketRow(`org_id = $1 AND subject = $2`, [world.org.id, iSubject])

      // Latency-row smoke: messages joined to source_account_id with non-negative latency.
      const gRows = await env.db.sql.unsafe(
        `SELECT EXTRACT(EPOCH FROM (m.created_at - COALESCE(m.sent_at, m.created_at))) * 1000 AS lat_ms
           FROM ${ts(env)}.messages m
           JOIN ${ts(env)}.tickets t ON t.id = m.ticket_id
          WHERE m.org_id = $1 AND m.kind = 'inbound'
            AND t.source_account_id = $2
            AND m.created_at >= $3::timestamptz`,
        [world.org.id, caG.id, startedAt],
      )
      expect(gRows.length).toBeGreaterThanOrEqual(1)
      for (const r of gRows) {
        expect(Number(r.lat_ms)).toBeGreaterThanOrEqual(-1000)
      }
      const iRows = await env.db.sql.unsafe(
        `SELECT EXTRACT(EPOCH FROM (m.created_at - COALESCE(m.sent_at, m.created_at))) * 1000 AS lat_ms
           FROM ${ts(env)}.messages m
           JOIN ${ts(env)}.tickets t ON t.id = m.ticket_id
          WHERE m.org_id = $1 AND m.kind = 'inbound'
            AND t.source_account_id = $2
            AND m.created_at >= $3::timestamptz`,
        [world.org.id, caI.id, startedAt],
      )
      expect(iRows.length).toBeGreaterThanOrEqual(1)
      for (const r of iRows) {
        expect(Number(r.lat_ms)).toBeGreaterThanOrEqual(-1000)
      }
    }, 60_000)
  })

  describe("A10 IMAP UIDVALIDITY change clears cursor and enqueues initial sync", () => {
    it("UIDVALIDITY change → metadata.imap.cursor cleared, uidValidity advanced", async () => {
      const redis = fixtureRedis()
      const { triggerCronJob } = await import("./helpers/run-cron")
      const accountEmail = `a10-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "A10 inbox",
      })
      const lower = accountEmail.toLowerCase()
      const queueKey = `${env.redisPrefix}tickets:imap-fixture:${lower}:queue`
      const uidValidityKey = `${env.redisPrefix}tickets:imap-fixture:${lower}:uidValidity`

      // Pre-seed the connected account metadata as if a prior sync had committed UIDVALIDITY=1.
      await env.db.sql.unsafe(
        `UPDATE ${ks(env)}.connected_accounts
          SET metadata = jsonb_build_object('imap', jsonb_build_object('uidValidity', '1', 'cursor', 'old-cursor'))
          WHERE id = $1`,
        [ca.id],
      )
      // Set fixture's UIDVALIDITY to 2 with one queued message.
      await redis.set(uidValidityKey, "2")
      await redis.rpush(
        queueKey,
        JSON.stringify({
          messageId: `<a10-${Date.now()}@cust.test>`,
          subject: `A10 ${Date.now()}`,
          from: { email: "alice@cust.test" },
          to: [{ email: accountEmail }],
          textBody: "post-uidvalidity",
          sentAt: new Date().toISOString(),
        }),
      )

      await triggerCronJob(env, "app-tickets", "imap-incremental-sync", {
        orgId: world.org.id,
        connectedAccountId: ca.id,
      })

      // Poll for metadata to flip — incremental sync detects mismatch and saves only uidValidity.
      const start = Date.now()
      let meta: { imap?: { uidValidity?: string; cursor?: string } } | undefined
      while (Date.now() - start < 45_000) {
        const rows = await env.db.sql.unsafe(
          `SELECT metadata FROM ${ks(env)}.connected_accounts WHERE id = $1`,
          [ca.id],
        )
        meta = rows[0]?.metadata as { imap?: { uidValidity?: string; cursor?: string } } | undefined
        if (meta?.imap?.uidValidity === "2") break
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(meta?.imap?.uidValidity).toBe("2")
      // The incremental sync drops the old cursor and enqueues the initial
      // sync, which writes a fresh one: by the time the poll sees UIDVALIDITY 2
      // the cursor is either still cleared or already the new one. It is never
      // the cursor of the old UIDVALIDITY.
      expect(meta?.imap?.cursor).not.toBe("old-cursor")
    }, 60_000)
  })

  describe("A9 IMAP incremental cron creates a ticket via Redis fixture", () => {
    it("staged IMAP messages drive matcher when imap-incremental-sync runs", async () => {
      const redis = fixtureRedis()
      const accountEmail = `a9-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      const inbox = await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "A9 inbox",
      })
      const subject = `A9 imap ${Date.now()}`
      const queueKey = `${env.redisPrefix}tickets:imap-fixture:${accountEmail.toLowerCase()}:queue`
      await redis.rpush(
        queueKey,
        JSON.stringify({
          messageId: `<a9-${Date.now()}@cust.test>`,
          subject,
          from: { email: "alice@cust.test", name: "Alice" },
          to: [{ email: accountEmail }],
          textBody: "imap inbound",
          sentAt: new Date().toISOString(),
        }),
      )

      const { triggerCronJob } = await import("./helpers/run-cron")
      await triggerCronJob(env, "app-tickets", "imap-incremental-sync", {
        orgId: world.org.id,
        connectedAccountId: ca.id,
      })

      const ticket = await awaitTicketRow(`org_id = $1 AND subject = $2`, [world.org.id, subject])
      expect(ticket).not.toBeNull()
      expect(ticket?.source_inbox_id).toBe(inbox.id)
    }, 60_000)
  })
})
