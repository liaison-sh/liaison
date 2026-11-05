// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Attachment staging (`POST /webhooks/:orgId/tickets/attachments`) and its
// consumption by `POST /webhooks/:orgId/tickets/create` via
// `attachmentFileIds` + `categoryPath`. Proves: upload-then-create reparents
// staged files onto the ticket's first message; oversize upload is 413;
// missing API key is 401; a foreign-org attachment id is rejected 422;
// categoryPath resolves case-insensitively; an unknown categoryPath is 422;
// categoryId wins over categoryPath when both are given.

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import { runAdminOp } from "~/apps/tickets/admin"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { ticketsPublicRoutes } from "./tickets-public"

const app = new Hono().route("/webhooks", ticketsPublicRoutes)
const rows = (r: unknown): any[] => (r as any).rows ?? r

let orgId: string
let userId: string
let orgKey: string // plaintext API key
let orgInboxId: string
let hardwareCategoryId: string
let touchCategoryId: string

let otherOrgId: string
let otherOrgKey: string

async function seedOrgWithKey(
  slug: string,
): Promise<{ orgId: string; userId: string; key: string; inboxId: string }> {
  let seededOrgId = ""
  let seededUserId = ""
  await withSystemDb(`tickets-attachments-fixture-${slug}`, async (tx) => {
    seededOrgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), ${slug}, ${slug}) RETURNING id`),
    )[0].id
    seededUserId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${seededOrgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id`),
    )[0].id
  })
  await ensureAppsForOrg(seededOrgId, {})
  const actor = { actorType: "user" as const, userId: seededUserId }
  const { key, inboxId } = await withPrivilegedDb(
    seededOrgId,
    "tickets-attachments-setup",
    async (tx) => {
      // An "api" kind inbox is a pure receiving bucket (no connected mail account), so it
      // never satisfies the create webhook's default-inbox lookup (which JOINs an ACTIVE
      // connected_accounts row). Tests below pass `sourceInboxId` explicitly instead of
      // relying on default-inbox resolution, matching tickets-public-inbox.test.ts.
      const created_inbox = (await runAdminOp(
        tx as never,
        seededOrgId,
        "inboxesCreate",
        { kind: "api", name: "Webhook" },
        actor,
      )) as any
      const created_key = (await runAdminOp(
        tx as never,
        seededOrgId,
        "apiKeysCreate",
        { label: "org-wide" },
        actor,
      )) as any
      return { key: created_key.key as string, inboxId: created_inbox.id as string }
    },
  )
  return { orgId: seededOrgId, userId: seededUserId, key, inboxId }
}

beforeAll(async () => {
  const slug = `attach-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const seeded = await seedOrgWithKey(slug)
  orgId = seeded.orgId
  userId = seeded.userId
  orgKey = seeded.key
  orgInboxId = seeded.inboxId

  const other = await seedOrgWithKey(`${slug}-other`)
  otherOrgId = other.orgId
  otherOrgKey = other.key

  const actor = { actorType: "user" as const, userId }
  await withPrivilegedDb(orgId, "tickets-attachments-categories", async (tx) => {
    hardwareCategoryId = (
      (await runAdminOp(tx as never, orgId, "categoriesCreate", { name: "Hardware" }, actor)) as any
    ).id
    touchCategoryId = (
      (await runAdminOp(
        tx as never,
        orgId,
        "categoriesCreate",
        { name: "Sensitivity and calibration", parentId: hardwareCategoryId },
        actor,
      )) as any
    ).id
  })
}, 60_000)

function authHeader(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` }
}

async function uploadAttachment(
  org: string,
  key: string,
  file: { name: string; type: string; bytes: Uint8Array },
): Promise<Response> {
  const form = new FormData()
  form.set("file", new File([file.bytes], file.name, { type: file.type }))
  return app.fetch(
    new Request(`http://x/webhooks/${org}/tickets/attachments`, {
      method: "POST",
      headers: authHeader(key),
      body: form,
    }),
  )
}

function postCreate(
  org: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`http://x/webhooks/${org}/tickets/create`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    ),
  )
}

