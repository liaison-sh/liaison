// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The signed text's Knowledge copy, through the real bridge and Postgres: the agreements app's
// ingestion (`knowledge:create`, declared in its cross_app_calls and named in the kernel's
// ingestion paths) writes one document closed to the organization and shared by name, read
// under row-level security by the people named and nobody else, `*` included. Its superseded
// copy is archived without a card.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as dsql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { appCrossAppCallsRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { appSelfScopes } from "~/modules/apps/runtime-helpers"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import agreementsManifest from "../../../../../bundled-apps/agreements/app.manifest.json"

let orgId = ""
let listed = ""
let member = ""
let admin = ""
let sender = ""

/**
 * The agreements app's cross-app call, run for a person on the list (the shape a person's own
 * run gives it: the person who sent it). A system run's write (the decided handler's) is not covered here: under the
 * system identity the database shows no person's closed document, so that path is still open.
 */
async function ingest(target: string, params: Record<string, unknown>) {
  const scopes = [
    ...appSelfScopes("agreements", agreementsManifest.scopes as unknown as string[]),
    "knowledge:documents:create",
    "knowledge:documents:read",
    "knowledge:documents:update",
    "knowledge:documents:archive",
  ]
  const actor = {
    actorType: "user" as const,
    userId: sender,
    orgId,
    scopes,
    dimensionGrants: { "*": ["*"] },
  }
  return withRlsContext(actor, async (tx) => {
    const bridge = createRpcBridge(
      "agreements",
      sender,
      orgId,
      tx,
      agreementsManifest as never,
      scopes,
      "user",
      undefined,
      { actor },
    )
    const call = (bridge as Record<string, unknown>).executeTool as (
      t: string,
      json: string,
    ) => Promise<string>
    return JSON.parse(await call(target, JSON.stringify(params))) as {
      status: string
      result?: { id?: string }
      error?: { code: string; message: string }
    }
  })
}

async function heldBy(userId: string, scopes: string[]): Promise<UserContext> {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function readsDoc(ctx: UserContext, id: string): Promise<number> {
  return withRlsContext(ctx, async (tx) => {
    const rows = extractRows<{ n: number }>(
      await tx.execute(
        dsql`SELECT count(*)::int AS n FROM app_knowledge.documents WHERE id = ${id}::uuid`,
      ),
    )
    return Number(rows[0]?.n ?? 0)
  })
}

describe("the signed text's Knowledge copy, through the bridge", () => {
  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    listed = (await minimal.session(orgId, { role: "member" })).userId
    member = (await minimal.session(orgId, { role: "member" })).userId
    admin = (await minimal.adminSession(orgId)).userId
    sender = (await minimal.session(orgId, { role: "member" })).userId
    await ensureAppsForOrg(orgId)
    const targets = (agreementsManifest.cross_app_calls ?? []).map((c) => c.target)
    appCrossAppCallsRegistry.set([orgId, "agreements"], { targets })
  }, 120_000)

  afterAll(async () => {
    appCrossAppCallsRegistry.delete?.([orgId, "agreements"])
    await db.execute(dsql`DELETE FROM app_knowledge.documents WHERE org_id = ${orgId}::uuid`)
    await releaseTestLock()
  })

  it("writes one closed document shared with exactly the named people; a member and an admin off the list read nothing", async () => {
    const out = await ingest("knowledge:create", {
      documentScope: "organization",
      title: "AG-2026-301 version 1: Closed terms",
      summary: "Signed text of AG-2026-301, version 1. The signed file is the record.",
      body: "Agreement AG-2026-301, version 1, document fingerprint sha256 abc.\n\n1. Scope",
      sensitivity: "internal",
      orgAccess: "none",
      shareWithUsers: [{ userId: listed, role: "viewer" }],
      idempotencyKey: `agreements:sow:${crypto.randomUUID()}`,
    })
    expect([out.status, out.error?.message ?? ""]).toEqual(["completed", ""])
    const id = String(out.result?.id ?? "")
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    const [row] = extractRows<{ org_access: string }>(
      await db.execute(dsql`SELECT org_access FROM app_knowledge.documents WHERE id = ${id}::uuid`),
    )
    expect(row?.org_access).toBe("none")
    const KNOW = ["knowledge:*"]
    expect(await readsDoc(await heldBy(listed, KNOW), id)).toBe(1)
    expect(await readsDoc(await heldBy(member, KNOW), id)).toBe(0)
    expect(await readsDoc(await heldBy(admin, ["*"]), id)).toBe(0)
  })

  it("archives a superseded copy without parking a card", async () => {
    const made = await ingest("knowledge:create", {
      documentScope: "organization",
      title: "AG-2026-302 version 1: Terms",
      body: "Agreement AG-2026-302, version 1, document fingerprint sha256 def.",
      sensitivity: "internal",
      orgAccess: "none",
      shareWithUsers: [{ userId: listed, role: "viewer" }],
      idempotencyKey: `agreements:sow:${crypto.randomUUID()}`,
    })
    const id = String(made.result?.id ?? "")
    const out = await ingest("knowledge:archive", { id })
    expect(out.status).toBe("completed")
    const [row] = extractRows<{ archived: boolean }>(
      await db.execute(
        dsql`SELECT archived_at IS NOT NULL AS archived FROM app_knowledge.documents WHERE id = ${id}::uuid`,
      ),
    )
    expect(row?.archived).toBe(true)
  })
})
