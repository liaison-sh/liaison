// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `unverifiedSubmitter: true` on a SERVER-key ticket create. A server key is a
// trusted caller: it links the ticket to an existing org contact found by the
// typed `fromEmail` (and may write a name onto it), and its acknowledgement
// echoes the subject with no per-source cap. A backend that relays anonymous
// visitors (a public support form behind a relay) must not get that trust, so
// it declares its submitter unverified. Proves the flag only RESTRICTS: no
// contact linking, the per-source create buckets, the fixed-subject ack and its
// per-source cap; while team, staged attachments and externalRef keep working.
//
// `sendOutbound` is mocked by spreading an EAGER snapshot of the real module
// and restoring it in afterAll (mock.module leaks past this file under bun's
// flat test process; ack.test.ts explains why the snapshot must be eager).

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import * as realSend from "~/apps/tickets/send"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { redis } from "~/lib/redis"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { ensureAppsForOrg } from "~/modules/apps/init"

const realSendModule = { ...realSend }

const sendCalls: Array<{ to: string; subject: string }> = []
mock.module("~/apps/tickets/send", () => ({
  ...realSendModule,
  sendOutbound: async (email: { to: unknown; subject: string }) => {
    sendCalls.push({ to: JSON.stringify(email.to), subject: email.subject })
    return {
      externalMessageId: `<unverified-ack-${sendCalls.length}@test>`,
      deliveryState: "delivered" as const,
      rfc2822: "",
    }
  },
}))

afterAll(() => {
  mock.module("~/apps/tickets/send", () => realSendModule)
})

const { ticketsPublicRoutes } = await import("./tickets-public")
const app = new Hono().route("/webhooks", ticketsPublicRoutes)

const rows = (r: unknown): any[] => (r as any).rows ?? r

const BROWSER_ORIGIN = "https://form.unverified.test"
const ZEBRA = "Zebra-subject-42"

let orgId: string
let inboxId: string
let serverKey: string
let browserKey: string

function seedKeyRow(
  tx: { execute: (q: ReturnType<typeof drizzleSql>) => Promise<unknown> },
  plaintext: string,
  origins: string[],
  keyInboxId: string | null,
): Promise<unknown> {
  return tx.execute(drizzleSql`
    INSERT INTO app_tickets.api_keys
      (org_id, key_hash, key_prefix, label, allowed_origins, inbox_id, created_by)
    VALUES (
      ${orgId}, ${createHash("sha256").update(plaintext).digest("hex")}, ${plaintext.slice(0, 8)},
      'unverified test key', ${JSON.stringify(origins)}::jsonb, ${keyInboxId},
      '00000000-0000-0000-0000-000000000000'
    )
  `)
}

beforeAll(async () => {
  const slug = `unverified-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  serverKey = `srv-${randomUUID()}`
  browserKey = `brw-${randomUUID()}`
  await withSystemDb("tickets-unverified-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Unverified Submitter', ${slug}) RETURNING id`),
    )[0].id
    const userId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id`),
    )[0].id
    const accountId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by, access_token_encrypted)
        VALUES (gen_random_uuid(), ${orgId}, 'tickets', 'gmail', 'org', null, 'oauth2', 'support@unverified.test', 'active', ${userId}, 'enc')
        RETURNING id`),
    )[0].id
    // A mailbox inbox with acknowledgements on, and the org default so the
    // anonymous (generic route) case has somewhere to land.
    inboxId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes
          (id, org_id, kind, connected_account_id, name, email_address, from_display_name,
           ack_enabled, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'mailbox', ${accountId}, 'Support', 'support@unverified.test',
                'Unverified Support', true, true, now(), now())
        RETURNING id`),
    )[0].id
    await seedKeyRow(tx as never, serverKey, [], null)
    await seedKeyRow(tx as never, browserKey, [BROWSER_ORIGIN], inboxId)
  })
  await ensureAppsForOrg(orgId, {})
}, 60_000)

beforeEach(() => {
  sendCalls.length = 0
})

// A fresh documentation-range address per call, so no rate-limit bucket is
// shared with another test. In-process requests have no socket, so the address
// rides on the header the Bun server sets from the socket peer; with
// TRUSTED_PROXY_HOPS = 0 (the test default) it is the client address.
function freshIp(): string {
  const h = () => Math.floor(Math.random() * 0xffff).toString(16)
  return `2001:db8::${h()}:${h()}:${h()}`
}

const freshAddress = () => `ack-${randomUUID()}@example.test`

function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: `Help ${randomUUID()}`,
    fromEmail: freshAddress(),
    textBody: `hello ${randomUUID()}`,
    ...extra,
  }
}

function post(
  path: string,
  payload: unknown,
  opts: { key?: string; ip?: string; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-bun-socket-ip": opts.ip ?? freshIp(),
  }
  if (opts.key) headers.authorization = `Bearer ${opts.key}`
  if (opts.origin) headers.origin = opts.origin
  return Promise.resolve(
    app.fetch(
      new Request(`http://x/webhooks/${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }),
    ),
  )
}

