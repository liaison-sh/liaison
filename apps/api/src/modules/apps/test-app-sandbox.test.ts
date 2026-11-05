// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { decideApproval } from "~/modules/approvals/decide"
import { readDecidedResult } from "~/modules/approvals/read-decided-result"
import { entityRegistry, resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { validateAppManifest } from "~/modules/apps/contract"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import testManifest from "../../../test-support/apps/test/app.manifest.json"

const TEST_ORG = "00000000-0000-0000-0000-000000150001"
const TEST_USER = "00000000-0000-0000-0000-000000150002"

describe("test app — sandbox migration", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Test App Sandbox Org', 'test-app-sandbox')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${TEST_USER}, ${TEST_ORG}, 'test-sandbox@test.com', 'hash', 'Sandbox Test', 'active')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES ('00000000-0000-0000-0000-000000150099', ${TEST_ORG}, 'sbx', 'thread', ${TEST_USER})
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES ('00000000-0000-0000-0000-000000150099', ${TEST_USER}, ${TEST_ORG}, 'admin')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${TEST_USER}, ${TEST_ORG}, 'test:gated:write'), (${TEST_USER}, ${TEST_ORG}, 'test:approve'),
             (${TEST_USER}, ${TEST_ORG}, 'test:items:write')
      ON CONFLICT DO NOTHING`
    await initSandboxPool()
  })

  afterEach(() => resetAppRegistries())

  afterAll(async () => {
    await shutdownSandboxPool()
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_test" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = 'test' AND org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.users WHERE id = ${TEST_USER}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  it("manifest validates successfully", () => {
    const result = validateAppManifest(testManifest)
    expect(result.success).toBe(true)
  })

  it("registers test app from manifest", async () => {
    const manifest = {
      ...testManifest,
      _format: "manifest",
      _bundlePath: new URL("../../../test-support/apps/test/handler-bundle.ts", import.meta.url)
        .pathname,
    }
    await registerApps([manifest as any], TEST_ORG)

    expect(toolRegistry.get([TEST_ORG, "test", "listItems"])).toBeDefined()
    expect(toolRegistry.get([TEST_ORG, "test", "createItem"])).toBeDefined()
    expect(toolRegistry.get([TEST_ORG, "test", "riskyAction"])).toBeDefined()
    expect(toolRegistry.get([TEST_ORG, "test", "externalSearch"])).toBeDefined()
    expect(entityRegistry.get([TEST_ORG, "test", "items"])).toBeDefined()
  })

  it("executes listItems through sandbox", async () => {
    const manifest = {
      ...testManifest,
      _format: "manifest",
      _bundlePath: new URL("../../../test-support/apps/test/handler-bundle.ts", import.meta.url)
        .pathname,
    }
    await registerApps([manifest as any], TEST_ORG)

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
    expect(result.data).toBeDefined()
    expect(Array.isArray(result.data)).toBe(true)
  }, 30_000)

  it("riskyAction still triggers gated interception", async () => {
    const manifest = {
      ...testManifest,
      _format: "manifest",
      _bundlePath: new URL("../../../test-support/apps/test/handler-bundle.ts", import.meta.url)
        .pathname,
    }
    await registerApps([manifest as any], TEST_ORG)

    const result = await executeTool({
      toolName: "test:riskyAction",
      orgId: TEST_ORG,
      actor: {
        actorType: "user",
        userId: TEST_USER,
        orgId: TEST_ORG,
        scopes: ["test:items:write", "test:approve"],
        dimensionGrants: {},
      },
      params: { itemId: "abc", action: "delete" },
      threadId: "00000000-0000-0000-0000-000000150099",
      origin: "in-app-agent",
    })
    expect(result.blocked).toBeDefined()
    expect(result.blocked!.reason).toBe("gated")
  }, 30_000)

  // Regression — the gated-write-class-wide NULL DECIDED RESULT bug. A SANDBOXED gated handler
  // that does NOT self-record the approval protocol (no ctx.approval_recordSucceeded — exactly how
  // the real shopify/invoicing mutation handlers are written; only the test app + tickets self-record)
  // still RUNS and RETURNS a value on approval, but its decided result was never persisted, so
  // readDecidedResult (and the GET /api/approvals/:id/result the agent's conductor reads) returned
  // null → the agent never learned its action's outcome and flailed. riskyAction is the canonical
  // non-self-recording gated handler (returns { executed: true }).
  it("persists the decided result of a NON-self-recording gated handler (riskyAction → { executed: true })", async () => {
    const manifest = {
      ...testManifest,
      _format: "manifest",
      _bundlePath: new URL("../../../test-support/apps/test/handler-bundle.ts", import.meta.url)
        .pathname,
    }
    await registerApps([manifest as any], TEST_ORG)

    const actor = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: ["test:items:write", "test:approve"],
      dimensionGrants: {},
    }
    const blocked = await executeTool({
      toolName: "test:riskyAction",
      orgId: TEST_ORG,
      actor,
      params: { itemId: "abc", action: "delete" },
      threadId: "00000000-0000-0000-0000-000000150099",
      origin: "in-app-agent",
    })
    expect(blocked.blocked?.reason).toBe("gated")

    const decided = await decideApproval({
      orgId: TEST_ORG,
      requestId: blocked.blocked!.approvalRequestId!,
      actor,
      decision: "approve",
    })
    expect(decided.status).toBe("approved")

    // The handler ran and returned { executed: true } — the decided result MUST be retrievable.
    const persisted = await readDecidedResult(TEST_ORG, blocked.blocked!.approvalRequestId!)
    expect(persisted).toEqual({ executed: true })
  }, 30_000)

  it("gatedEcho walks create approve handler idempotency and terminal approval", async () => {
    const manifest = {
      ...testManifest,
      _format: "manifest",
      _bundlePath: new URL("../../../test-support/apps/test/handler-bundle.ts", import.meta.url)
        .pathname,
    }
    await registerApps([manifest as any], TEST_ORG)

    const actor = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: ["test:gated:write", "test:approve"],
      dimensionGrants: {},
    }
    const result = await executeTool({
      toolName: "test:gatedEcho",
      orgId: TEST_ORG,
      actor,
      params: { message: "sandbox" },
      threadId: "00000000-0000-0000-0000-000000150099",
      origin: "in-app-agent",
    })
    expect(result.blocked?.reason).toBe("gated")

    const decided = await decideApproval({
      orgId: TEST_ORG,
      requestId: result.blocked!.approvalRequestId!,
      actor,
      decision: "approve",
    })
    expect(decided.status).toBe("approved")
    const [exec] = await sql`
      SELECT status, external_ref FROM kernel.approved_handler_executions
      WHERE approval_request_id = ${result.blocked!.approvalRequestId!}
    `
    expect(exec).toMatchObject({ status: "succeeded", external_ref: { synthetic: true } })
  }, 30_000)

  it("externalSearch returns filtered response with dimensions", async () => {
    const manifest = {
      ...testManifest,
      _format: "manifest",
      _bundlePath: new URL("../../../test-support/apps/test/handler-bundle.ts", import.meta.url)
        .pathname,
    }
    await registerApps([manifest as any], TEST_ORG)

    const result = await executeTool({
      toolName: "test:externalSearch",
      orgId: TEST_ORG,
      actor: {
        actorType: "user",
        userId: TEST_USER,
        orgId: TEST_ORG,
        scopes: ["test:external:read"],
        dimensionGrants: { "test:market": ["eu"] },
      },
      params: { query: "test" },
    })
    const items = result.data as any[]
    expect(items.every((i: any) => i.market === "eu")).toBe(true)
  }, 30_000)
})