describe("tickets-public attachment upload auth", () => {
  it("401s with no API key", async () => {
    const res = await uploadAttachment(orgId, "", {
      name: "a.txt",
      type: "text/plain",
      bytes: new Uint8Array([1]),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as any
    expect(body.error.code).toBe("invalid_api_key")
  })
})

describe("tickets-public attachment upload size cap", () => {
  it("413s over the 10 MiB cap", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    const res = await uploadAttachment(orgId, orgKey, {
      name: "big.bin",
      type: "application/octet-stream",
      bytes: big,
    })
    expect(res.status).toBe(413)
    const body = (await res.json()) as any
    expect(body.error.code).toBe("payload_too_large")
  })
})

describe("tickets-public attachment upload queues kernel file:create", () => {
  it("emits the standard file:create event so the thumbnail pipeline fires", async () => {
    const res = await uploadAttachment(orgId, orgKey, {
      name: "webhook-img.png",
      type: "image/png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const fileId = body.data.fileId as string
    const events = rows(
      await withSystemDb("tickets-public-attachment-event-check", (tx) =>
        tx.execute(drizzleSql`
          SELECT payload FROM kernel.pending_events
           WHERE org_id = ${orgId}::uuid
             AND payload->>'app' = 'kernel'
             AND payload->>'entity' = 'file'
             AND payload->>'action' = 'create'
             AND payload->>'entityId' = ${fileId}`),
      ),
    )
    expect(events).toHaveLength(1)
    const data = (events[0].payload as any).data
    // Shape the thumbnail consumer filters on: { id, mimeType, storageKey }.
    expect(data.id).toBe(fileId)
    expect(data.mimeType).toBe("image/png")
    expect(String(data.storageKey)).toContain("webhook-img.png")
  })
})

describe("tickets-public upload then create: attachments reparented", () => {
  it("reparents staged files onto the ticket's first message", async () => {
    const up1 = await uploadAttachment(orgId, orgKey, {
      name: "screenshot.png",
      type: "image/png",
      bytes: new Uint8Array([1, 2, 3, 4]),
    })
    expect(up1.status).toBe(200)
    const file1 = ((await up1.json()) as any).data
    expect(file1.fileId).toBeTruthy()
    expect(file1.filename).toBe("screenshot.png")

    const up2 = await uploadAttachment(orgId, orgKey, {
      name: "log.txt",
      type: "text/plain",
      bytes: new Uint8Array([5, 6, 7]),
    })
    expect(up2.status).toBe(200)
    const file2 = ((await up2.json()) as any).data

    const created = await postCreate(
      orgId,
      {
        subject: "Touch sensing is off",
        fromEmail: "customer@x.test",
        sourceInboxId: orgInboxId,
        textBody: "It stopped registering pressure.",
        attachmentFileIds: [file1.fileId, file2.fileId],
      },
      authHeader(orgKey),
    )
    expect(created.status).toBe(200)
    const ticket = ((await created.json()) as any).data
    expect(ticket.ticketId).toBeTruthy()

    const filesRows = await withPrivilegedDb(orgId, "tickets-attachments-assert", async (tx) =>
      extractRows<{ id: string; entity_type: string; entity_id: string; ordinal: number }>(
        await tx.execute(drizzleSql`
          SELECT id, entity_type, entity_id, ordinal FROM kernel.files
          WHERE id IN (${file1.fileId}::uuid, ${file2.fileId}::uuid)
          ORDER BY ordinal ASC
        `),
      ),
    )
    expect(filesRows.length).toBe(2)
    for (const row of filesRows) {
      expect(row.entity_type).toBe("message")
    }
    expect(filesRows[0]!.id).toBe(file1.fileId)
    expect(filesRows[0]!.ordinal).toBe(0)
    expect(filesRows[1]!.id).toBe(file2.fileId)
    expect(filesRows[1]!.ordinal).toBe(1)
    // Both reparented onto the SAME message (the ticket's initial message).
    expect(filesRows[0]!.entity_id).toBe(filesRows[1]!.entity_id)
  })
})

describe("tickets-public attachmentFileIds validation", () => {
  it("rejects an attachment id belonging to another org with 422 unknown_attachment", async () => {
    const uploaded = await uploadAttachment(otherOrgId, otherOrgKey, {
      name: "foreign.txt",
      type: "text/plain",
      bytes: new Uint8Array([9]),
    })
    expect(uploaded.status).toBe(200)
    const foreignFile = ((await uploaded.json()) as any).data

    const res = await postCreate(
      orgId,
      {
        subject: "Cross-org attempt",
        fromEmail: "customer@x.test",
        sourceInboxId: orgInboxId,
        textBody: "hello",
        attachmentFileIds: [foreignFile.fileId],
      },
      authHeader(orgKey),
    )
    expect(res.status).toBe(422)
    const body = (await res.json()) as any
    expect(body.error.code).toBe("unknown_attachment")
  })

  it("rejects an unknown/nonexistent attachment id", async () => {
    const res = await postCreate(
      orgId,
      {
        subject: "Bogus attachment",
        fromEmail: "customer@x.test",
        sourceInboxId: orgInboxId,
        textBody: "hello",
        attachmentFileIds: ["11111111-1111-4111-8111-111111111111"],
      },
      authHeader(orgKey),
    )
    expect(res.status).toBe(422)
    const body = (await res.json()) as any
    expect(body.error.code).toBe("unknown_attachment")
  })
})

describe("tickets-public categoryPath resolution", () => {
  it('resolves case-insensitively ("hardware / sensitivity and calibration")', async () => {
    const res = await postCreate(
      orgId,
      {
        subject: "Pressure sensing broken",
        fromEmail: "customer@x.test",
        sourceInboxId: orgInboxId,
        textBody: "Details.",
        categoryPath: "hardware / sensitivity and calibration",
      },
      authHeader(orgKey),
    )
    expect(res.status).toBe(200)
    const ticket = ((await res.json()) as any).data

    const ticketRow = await withPrivilegedDb(orgId, "tickets-category-assert", async (tx) =>
      extractRows<{ category_id: string }>(
        await tx.execute(drizzleSql`
          SELECT category_id FROM app_tickets.tickets WHERE id = ${ticket.ticketId}::uuid
        `),
      ),
    )
    expect(ticketRow[0]!.category_id).toBe(touchCategoryId)
  })

  it("returns 422 unknown_category for an unresolvable path", async () => {
    const res = await postCreate(
      orgId,
      {
        subject: "Nonsense category",
        fromEmail: "customer@x.test",
        sourceInboxId: orgInboxId,
        textBody: "Details.",
        categoryPath: "Not A Real Category / At All",
      },
      authHeader(orgKey),
    )
    expect(res.status).toBe(422)
    const body = (await res.json()) as any
    expect(body.error.code).toBe("unknown_category")
  })

  it("categoryId wins over categoryPath when both are given", async () => {
    const res = await postCreate(
      orgId,
      {
        subject: "Both category fields",
        fromEmail: "customer@x.test",
        sourceInboxId: orgInboxId,
        textBody: "Details.",
        categoryId: hardwareCategoryId,
        categoryPath: "hardware / sensitivity and calibration",
      },
      authHeader(orgKey),
    )
    expect(res.status).toBe(200)
    const ticket = ((await res.json()) as any).data

    const ticketRow = await withPrivilegedDb(
      orgId,
      "tickets-category-precedence-assert",
      async (tx) =>
        extractRows<{ category_id: string }>(
          await tx.execute(drizzleSql`
          SELECT category_id FROM app_tickets.tickets WHERE id = ${ticket.ticketId}::uuid
        `),
        ),
    )
    // categoryId (hardwareCategoryId) must win, NOT the categoryPath's resolved touchCategoryId.
    expect(ticketRow[0]!.category_id).toBe(hardwareCategoryId)
  })
})

describe("tickets-public pre-authentication throttle", () => {
  const randomIp = () =>
    `198.51.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`

  async function junkKeyCreate(ip: string, path: string): Promise<Response> {
    return app.fetch(
      new Request(`http://x/webhooks/${orgId}/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer junk-key-not-a-real-key",
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ subject: "s", fromEmail: "a@b.test", textBody: "t" }),
      }),
    )
  }

  it("cuts a caller off after repeated failed key lookups, before spending a lookup per request", async () => {
    const ip = randomIp()
    const statuses: number[] = []
    for (let i = 0; i < 26; i++) statuses.push((await junkKeyCreate(ip, "tickets/create")).status)
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true)
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true)
  })

  it("applies the same cut-off to the attachment upload route", async () => {
    const ip = randomIp()
    const statuses: number[] = []
    for (let i = 0; i < 23; i++) {
      const res = await app.fetch(
        new Request(`http://x/webhooks/${orgId}/tickets/attachments`, {
          method: "POST",
          headers: { authorization: "Bearer junk", "x-forwarded-for": ip },
          body: new FormData(),
        }),
      )
      statuses.push(res.status)
    }
    expect(statuses.at(-1)).toBe(429)
  })

  it("does not count a caller who authenticates correctly", async () => {
    const ip = randomIp()
    for (let i = 0; i < 25; i++) {
      const res = await app.fetch(
        new Request(`http://x/webhooks/${orgId}/tickets/attachments`, {
          method: "POST",
          headers: { ...authHeader(orgKey), "x-forwarded-for": ip },
          body: new FormData(),
        }),
      )
      expect(res.status).toBe(400) // reaches the handler (no file part), never throttled
    }
  })
})