const inboxCreate = (payload: unknown, opts: { key?: string; ip?: string; origin?: string } = {}) =>
  post(`${orgId}/inboxes/${inboxId}/tickets/create`, payload, { key: serverKey, ...opts })

async function seedNamelessContact(email: string): Promise<string> {
  return withPrivilegedDb(
    orgId,
    "tickets-unverified-contact",
    async (tx) =>
      rows(
        await tx.execute(drizzleSql`
        INSERT INTO kernel.contacts (id, org_id, handle, name, email, org_access)
        VALUES (gen_random_uuid(), ${orgId}, ${`c-${randomUUID().slice(0, 12)}`}, NULL, ${email}, 'editor')
        RETURNING id`),
      )[0].id,
  )
}

async function ticketRow(ticketId: string): Promise<{
  contact_id: string | null
  team: string | null
}> {
  return extractRows<{ contact_id: string | null; team: string | null }>(
    await withPrivilegedDb(orgId, "tickets-unverified-ticket", (tx) =>
      tx.execute(
        drizzleSql`SELECT contact_id, team FROM app_tickets.tickets WHERE id = ${ticketId}::uuid AND org_id = ${orgId}`,
      ),
    ),
  )[0]!
}

async function contactName(contactId: string): Promise<string | null> {
  return extractRows<{ name: string | null }>(
    await withPrivilegedDb(orgId, "tickets-unverified-contact-name", (tx) =>
      tx.execute(drizzleSql`SELECT name FROM kernel.contacts WHERE id = ${contactId}::uuid`),
    ),
  )[0]!.name
}

describe("unverifiedSubmitter: contact linking", () => {
  it("a server key that declares its submitter unverified links no contact and writes no name", async () => {
    const email = freshAddress()
    const contactId = await seedNamelessContact(email)
    const res = await inboxCreate(
      body({ fromEmail: email, fromName: "Mallory", unverifiedSubmitter: true }),
    )
    expect(res.status).toBe(200)
    const data = ((await res.json()) as any).data
    expect((await ticketRow(data.ticketId)).contact_id).toBeNull()
    expect(await contactName(contactId)).toBeNull()
  })

  it("control: the same request without the flag links the contact and names it", async () => {
    const email = freshAddress()
    const contactId = await seedNamelessContact(email)
    const res = await inboxCreate(body({ fromEmail: email, fromName: "Mallory" }))
    expect(res.status).toBe(200)
    const data = ((await res.json()) as any).data
    expect((await ticketRow(data.ticketId)).contact_id).toBe(contactId)
    expect(await contactName(contactId)).toBe("Mallory")
  })
})

