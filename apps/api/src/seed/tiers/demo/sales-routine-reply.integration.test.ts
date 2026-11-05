// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SALES SCENARIO'S ROUTINE CAN STAGE ITS REPLY, on a real seeded world.
//
// A visitor who picks Sales gets the "Research interested prospects" routine.
// When the prospect's email lands it briefs the owner and drafts the reply,
// which waits for the owner's approval. A live walk found every reply failing
// "Conversation account not found or inaccessible" (and the compose fallback
// "No mailbox matches that accountId"): a routine runs capped to its own
// scopes, and the reply reads the conversation's mailbox account first, which
// the seeded routine's scopes did not cover.
//
// This seeds a Sales visitor org, delivers the prospect's email, runs
// `mail:reply` as the routine's tick does (the owner, under the routine's
// scopes bounded by its agent, with the owner's dimension grants), and
// approves the card: the reply is addressed to the prospect and is recorded
// as delivered without leaving the process (fixture delivery).
//
// Run it from `apps/api` (the modules it imports use apps/api's `~/` alias):
//   bun run scripts/test-run.ts demo-seed --file src/seed/tiers/demo/sales-routine-reply.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { resolveRoutineOwnerDimensionGrants } from "~/infra/jobs/kernel-jobs"
import { resolveTurnScope } from "~/modules/agent/runtime/agent-service"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { SALES_WORLD_PROSPECT, salesEmailInjector } from "~/modules/demo/world/sales-email"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { PROSPECT_SCENARIO_ROUTINE } from "./seed-agent-native"
import { type SeedDemoWorldResult, seedDemoWorld } from "./seed-demo"

const DB_URL = process.env.DATABASE_URL ?? ""

async function rows<T>(orgId: string, query: ReturnType<typeof sql>): Promise<T[]> {
  return withPrivilegedDb(orgId, "sales-routine-reply-test", async (tx) => {
    const result = await tx.execute(query)
    return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[]
  })
}

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database")
  }
  // A demo instance: the reply to a reserved-domain prospect is delivered as a
  // fixture only there.
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "sales-routine-reply-")),
      "apps",
    )
  }
  await initSandboxPool()
})

afterAll(async () => {
  await shutdownSandboxPool()
  resetAppRegistries()
  DemoModeTestAccess.set(null)
})

describe("the sales routine's reply to an interested prospect", () => {
  let world: SeedDemoWorldResult
  let ownerUserId: string
  let routine: { id: string; scopes: string[]; report_thread_id: string }
  let conversationId: string

  beforeAll(async () => {
    // The sales pick quotes through invoicing, a catalog app a demo box has
    // installed before any visitor arrives; a fresh database has none, and
    // without it the prospect routine is never seeded.
    await installFromDist("invoicing", crypto.randomUUID())
    world = await seedDemoWorld({
      orgSlug: `demo-sales-reply-${crypto.randomUUID().slice(0, 8)}`,
      variant: "visitor",
      owner: {
        email: `visitor-${crypto.randomUUID()}@visitor.demo.invalid`,
        name: "Visitor",
        password: "VisitorOwner1!Seed",
      },
      needs: ["sales"],
    })
    ownerUserId = world.org.ownerUserId ?? ""
    if (!ownerUserId) throw new Error("the visitor org was seeded with no owner")
    await ensureAppsForOrg(world.orgId)
    const [row] = await rows<{ id: string; scopes: string[]; report_thread_id: string }>(
      world.orgId,
      sql`SELECT id::text AS id, scopes, report_thread_id::text AS report_thread_id
          FROM kernel.routines
          WHERE org_id = ${world.orgId} AND name = ${PROSPECT_SCENARIO_ROUTINE}`,
    )
    if (!row) throw new Error("the prospect routine was not seeded")
    routine = row
    const beat = {
      orgId: world.orgId,
      ownerUserId,
      tourId: "demo-sales",
      beatId: "live-email",
      run: 0,
      runStartedAt: new Date(),
    }
    await salesEmailInjector.injectWorldEvent(beat)
    conversationId = (await salesEmailInjector.entityOf?.(beat)) ?? ""
  }, 2_400_000)

  it("stages a pending mail reply addressed to the prospect, which approval delivers", async () => {
    expect(world.failures).toEqual([])
    // What a tick runs with: the routine's scopes bounded by its acting agent,
    // and the owner's dimension grants (kernel-jobs.ts, the routine invoker).
    const turn = await withPrivilegedDb(world.orgId, "sales-routine-reply-turn", (tx) =>
      resolveTurnScope(
        tx,
        world.orgId,
        routine.report_thread_id,
        { userId: ownerUserId, scopes: routine.scopes },
        routine.id,
      ),
    )
    const dimensionGrants = await resolveRoutineOwnerDimensionGrants(world.orgId, ownerUserId)
    const result = await executeTool({
      toolName: "mail:reply",
      orgId: world.orgId,
      actor: {
        actorType: "user",
        userId: ownerUserId,
        orgId: world.orgId,
        scopes: turn ? turn.effectiveScope : routine.scopes,
        dimensionGrants,
      },
      params: {
        conversationId,
        textBody:
          "Hello Inês, thank you for your interest. Our quote for 40 units follows this week.",
      },
      threadId: routine.report_thread_id,
      origin: "in-app-agent",
    })
    expect(result.blocked?.reason).toBe("gated")
    expect(result.blocked?.summary?.kind).toBe("mail.reply")
    expect(result.blocked?.summary?.lines?.[0]).toBe(`To: ${SALES_WORLD_PROSPECT.email}`)
    const requestId = result.blocked?.approvalRequestId ?? ""
    const [pending] = await rows<{ status: string; tool_name: string }>(
      world.orgId,
      sql`SELECT status, tool_name FROM kernel.approval_requests WHERE id = ${requestId}`,
    )
    expect(pending).toEqual({ status: "pending", tool_name: "mail:reply" })

    const perms = await withPrivilegedDb(world.orgId, "sales-routine-reply-perms", (tx) =>
      loadEffectivePermissions(tx, ownerUserId, world.orgId),
    )
    const decided = await decideApproval({
      orgId: world.orgId,
      requestId,
      actor: {
        actorType: "user",
        userId: ownerUserId,
        orgId: world.orgId,
        scopes: perms.scopes,
        dimensionGrants: perms.dimensionGrants ?? {},
      },
      decision: "approve",
    })
    expect(decided.status).toBe("approved")
    // Persisted as the provider's copy: plain addresses or `{ email }` objects.
    const sent = await rows<{ to_addresses: Array<string | { email: string }> }>(
      world.orgId,
      sql`SELECT to_addresses FROM app_mail.messages
          WHERE org_id = ${world.orgId} AND conversation_id = ${conversationId}
            AND direction = 'outbound'`,
    )
    expect(
      sent.map((m) => m.to_addresses.map((a) => (typeof a === "string" ? a : a.email))),
    ).toEqual([[SALES_WORLD_PROSPECT.email]])
  })
})
