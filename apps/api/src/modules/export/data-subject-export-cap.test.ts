// SPDX-License-Identifier: FSL-1.1-ALv2
// The data-subject export writes its bundle as a kernel file, which counts
// toward the org's storage like an upload: past the operator's storage cap it
// is refused with STORAGE_QUOTA_EXCEEDED and nothing is stored.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { handleDataSubjectExport } from "~/modules/export/data-subject-export-tool"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const CONTACT = crypto.randomUUID()
let orgId = ""
let userId = ""

// The bundle's RLS reads, in the handler's fixed order: contact, tickets, then the
// invoicing tables probe (neither table here, so no invoice or identity read).
function fakeDb() {
  let call = 0
  return {
    execute: async () => {
      const idx = call++
      if (idx === 0)
        return [{ id: CONTACT, handle: "subject", name: "Subject", email: "s@example.com" }]
      if (idx === 2) return [{ documents: null, identities: null }]
      return []
    },
  } as never
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `dsr-cap-${crypto.randomUUID().slice(0, 8)}`, name: "DSR Cap" }))
    .orgId
  userId = (
    await ensureUser({
      orgId,
      email: `dsr-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
      name: "Admin",
      password: "pw-dsr-cap-1!",
      role: "admin",
    })
  ).userId
  await sql`UPDATE kernel.organizations SET caps = ${JSON.stringify({ storageGb: 1 })}::jsonb WHERE id = ${orgId}`
  await sql`
    INSERT INTO kernel.files (org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key)
    VALUES (${orgId}, 'kernel', 'cap_pad', ${crypto.randomUUID()}, 'pad.bin', 'application/octet-stream',
            ${1024 ** 3}, ${`orgs/${orgId}/cap-pad`})`
}, 60_000)

afterAll(releaseTestLock)

describe("handleDataSubjectExport at the storage cap", () => {
  it("refuses with STORAGE_QUOTA_EXCEEDED and stores no file", async () => {
    const r = await handleDataSubjectExport(
      { contactId: CONTACT },
      { orgId, userId, db: fakeDb(), scopes: ["kernel:data_subject:export"] },
    )
    if (!("error" in r)) throw new Error("expected the export to be refused at the cap")
    expect(r.error.code).toBe("STORAGE_QUOTA_EXCEEDED")
    const written = await sql`
      SELECT id FROM kernel.files WHERE org_id = ${orgId} AND entity_type = 'data_subject_export'`
    expect(written.length).toBe(0)
  })
})