describe("unverifiedSubmitter: acknowledgement", () => {
  it("the acknowledgement does not echo the subject the submitter typed", async () => {
    const email = freshAddress()
    const res = await inboxCreate(
      body({ subject: ZEBRA, fromEmail: email, unverifiedSubmitter: true }),
    )
    expect(res.status).toBe(200)
    expect(sendCalls.length).toBe(1)
    expect(sendCalls[0]!.to).toContain(email)
    expect(sendCalls[0]!.subject).not.toContain(ZEBRA)
  })

  it("control: without the flag the acknowledgement echoes the subject", async () => {
    const email = freshAddress()
    const res = await inboxCreate(body({ subject: ZEBRA, fromEmail: email }))
    expect(res.status).toBe(200)
    expect(sendCalls.length).toBe(1)
    expect(sendCalls[0]!.to).toContain(email)
    expect(sendCalls[0]!.subject).toContain(ZEBRA)
  })

  it("the per-source acknowledgement cap applies to the forwarded visitor address", async () => {
    const ipX = freshIp()
    // Spend source X's acknowledgement bucket, with the identifier and window
    // `sendTicketAcknowledgement` uses (apps/tickets/tools.ts). 50 is well above
    // ACK_LIMITS.sourceHour (20), so the bucket is full whatever its limit.
    for (let i = 0; i < 50; i++) {
      await checkRateLimit(redis, [
        { identifier: `tickets:ack:src:${orgId}:${ipX}:hour`, limit: 1000, windowSeconds: 3600 },
      ])
    }

    const fromX = await inboxCreate(body({ unverifiedSubmitter: true }), { ip: ipX })
    expect(fromX.status).toBe(200)
    expect(sendCalls.length).toBe(0)

    const fromY = await inboxCreate(body({ unverifiedSubmitter: true }), { ip: freshIp() })
    expect(fromY.status).toBe(200)
    expect(sendCalls.length).toBe(1)

    // The trusted path has no per-source cap: that is what the flag changes.
    const trustedFromX = await inboxCreate(body(), { ip: ipX })
    expect(trustedFromX.status).toBe(200)
    expect(sendCalls.length).toBe(2)
  })
})

describe("unverifiedSubmitter: per-source create buckets", () => {
  it("six creates from one visitor address within a minute: the sixth is refused", async () => {
    const ip = freshIp()
    const statuses: number[] = []
    let lastCode: string | undefined
    for (let i = 0; i < 6; i++) {
      const res = await inboxCreate(
        body({ unverifiedSubmitter: true, externalRef: `src-${randomUUID()}` }),
        { ip },
      )
      statuses.push(res.status)
      if (res.status !== 200) lastCode = ((await res.json()) as any).error.code
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200])
    expect(statuses[5]).toBe(429)
    expect(lastCode).toBe("rate_limited")
  })

  it("control: six creates from ONE address with the server key and no flag all succeed (no per-source cap)", async () => {
    const ip = freshIp()
    for (let i = 0; i < 6; i++) {
      const res = await inboxCreate(body({ externalRef: `trusted-${randomUUID()}` }), { ip })
      expect(res.status).toBe(200)
    }
  })

  it("six creates from six different addresses all succeed", async () => {
    for (let i = 0; i < 6; i++) {
      const res = await inboxCreate(
        body({ unverifiedSubmitter: true, externalRef: `src-${randomUUID()}` }),
      )
      expect(res.status).toBe(200)
    }
  })
})

describe("unverifiedSubmitter: server powers are kept", () => {
  it("team, staged attachments and externalRef still work with the flag", async () => {
    const form = new FormData()
    form.set("file", new File([new Uint8Array([1, 2, 3])], "receipt.txt", { type: "text/plain" }))
    const upload = await app.fetch(
      new Request(`http://x/webhooks/${orgId}/inboxes/${inboxId}/tickets/attachments`, {
        method: "POST",
        headers: { authorization: `Bearer ${serverKey}`, "x-bun-socket-ip": freshIp() },
        body: form,
      }),
    )
    expect(upload.status).toBe(200)
    const fileId = ((await upload.json()) as any).data.fileId as string

    const externalRef = `support-form:${randomUUID()}`
    const payload = body({
      team: "Passage du Havre",
      attachmentFileIds: [fileId],
      externalRef,
      unverifiedSubmitter: true,
    })
    const res = await inboxCreate(payload)
    expect(res.status).toBe(200)
    const data = ((await res.json()) as any).data
    expect(data.submitter).toBe("unverified")
    expect((await ticketRow(data.ticketId)).team).toBe("Passage du Havre")

    const file = extractRows<{ entity_type: string }>(
      await withPrivilegedDb(orgId, "tickets-unverified-file", (tx) =>
        tx.execute(drizzleSql`SELECT entity_type FROM kernel.files WHERE id = ${fileId}::uuid`),
      ),
    )[0]!
    expect(file.entity_type).toBe("message")

    const replay = await inboxCreate(payload)
    expect(replay.status).toBe(200)
    const replayData = ((await replay.json()) as any).data
    expect(replayData.idempotent).toBe(true)
    expect(replayData.ticketId).toBe(data.ticketId)
  })
})

