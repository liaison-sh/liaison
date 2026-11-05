// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contact address book over REST (/api/contacts/:id/addresses) and its
// service: an address is added unverified, a person's own session verifies it
// (recorded as them, with the source), changing any location field clears the
// verification while a phone change keeps it, and the verify route refuses a
// session that is not a person's interactive sign-in (a restricted device
// session, which a CLI or an agent on a computer drives) and a source file the
// caller cannot read.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { files } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let ORG = ""
let ADMIN = ""
let CONTACT = ""
let FILE = ""
let FOREIGN_FILE = ""

let session = ""
let restricted = ""
let readOnly = ""

async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> & { error?: { message: string } } }> {
  const res = await app.request(`/api/contacts/${CONTACT}/addresses${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json = (await res.json()) as { data?: Record<string, unknown>; error?: { message: string } }
  return {
    status: res.status,
    data: { ...(json.data ?? {}), ...(json.error ? { error: json.error } : {}) },
  }
}

/** A token of `person` carrying only `scopes`, optionally of a restricted (device) session. */
async function narrowToken(
  person: { id: string; permissionVersion: number },
  scopes: string[],
  extra: { restricted?: boolean } = {},
) {
  return signAccessToken(
    {
      userId: person.id,
      orgId: ORG,
      name: "Test",
      authVersion: 1,
      permissionVersion: person.permissionVersion,
      scopes,
      ...extra,
    },
    env.JWT_SECRET,
  )
}

/** A stored file row (no bytes needed: only its visibility is read). */
async function fileRow(orgId: string, threadId: string, filename: string, by: string | null) {
  const id = crypto.randomUUID()
  await withPrivilegedDb(orgId, "test:file-row", (tx) =>
    tx.insert(files).values({
      id,
      orgId,
      app: "kernel",
      entityType: "thread",
      entityId: threadId,
      filename,
      mimeType: "application/pdf",
      sizeBytes: 10,
      storageKey: `test/${id}`,
      uploadedBy: by,
    }),
  )
  return id
}

beforeAll(async () => {
  await acquireTestLock()
  ORG = (await createTestOrg()).id
  const admin = await minimal.orgAdmin(ORG)
  ADMIN = admin.id
  const reader = await minimal.person(ORG, { name: "Book Reader" })
  CONTACT = await minimal.contact(ORG, "noah@example.com", { name: "Noah Petit" })
  const thread = await minimal.thread(ORG, ADMIN, { title: "Purchase order" })
  FILE = await fileRow(ORG, thread, "po.pdf", ADMIN)
  const other = await minimal.secondOrg({ name: "Address Book Other" })
  FOREIGN_FILE = await fileRow(other.orgId, crypto.randomUUID(), "other.pdf", null)
  session = await minimal.token(ADMIN)
  restricted = await narrowToken(admin, ["kernel:contacts"], { restricted: true })
  readOnly = await narrowToken(reader, ["kernel:contacts:read"])
}, 120_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("contact addresses over REST", () => {
  let addressId = ""

  it("adds an address unverified, and reading needs only kernel:contacts:read", async () => {
    const added = await call(session, "POST", "", {
      role: "delivery",
      company: "Petit Studio",
      street1: "3 quai Voltaire",
      city: "Paris",
      postalCode: "75007",
      countryIso2: "fr",
    })
    expect(added.status).toBe(201)
    expect(added.data.verified).toBe(false)
    expect(added.data.countryIso2).toBe("FR")
    addressId = String(added.data.id)

    const res = await app.request(`/api/contacts/${CONTACT}/addresses`, {
      headers: { Authorization: `Bearer ${readOnly}` },
    })
    expect(res.status).toBe(200)
    const list = (await res.json()) as { data: { id: string }[]; meta?: { canEdit?: boolean } }
    expect(list.data.map((a) => a.id)).toEqual([addressId])
    // A reader without kernel:contacts:write gets the rows and no edit controls.
    expect(list.meta?.canEdit).toBe(false)
    const own = await app.request(`/api/contacts/${CONTACT}/addresses`, {
      headers: { Authorization: `Bearer ${session}` },
    })
    expect(((await own.json()) as { meta?: { canEdit?: boolean } }).meta?.canEdit).toBe(true)

    const denied = await call(readOnly, "POST", "", { city: "Lille" })
    expect(denied.status).toBe(403)
  })

  it("a restricted device session (an agent's or a CLI's) cannot verify: 403, nothing recorded", async () => {
    const res = await call(restricted, "POST", `/${addressId}/verify`, { source: "phone_call" })
    expect(res.status).toBe(403)
    const [row] = await sql<{ verified_at: Date | null }[]>`
      SELECT verified_at FROM kernel.contact_addresses WHERE id = ${addressId}`
    expect(row?.verified_at).toBeNull()
  })

  it("refuses a source file the caller cannot read", async () => {
    const res = await call(session, "POST", `/${addressId}/verify`, {
      source: "purchase_order",
      fileId: FOREIGN_FILE,
    })
    expect(res.status).toBe(422)
    expect(res.data.error?.message).toBe("The source file was not found, or you cannot read it")
    const missing = await call(session, "POST", `/${addressId}/verify`, {
      source: "purchase_order",
      fileId: crypto.randomUUID(),
    })
    expect(missing.status).toBe(422)
  })

  it("a person's session verifies, recorded as them with the source, note and file", async () => {
    const res = await call(session, "POST", `/${addressId}/verify`, {
      source: "purchase_order",
      note: "PO 77",
      fileId: FILE,
    })
    expect(res.status).toBe(200)
    expect(res.data).toMatchObject({
      verified: true,
      verifiedBy: ADMIN,
      source: "purchase_order",
      sourceNote: "PO 77",
      sourceFileId: FILE,
    })
    expect(typeof res.data.verifiedByName).toBe("string")
  })

  it("a phone change keeps the verification; editing the street clears it", async () => {
    const phone = await call(session, "PATCH", `/${addressId}`, { phone: "+33 1 00 00 00 00" })
    expect(phone.status).toBe(200)
    expect(phone.data.verified).toBe(true)

    const street = await call(session, "PATCH", `/${addressId}`, { street1: "5 quai Voltaire" })
    expect(street.status).toBe(200)
    expect(street.data).toMatchObject({
      street1: "5 quai Voltaire",
      verified: false,
      verifiedBy: null,
      source: null,
      sourceNote: null,
      sourceFileId: null,
    })
  })

  it("marks stale, then archives: an archived address leaves the list and cannot be verified", async () => {
    const stale = await call(session, "POST", `/${addressId}/stale`, { stale: true })
    expect(stale.status).toBe(200)
    expect(stale.data.staleAt).toBeTruthy()
    const archived = await call(session, "POST", `/${addressId}/archive`)
    expect(archived.status).toBe(200)
    const list = await app.request(`/api/contacts/${CONTACT}/addresses`, {
      headers: { Authorization: `Bearer ${session}` },
    })
    expect(((await list.json()) as { data: unknown[] }).data).toEqual([])
    const verify = await call(session, "POST", `/${addressId}/verify`, { source: "other" })
    expect(verify.status).toBe(409)
  })

  it("a contact the caller cannot see is a 404", async () => {
    const res = await app.request(`/api/contacts/${crypto.randomUUID()}/addresses`, {
      headers: { Authorization: `Bearer ${session}` },
    })
    expect(res.status).toBe(404)
  })
})
