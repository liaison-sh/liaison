// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { files } from "~/db/schema/kernel/files"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { makeResolveImage } from "./render"

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

async function seedImage(
  orgId: string,
  app: string,
  extra: { encVersion?: number } = {},
): Promise<string> {
  return withPrivilegedDb(orgId, "resolve-image-test-seed", async (tx) => {
    const [row] = await tx
      .insert(files)
      .values({
        orgId,
        app,
        entityType: "issuer_profile",
        entityId: crypto.randomUUID(),
        filename: "logo.png",
        mimeType: "image/png",
        sizeBytes: PNG.byteLength,
        storageKey: `orgs/${orgId}/test/${crypto.randomUUID()}/logo.png`,
        ...extra,
      })
      .returning({ id: files.id })
    return row.id
  })
}

describe("pdf embedImage resolver scoping", () => {
  beforeAll(acquireTestLock, 120_000)
  afterAll(releaseTestLock)
  const getObjectBuffer = async () => PNG

  test("resolves a file owned by the calling app in the same org", async () => {
    const { id: orgId } = await createTestOrg()
    const fileId = await seedImage(orgId, "invoicing")
    const resolved = await makeResolveImage(orgId, "invoicing", getObjectBuffer)(fileId)
    expect(resolved?.mime).toBe("image/png")
  })

  test("refuses another app's file in the same org", async () => {
    const { id: orgId } = await createTestOrg()
    const mailFile = await seedImage(orgId, "mail")
    expect(await makeResolveImage(orgId, "invoicing", getObjectBuffer)(mailFile)).toBeNull()
  })

  test("refuses a file from another org", async () => {
    const { id: orgA } = await createTestOrg()
    // The test org factory keeps one org per database: the second org is made by hand.
    const orgB = "00000000-0000-0000-0000-00000000e1b0"
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${orgB}, 'ResolveImageOrgB', 'resolve-image-org-b') ON CONFLICT (id) DO NOTHING`
    const foreign = await seedImage(orgB, "invoicing")
    expect(await makeResolveImage(orgA, "invoicing", getObjectBuffer)(foreign)).toBeNull()
  })

  test("refuses a sealed (ciphertext) file", async () => {
    const { id: orgId } = await createTestOrg()
    const sealed = await seedImage(orgId, "invoicing", { encVersion: 1 })
    expect(await makeResolveImage(orgId, "invoicing", getObjectBuffer)(sealed)).toBeNull()
  })
})
