// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { sql } from "~/db"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import {
  getDeclaredEmits,
  resetAppRegistries,
  setDeclaredEmits,
} from "~/modules/apps/app-registries"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"

const TEST_ORG_ID = "00000000-0000-0000-0000-000000000601"

describe("on-demand job manifest registration", () => {
  beforeEach(async () => {
    resetAppRegistries()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG_ID}, 'Runtime Ext Org', 'runtime-ext-test')
      ON CONFLICT (id) DO NOTHING`
    setDeclaredEmits(
      "*",
      "kernel",
      new Set(["connected_account:create", "connected_account:disconnect"]),
    )
  })

  afterEach(async () => {
    // Don't DROP — registerApps is idempotent. Only delete this test's
    // bookkeeping rows so the next test re-registers fresh against the
    // already-existing schema.
    await sql`DELETE FROM kernel.apps WHERE name IN ('mail', 'tickets') AND org_id = ${TEST_ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG_ID}`
  })

  it("manifest with onDemand job registers a worker that can be enqueued", async () => {
    await registerApps(
      [mailAppManifest as unknown as AppDescriptor, ticketsAppManifest as unknown as AppDescriptor],
      TEST_ORG_ID,
    )

    // gmail-initial-sync is declared as onDemand: true in the mail manifest
    // enqueueAppJob throws if no handler is registered
    const jobId = await enqueueAppJob("mail", "gmail-initial-sync", {
      orgId: TEST_ORG_ID,
      accountId: "fake-id",
    })
    expect(jobId).toBeDefined()
  })

  it("scheduled job also gets registered as a worker", async () => {
    await registerApps(
      [mailAppManifest as unknown as AppDescriptor, ticketsAppManifest as unknown as AppDescriptor],
      TEST_ORG_ID,
    )

    // gmail-incremental-sync has a schedule — should also be reachable via enqueue
    const jobId = await enqueueAppJob("mail", "gmail-incremental-sync", { orgId: TEST_ORG_ID })
    expect(jobId).toBeDefined()
  })
})

describe("kernel cross-app event subscriptions", () => {
  beforeEach(async () => {
    resetAppRegistries()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG_ID}, 'Runtime Ext Org', 'runtime-ext-test')
      ON CONFLICT (id) DO NOTHING`
  })

  afterEach(async () => {
    // Don't DROP — registerApps is idempotent. Only delete this test's
    // bookkeeping rows so the next test re-registers fresh against the
    // already-existing schema.
    await sql`DELETE FROM kernel.apps WHERE name IN ('mail', 'tickets') AND org_id = ${TEST_ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG_ID}`
  })

  it("kernel declared emits are registered and visible via getDeclaredEmits", () => {
    setDeclaredEmits(
      "*",
      "kernel",
      new Set(["connected_account:create", "connected_account:disconnect"]),
    )

    const kernelEmits = getDeclaredEmits("*", "kernel")
    expect(kernelEmits).toBeDefined()
    expect(kernelEmits!.has("connected_account:create")).toBe(true)
    expect(kernelEmits!.has("connected_account:disconnect")).toBe(true)
  })

  it("mail app registers successfully when kernel emits are pre-declared", async () => {
    setDeclaredEmits(
      "*",
      "kernel",
      new Set(["connected_account:create", "connected_account:disconnect"]),
    )

    // registerApps should not throw — kernel cross-app subscriptions are allowed without dependency declaration
    await registerApps(
      [mailAppManifest as unknown as AppDescriptor, ticketsAppManifest as unknown as AppDescriptor],
      TEST_ORG_ID,
    )

    // Verify the mail app got registered (schema created)
    const [tableCheck] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'app_mail' AND table_name = 'accounts'
      ) AS "exists"
    `
    expect(tableCheck.exists).toBe(true)
  })
})
