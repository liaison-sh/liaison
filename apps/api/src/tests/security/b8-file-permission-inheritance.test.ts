// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { buildTestApp } from "~/tests/helpers/build-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedFileFixtureWithRevoke } from "./seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("B8 — file permission inheritance: revoking parent access revokes file access", () => {
  test("download-url returns 200 before, then access-denied after entity access revoked", async () => {
    const { fileId, tokenB, revokeAccess } = await seedFileFixtureWithRevoke()
    const app = await buildTestApp()
    const hdr = { authorization: `Bearer ${tokenB}` }

    // Before revoke: user is a participant on the parent thread, so the file
    // is visible. Storage backend may or may not be wired in CI; we only
    // assert that access is granted (not blocked) — 200 is the happy path,
    // 503 (STORAGE_UNAVAILABLE) also counts as "permission allowed, infra
    // unavailable" and never as a permission denial.
    const before = await app.request(`/api/files/${fileId}/download-url`, { headers: hdr })
    expect([200, 503]).toContain(before.status)

    await revokeAccess()

    // After revoke: the user is no longer a participant on the parent thread,
    // and revokeAccess also bumps permissionVersion so the existing bearer is
    // invalidated. Any of 401 (token invalid), 403 (forbidden), or 404 (RLS-
    // filtered) is a valid "no longer accessible" outcome.
    const after = await app.request(`/api/files/${fileId}/download-url`, { headers: hdr })
    expect([401, 403, 404]).toContain(after.status)
  })
})
