// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S3: `awaitOrgApps` is the ensure entry for every first touch of an org. An
// org this process never queued (created after boot, or by another process)
// is set up before the caller runs; a deleted org stays a no-op. Real database,
// real registration.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db/connection"
import {
  initializedOrgRuntimes,
  manifestRegistry,
  orgsKnownMissing,
} from "~/modules/apps/app-registries"
import { awaitOrgApps } from "~/modules/apps/init"
import { createTestOrg } from "~/tests/helpers/org"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

function hasManifests(orgId: string): boolean {
  return [...manifestRegistry.entries()].some(([[o]]) => o === orgId)
}

beforeAll(async () => {
  await acquireTestLock()
  await createTestOrg()
})

afterAll(async () => {
  await releaseTestLock()
})

describe("awaitOrgApps (S3)", () => {
  it("sets up an org created after boot that this process never queued", async () => {
    const orgId = randomUUID()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${orgId}, 'Await Org Apps', ${`await-org-apps-${orgId.slice(0, 8)}`})`
    resetOrgRuntimeForTest(orgId)
    expect(initializedOrgRuntimes.has(orgId)).toBe(false)

    await awaitOrgApps(orgId)

    expect(initializedOrgRuntimes.has(orgId)).toBe(true)
    expect(hasManifests(orgId)).toBe(true)
  })

  it("ignores a deleted org and a non-org id: no registration attempted", async () => {
    const gone = randomUUID()
    await awaitOrgApps(gone)
    expect(initializedOrgRuntimes.has(gone)).toBe(false)
    expect(hasManifests(gone)).toBe(false)
    // Remembered, so the registry guard treats a later miss for it as an answer.
    expect(orgsKnownMissing.has(gone)).toBe(true)
    orgsKnownMissing.delete(gone)

    await awaitOrgApps("not-an-org-id")
    expect(initializedOrgRuntimes.has("not-an-org-id")).toBe(false)
  })
})
