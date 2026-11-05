// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import {
  createSegment,
  evaluateSegment,
  exportContactsToFile,
  listContacts,
  resolveContact,
} from "~/modules/contacts/service"

const ORG_ID = "00000000-0000-0000-0000-0000000080a1"
const USER_ID = "00000000-0000-0000-0000-0000000080a2"

const events: unknown[] = []
const rlsDb = db as unknown as RlsClient
const origTx = (rlsDb as unknown as { transaction: (fn: unknown) => unknown }).transaction.bind(
  rlsDb,
)
const origQueueEvent = (rlsDb as unknown as { queueEvent: unknown }).queueEvent

function brand(d: RlsClient) {
  ;(d as unknown as { queueEvent: (e: unknown) => Promise<void> }).queueEvent = async (e) => {
    events.push(e)
  }
  ;(d as unknown as { transaction: (fn: (tx: RlsClient) => unknown) => unknown }).transaction = (
    fn,
  ) =>
    origTx(async (tx: RlsClient) => {
      ;(tx as unknown as { queueEvent: (e: unknown) => Promise<void> }).queueEvent = async (e) => {
        events.push(e)
      }
      return fn(tx)
    })
}

beforeEach(() => {
  brand(rlsDb)
})

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'TagsExportOrg', 'tags-export-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'tags-export@test.com', 'Tags User') ON CONFLICT DO NOTHING`
})

afterEach(async () => {
  events.length = 0
  ;(rlsDb as unknown as { queueEvent: unknown }).queueEvent = origQueueEvent
  ;(rlsDb as unknown as { transaction: unknown }).transaction = origTx
  await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.contact_segments WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.files WHERE org_id = ${ORG_ID}`
})

describe("contacts tags + segments + export", () => {
  it("resolveContact stores tags; listContacts filters by tag (empty on no-match)", async () => {
    await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "tonwerk@test.com",
        name: "Tonwerk Audio",
        tags: ["dealer", "vip"],
      },
      { audience: "org" },
    )
    const matched = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 50, tag: "vip" })
    expect(matched.rows.map((c) => c.email)).toContain("tonwerk@test.com")
    const none = await listContacts(rlsDb, {
      orgId: ORG_ID,
      page: 1,
      limit: 50,
      tag: "nonexistent",
    })
    expect(none.rows.length).toBe(0)
  })

  it("a stored segment is a live filter — new matching contacts appear without re-defining", async () => {
    const seg = await createSegment(rlsDb, {
      orgId: ORG_ID,
      userId: USER_ID,
      name: "EU Dealers",
      filter: { tag: "dealer" },
    })
    await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "klangwerk@test.com",
        name: "Reseller One",
        tags: ["dealer"],
      },
      { audience: "org" },
    )
    const members = await evaluateSegment(rlsDb, { orgId: ORG_ID, segmentId: seg.id })
    expect(members.map((c) => c.email)).toContain("klangwerk@test.com")
  })

  it("a spend segment composes the Shopify-exposed amountSpent (computable, not 'uncomputable')", async () => {
    await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "bigspender@test.com",
        name: "Big Account",
      },
      { audience: "org" },
    )
    await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "smallspender@test.com",
        name: "Small Account",
      },
      { audience: "org" },
    )
    const seg = await createSegment(rlsDb, {
      orgId: ORG_ID,
      userId: USER_ID,
      name: "Big Spenders",
      filter: { minSpend: 100000 }, // minor units
    })
    // The spend resolver mirrors Shopify customers_search amountSpent (minor units, keyed by email).
    const members = await evaluateSegment(rlsDb, {
      orgId: ORG_ID,
      segmentId: seg.id,
      resolveSpend: async (emails) => {
        const m = new Map<string, number>()
        for (const e of emails) {
          m.set(e, e === "bigspender@test.com" ? 250000 : 5000)
        }
        return m
      },
    })
    expect(members.length).toBeGreaterThan(0) // spend IS computable — never "uncomputable"
    expect(members.map((c) => c.email)).toContain("bigspender@test.com")
    expect(members.map((c) => c.email)).not.toContain("smallspender@test.com")
  })

  it("exportContactsToFile emits a CSV kernel.files artifact with RFC-4180 quoting over a segment", async () => {
    await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "comma-co@test.com",
        name: "Acme, Inc.",
        tags: ["dealer"],
      },
      { audience: "org" },
    )
    const seg = await createSegment(rlsDb, {
      orgId: ORG_ID,
      userId: USER_ID,
      name: "Comma Dealers",
      filter: { tag: "dealer" },
    })
    const out = await exportContactsToFile(rlsDb, {
      orgId: ORG_ID,
      userId: USER_ID,
      scopes: ["kernel:contacts:export", "kernel:contacts:read"],
      format: "csv",
      segmentId: seg.id,
    })
    expect(out.fileId).toBeTruthy()
    const [row] = (await sql`
      SELECT mime_type, size_bytes, storage_key FROM kernel.files WHERE id = ${out.fileId}
    `) as unknown as Array<{ mime_type: string; size_bytes: string | number; storage_key: string }>
    expect(row.mime_type).toBe("text/csv")
    expect(Number(row.size_bytes)).toBeGreaterThan(0)
    const bytes = await getObjectBuffer(row.storage_key)
    const csv = bytes.toString("utf8")
    expect(csv).toContain('"Acme, Inc."') // RFC-4180: comma value is quoted, never splits the column
    expect(csv.split("\n")[0]).toContain("handle")
  })

  it("exportContactsToFile requires kernel:contacts:export scope", async () => {
    await expect(
      exportContactsToFile(rlsDb, {
        orgId: ORG_ID,
        userId: USER_ID,
        scopes: [],
        format: "csv",
      }),
    ).rejects.toThrow(/scope|forbidden|contacts:export/i)
  })
})
