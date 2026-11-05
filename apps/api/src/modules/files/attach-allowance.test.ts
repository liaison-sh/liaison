// SPDX-License-Identifier: FSL-1.1-ALv2
// The operator's extension allowance (LIAISON_ATTACHMENT_ALLOW_EXTENSIONS)
// applies to files staff authored only. A file from outside (an inbound
// attachment with no uploader, or a staff member's copy of one) keeps the full
// executable denylist, whatever the allowance says.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { files } from "~/db/schema/kernel/files"
import { isBlockedStoredFile } from "~/modules/files/attach"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let staffFile: { id: string; filename: string; mimeType: string }
let inboundFile: { id: string; filename: string; mimeType: string }
let copyOfInbound: { id: string; filename: string; mimeType: string }

async function insertFile(values: {
  uploadedBy: string | null
  copiedFromId?: string
  app?: string
}): Promise<{ id: string; filename: string; mimeType: string }> {
  const id = crypto.randomUUID()
  await withSystemDb("t", (db) =>
    db.insert(files).values({
      id,
      orgId,
      app: values.app ?? "tickets",
      entityType: "message",
      entityId: crypto.randomUUID(),
      filename: "build.exe",
      mimeType: "application/octet-stream",
      sizeBytes: 4,
      storageKey: `orgs/${orgId}/t/${id}/build.exe`,
      uploadedBy: values.uploadedBy,
      copiedFromId: values.copiedFromId ?? null,
    }),
  )
  return { id, filename: "build.exe", mimeType: "application/octet-stream" }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  const [admin] = await withSystemDb("t", (db) =>
    db.select({ id: users.id }).from(users).where(eq(users.orgId, orgId)).limit(1),
  )
  staffFile = await insertFile({ uploadedBy: admin.id })
  inboundFile = await insertFile({ uploadedBy: null })
  copyOfInbound = await insertFile({ uploadedBy: admin.id, copiedFromId: inboundFile.id })
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("isBlockedStoredFile", () => {
  it("without an allowance, every executable is blocked", async () => {
    expect(await isBlockedStoredFile(orgId, staffFile, "")).toBe(true)
    expect(await isBlockedStoredFile(orgId, inboundFile, "")).toBe(true)
  })

  it("with an allowance, a file staff uploaded may go out", async () => {
    expect(await isBlockedStoredFile(orgId, staffFile, "exe")).toBe(false)
  })

  it("with an allowance, an inbound attachment and a staff copy of one stay blocked", async () => {
    expect(await isBlockedStoredFile(orgId, inboundFile, "exe")).toBe(true)
    expect(await isBlockedStoredFile(orgId, copyOfInbound, "exe")).toBe(true)
  })

  it("an ordinary document is never blocked", async () => {
    expect(
      await isBlockedStoredFile(orgId, {
        ...inboundFile,
        filename: "a.pdf",
        mimeType: "application/pdf",
      }),
    ).toBe(false)
  })
})