describe("unverifiedSubmitter: conflicts and shape", () => {
  it.each([
    ["contactId", { contactId: "6f1c2a4e-1b2c-4d3e-8f40-000000000009" }],
    ["appendIfExisting: true", { appendIfExisting: true, externalRef: `x-${randomUUID()}` }],
    ["appendIfExisting: false", { appendIfExisting: false }],
  ])("refuses the flag together with %s", async (_name, extra) => {
    const res = await inboxCreate(body({ unverifiedSubmitter: true, ...extra }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe("unverified_submitter_conflict")
  })

  it("a refused conflict spends no per-source budget: five conflicts, then a valid flagged create from the same address", async () => {
    const ip = freshIp()
    for (let i = 0; i < 5; i++) {
      const res = await inboxCreate(
        body({ unverifiedSubmitter: true, contactId: "6f1c2a4e-1b2c-4d3e-8f40-000000000009" }),
        { ip },
      )
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error.code).toBe("unverified_submitter_conflict")
    }
    const ok = await inboxCreate(
      body({ unverifiedSubmitter: true, externalRef: `src-${randomUUID()}` }),
      { ip },
    )
    expect(ok.status).toBe(200)
  })

  it.each([
    ["false", false],
    ['"true" (a string)', "true"],
  ])("refuses unverifiedSubmitter: %s", async (_name, value) => {
    const res = await inboxCreate(body({ unverifiedSubmitter: value }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe("validation_failed")
  })
})

describe("unverifiedSubmitter: other tiers", () => {
  it("a browser key may send the flag (a no-op) and is still refused team", async () => {
    const ok = await inboxCreate(body({ unverifiedSubmitter: true }), {
      key: browserKey,
      origin: BROWSER_ORIGIN,
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as any).data.submitter).toBeUndefined()

    const withTeam = await inboxCreate(body({ unverifiedSubmitter: true, team: "Finance" }), {
      key: browserKey,
      origin: BROWSER_ORIGIN,
    })
    expect(withTeam.status).toBe(403)
    expect(((await withTeam.json()) as any).error.code).toBe("browser_key_field_not_allowed")
  })

  it("the anonymous tier ignores the flag and creates as it does today", async () => {
    const email = freshAddress()
    const contactId = await seedNamelessContact(email)
    const res = await post(
      `${orgId}/tickets/create`,
      body({ fromEmail: email, fromName: "Mallory", unverifiedSubmitter: true }),
    )
    expect(res.status).toBe(200)
    const data = ((await res.json()) as any).data
    expect(data.ticketId).toBeTruthy()
    expect(data.submitter).toBeUndefined()
    expect((await ticketRow(data.ticketId)).contact_id).toBeNull()
    expect(await contactName(contactId)).toBeNull()
  })
})

describe("unverifiedSubmitter: response echo", () => {
  it("a fresh create with the flag answers submitter: unverified; without it the key is absent", async () => {
    const flagged = await inboxCreate(body({ unverifiedSubmitter: true }))
    expect(flagged.status).toBe(200)
    expect(((await flagged.json()) as any).data.submitter).toBe("unverified")

    const plain = await inboxCreate(body())
    expect(plain.status).toBe(200)
    expect("submitter" in ((await plain.json()) as any).data).toBe(false)
  })
})
