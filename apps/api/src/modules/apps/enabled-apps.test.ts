// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { enableApp, getEnabledApps, isAppRegistered } from "./enabled-apps"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("enabled-apps", () => {
  let orgId: string
  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    await ensureAppsForOrg(orgId)
  })

  test("starts empty", async () => {
    expect(await getEnabledApps(orgId)).toEqual([])
  })

  test("isAppRegistered true for a shipping app, false for unknown", async () => {
    expect(await isAppRegistered(orgId, "tickets")).toBe(true)
    expect(await isAppRegistered(orgId, "shopify")).toBe(false)
  })

  test("enableApp adds the app once (idempotent)", async () => {
    await enableApp(orgId, "tickets")
    await enableApp(orgId, "tickets")
    await enableApp(orgId, "mail")
    const enabled = await getEnabledApps(orgId)
    expect([...enabled].sort()).toEqual(["mail", "tickets"])
  })
})
