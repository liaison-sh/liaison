// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql } from "drizzle-orm"
import { knowledgeActorFromContext, listKnowledgeDocuments } from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { getEnabledApps } from "~/modules/apps/enabled-apps"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { setOrgAppStatus } from "~/modules/apps/org-app-service"
import { getOrgAppState } from "~/modules/apps/org-apps"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx, bootstrapScopedAdminCtx } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { handleAssignRole } from "./admin-tools"
import {
  enableAppNoChange,
  handleCaptureBusinessKnowledge,
  handleCreatePinnedThread,
  handleCreateRole,
  handleEnableApp,
  handleSetAppEnabled,
  setAppEnabledNoChange,
} from "./org-config-tools"

async function listOrgKnowledgeDocs(ctx: { orgId: string; userId: string }) {
  const perms = await withPrivilegedDb(ctx.orgId, "test-perms", (tx) =>
    loadEffectivePermissions(tx, ctx.userId, ctx.orgId),
  )
  const actor = {
    actorType: "user" as const,
    userId: ctx.userId,
    orgId: ctx.orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
  return withRlsContext(actor, (tx) =>
    listKnowledgeDocuments(
      tx,
      knowledgeActorFromContext({
        orgId: ctx.orgId,
        userId: ctx.userId,
        scopes: perms.scopes,
        dimensionGrants: perms.dimensionGrants,
      }),
    ),
  )
}

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("org-config kernel tool handlers", () => {
  let ctx: { orgId: string; userId: string }
  beforeEach(async () => {
    const a = await bootstrapAdminCtx()
    ctx = { orgId: a.orgId, userId: a.userId }
    await ensureAppsForOrg(ctx.orgId)
  })

  test("enable_app enables a registered app", async () => {
    const r = await handleEnableApp({ appName: "tickets" }, ctx)
    expect(r).toMatchObject({ enabled: "tickets" })
    expect(await getEnabledApps(ctx.orgId)).toContain("tickets")
  })

  test("enable_app on an app neither installed nor in the catalog is a refusal naming why, and changes nothing", async () => {
    const r = await handleEnableApp({ appName: "no-such-app" }, ctx)
    expect(r).toMatchObject({
      error: { code: "app_not_in_catalog", status: 404, retryable: true },
    })
    expect(JSON.stringify(r)).toContain("No catalog app named 'no-such-app'")
    expect(await getEnabledApps(ctx.orgId)).not.toContain("no-such-app")
  })

  test("enable_app on an app removed from the workspace adds it back (status active)", async () => {
    await setOrgAppStatus(ctx.orgId, "projects", "removed")
    try {
      const r = await handleEnableApp({ appName: "projects" }, ctx)
      expect(r).toMatchObject({ enabled: "projects" })
      expect((await getOrgAppState(ctx.orgId, "projects"))?.status).toBe("active")
    } finally {
      await setOrgAppStatus(ctx.orgId, "projects", "active")
    }
  })

  test("enable_app is idempotent", async () => {
    await handleEnableApp({ appName: "mail" }, ctx)
    await handleEnableApp({ appName: "mail" }, ctx)
    expect((await getEnabledApps(ctx.orgId)).filter((a) => a === "mail")).toHaveLength(1)
  })

  test("an app already on answers idempotently before any card: changed false, and it fixes nothing", async () => {
    await handleEnableApp({ appName: "mail" }, ctx)
    for (const r of [
      await enableAppNoChange({ appName: "mail" }, ctx),
      await setAppEnabledNoChange({ appName: "mail", enabled: true }, ctx),
    ]) {
      expect(r).toMatchObject({ changed: false })
      expect(r).not.toHaveProperty("error")
      const message = JSON.stringify(r)
      expect(message).toContain("already on")
      expect(message).toContain("no change")
      expect(message).toContain("cannot fix an error")
    }
  })

  test("walk N24/N35: an app on but missing from the enabled list is on: no card, recorded quietly", async () => {
    await withPrivilegedDb(ctx.orgId, "test-uncurate", (tx) =>
      tx.execute(sql`UPDATE kernel.organizations
        SET settings = jsonb_set(settings, '{enabledApps}',
          coalesce(settings -> 'enabledApps', '[]'::jsonb) - 'calendar')
        WHERE id = ${ctx.orgId}`),
    )
    expect(await getEnabledApps(ctx.orgId)).not.toContain("calendar")
    const r = await enableAppNoChange({ appName: "calendar" }, ctx)
    expect(r).toMatchObject({ enabled: "calendar", changed: false })
    expect(await getEnabledApps(ctx.orgId)).toContain("calendar")
  })

  test("an app already off answers the same way; a real switch goes on to the gate", async () => {
    await setOrgAppStatus(ctx.orgId, "projects", "disabled")
    try {
      expect(
        await setAppEnabledNoChange({ appName: "projects", enabled: false }, ctx),
      ).toMatchObject({ appName: "projects", status: "disabled", changed: false })
      expect(await setAppEnabledNoChange({ appName: "projects", enabled: true }, ctx)).toBeNull()
      expect(await enableAppNoChange({ appName: "projects" }, ctx)).toBeNull()
    } finally {
      await setOrgAppStatus(ctx.orgId, "projects", "active")
    }
  })

  test("a switch that finds the app already in that state at execution says changed: false", async () => {
    await handleEnableApp({ appName: "mail" }, ctx)
    const r = await handleSetAppEnabled({ appName: "mail", enabled: true }, ctx)
    expect(r).toMatchObject({ appName: "mail", status: "active", changed: false })
    expect(JSON.stringify(r)).toContain("cannot fix an error")
    const again = await handleEnableApp({ appName: "mail" }, ctx)
    expect(again).toMatchObject({ enabled: "mail", changed: false })
  })

  test("turning an app on names the next step: the person's goal (connecting it), not the checklist", async () => {
    await setOrgAppStatus(ctx.orgId, "projects", "removed")
    try {
      const r = await handleEnableApp({ appName: "projects" }, ctx)
      if (!("next" in r)) throw new Error(`no next step: ${JSON.stringify(r)}`)
      expect(r.next).toContain("The projects app is on.")
      expect(r.next).toContain("before any other setup step")
    } finally {
      await setOrgAppStatus(ctx.orgId, "projects", "active")
    }
  })

  test("create_role creates a role with scope grants", async () => {
    const r = (await handleCreateRole(
      {
        name: "Support Agent",
        description: "Handles tickets",
        scopes: ["kernel:threads:read"],
      },
      ctx,
    )) as { roleId: string }
    expect(typeof r.roleId).toBe("string")
  })

  test("create_role with a duplicate name returns an error", async () => {
    await handleCreateRole({ name: "Dup", scopes: [] }, ctx)
    const r = await handleCreateRole({ name: "Dup", scopes: [] }, ctx)
    expect(r).toEqual({ error: "role already exists" })
  })

  test("create_pinned_thread creates a pinned thread", async () => {
    const r = (await handleCreatePinnedThread({ title: "Announcements" }, ctx)) as {
      threadId: string
    }
    expect(typeof r.threadId).toBe("string")
  })

  test("capture_business_knowledge completes the write itself and stages no second approval", async () => {
    // capture_business_knowledge is itself a gated kernel tool: by the time this
    // handler runs a human has already approved the capture. Delegating to the
    // Knowledge app's own approval-gated org create would park a SECOND approval
    // and return no document, so the approved capture could never land.
    const r = (await handleCaptureBusinessKnowledge(
      { title: "Shipping policy", body: "Ships in 48h.", dimensions: { sensitivity: "internal" } },
      ctx,
    )) as { documentId: string }
    expect(typeof r.documentId).toBe("string")
    const pending = await withPrivilegedDb(ctx.orgId, "test-approvals", (tx) =>
      tx.execute(
        sql`SELECT tool_name FROM kernel.approval_requests WHERE org_id = ${ctx.orgId}::uuid`,
      ),
    )
    const rows = extractRows<{ tool_name: string }>(pending)
    expect(rows.map((x) => x.tool_name)).not.toContain("knowledge:create")
    const docs = await listOrgKnowledgeDocs(ctx)
    expect(
      docs.some((d) => d.title === "Shipping policy" && d.documentScope === "organization"),
    ).toBe(true)
  })

  test("capture_business_knowledge with NO sensitivity dimension still writes (explicit default, not an error left for the approver)", async () => {
    // A gated call must not be parked when the data it needs is missing. The
    // Knowledge create guard REQUIRES an explicit access classification on an
    // org doc; when the agent supplies no sensitivity dimension this tool must
    // supply its documented default ("internal") rather than failing with
    // `sensitivity_required` on a capture a human has already approved. The
    // capture completes in this handler (see the test above), so the proof is
    // the landed document, not a second approval card.
    const r = (await handleCaptureBusinessKnowledge(
      { title: "Shared inbox", body: "support@example.test is our shared inbox.", dimensions: {} },
      ctx,
    )) as { documentId?: string; error?: string }
    expect(r.error).toBeUndefined()
    expect(typeof r.documentId).toBe("string")
    const docs = await listOrgKnowledgeDocs(ctx)
    expect(docs.some((d) => d.title === "Shared inbox" && d.documentScope === "organization")).toBe(
      true,
    )
  })

  test("capture_business_knowledge auto-enables the Knowledge app if not enabled", async () => {
    expect(await getEnabledApps(ctx.orgId)).not.toContain("knowledge")
    await handleCaptureBusinessKnowledge({ title: "X", body: "Y", dimensions: {} }, ctx)
    expect(await getEnabledApps(ctx.orgId)).toContain("knowledge")
  })

  test("create_role approved by a person lacking a scope cannot grant it, though the requester holds it", async () => {
    // The requester (the bootstrap admin) holds "*"; the approving person holds
    // only role administration. An approved call acts with the APPROVER's own
    // authority: the agent must never mint a role beyond what the approver holds.
    const approver = await minimal.person(ctx.orgId)
    await minimal.grantScope(approver.id, "kernel:roles:admin")
    await minimal.grantScope(approver.id, "kernel:approve")
    const r = await handleCreateRole(
      { name: "Approved Overreach", scopes: ["shopify:orders:admin"] },
      { ...ctx, approverUserId: approver.id },
    )
    expect(r).toEqual({ error: "Cannot grant a scope you do not hold" })
  })

  test("an approved create_role is attributed to the approver, the requester recorded as requestedBy", async () => {
    const approver = await minimal.person(ctx.orgId)
    await minimal.grantScope(approver.id, "kernel:roles:admin")
    const name = `Attributed ${crypto.randomUUID().slice(0, 8)}`
    const r = await handleCreateRole({ name, scopes: [] }, { ...ctx, approverUserId: approver.id })
    expect(r).toMatchObject({ roleId: expect.any(String) })
    const rows = await withPrivilegedDb(ctx.orgId, "test-events", (tx) =>
      tx.execute(
        sql`SELECT payload FROM kernel.pending_events
            WHERE org_id = ${ctx.orgId}::uuid AND payload->>'entity' = 'role'
              AND payload->'data'->>'name' = ${name}`,
      ),
    )
    const [event] = extractRows<{
      payload: { actorId?: string; metadata?: { requestedBy?: string } }
    }>(rows)
    expect(event?.payload.actorId).toBe(approver.id)
    expect(event?.payload.metadata?.requestedBy).toBe(ctx.userId)
  })

  test("an approved assign_role is attributed to the approver, the requester recorded as requestedBy", async () => {
    const approver = await minimal.person(ctx.orgId, { role: "admin" })
    const target = await minimal.person(ctx.orgId)
    const [viewer] = extractRows<{ id: string }>(
      await withPrivilegedDb(ctx.orgId, "test-viewer", (tx) =>
        tx.execute(
          sql`SELECT id FROM kernel.roles WHERE org_id = ${ctx.orgId}::uuid AND name = 'viewer'`,
        ),
      ),
    )
    if (!viewer) throw new Error("no viewer role")
    const r = await handleAssignRole(
      { userId: target.id, roleId: viewer.id },
      { ...ctx, approverUserId: approver.id },
    )
    expect(r).toEqual({ assigned: true })
    const [event] = extractRows<{
      payload: { actorId?: string; metadata?: { requestedBy?: string } }
    }>(
      await withPrivilegedDb(ctx.orgId, "test-events", (tx) =>
        tx.execute(
          sql`SELECT payload FROM kernel.pending_events
              WHERE org_id = ${ctx.orgId}::uuid AND payload->>'entity' = 'role_assignment'
                AND payload->'data'->>'targetUserId' = ${target.id}`,
        ),
      ),
    )
    expect(event?.payload.actorId).toBe(approver.id)
    expect(event?.payload.metadata?.requestedBy).toBe(ctx.userId)
  })

  test("create_role cannot grant a scope the admin does not hold (genuine S4 guard, real finite scope set)", async () => {
    // The bootstrap admin's REAL persisted scope is the literal "*" preset
    // (DEFAULT_ROLES.admin), which hasScope() treats as grant-all — so the S4
    // "can only grant scopes you hold" guard cannot fire against it. A finite,
    // explicitly-scoped admin (no "*") makes this negative branch genuine.
    const scoped = await bootstrapScopedAdminCtx(["kernel:roles:admin", "kernel:users:admin"])
    const r = await handleCreateRole(
      { name: "Overreach", scopes: ["shopify:orders:admin"] },
      { orgId: scoped.orgId, userId: scoped.userId },
    )
    expect(r).toMatchObject({
      error: expect.stringMatching(/scope|permission|forbidden/i),
    })
  })
})
