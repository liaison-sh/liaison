// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { closeAllQueues, enqueueAppJob } from "~/infra/jobs/jobs"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import testManifest from "../../../test-support/apps/test/app.manifest.json"

const TEST_ORG = "00000000-0000-0000-0000-000000140001"
const TEST_USER = "00000000-0000-0000-0000-000000140002"

describe("job dispatch — sandbox behavior", () => {
  beforeAll(async () => {
    // Drop any app_test schema left by a prior run/file before registering. A
    // leftover schema owned by a role the registration can't GRANT on aborts the
    // registration ("permission denied for schema app_test"), leaving the test's
    // tools unregistered. Symmetric with the afterAll drop below.
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_test" CASCADE`)
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Job Sandbox Org', 'job-sandbox')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${TEST_USER}, ${TEST_ORG}, 'job-sandbox@test.com', 'hash', 'Job Test', 'active')
      ON CONFLICT (id) DO NOTHING`
    await initSandboxPool()
    const manifest = {
      ...testManifest,
      _format: "manifest",
      _bundlePath: new URL("../../../test-support/apps/test/handler-bundle.ts", import.meta.url)
        .pathname,
    }
    await registerApps([manifest as any], TEST_ORG)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
    resetAppRegistries()
    await closeAllQueues()
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_test" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.users WHERE id = ${TEST_USER}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  it("manifest tool (listItems) executes via sandbox and returns array", async () => {
    const { executeTool } = await import("~/modules/apps/execute-tool")

    const result = await executeTool({
      toolName: "test:listItems",
      orgId: TEST_ORG,
      actor: {
        actorType: "user",
        userId: TEST_USER,
        orgId: TEST_ORG,
        scopes: ["test:items:read"],
        dimensionGrants: {},
      },
      params: {},
    })

    expect(Array.isArray(result.data)).toBe(true)
  })

  it("manifest tool (createItem) persists to DB via RPC bridge", async () => {
    const { executeTool } = await import("~/modules/apps/execute-tool")

    const result = await executeTool({
      toolName: "test:createItem",
      orgId: TEST_ORG,
      actor: {
        actorType: "user",
        userId: TEST_USER,
        orgId: TEST_ORG,
        scopes: ["test:items:write"],
        dimensionGrants: {
          "test:team": ["engineering"],
          "test:sensitivity": ["public", "internal", "confidential"],
        },
      },
      params: { title: "Sandbox Test Item", team: "engineering" },
    })

    expect(result.data).toBeDefined()
    expect((result.data as any).title).toBe("Sandbox Test Item")
  })

  it("manifest job (processItems) enqueues without error and worker is registered", async () => {
    // The job registration during registerApps registers a worker for "processItems".
    // enqueueAppJob verifies the handler is registered before enqueuing.
    const jobId = await enqueueAppJob("test", "processItems", { orgId: TEST_ORG })
    expect(typeof jobId).toBe("string")
    expect(jobId.length).toBeGreaterThan(0)
  })
})
