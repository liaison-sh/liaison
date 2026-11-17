// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A signed agreement's Knowledge copy follows the agreement's list after the copy was written.
// While the agreement is closed to the organization, its copies are read by exactly its list:
// a colleague who was on an older share, a role's members and an admin holding every scope
// read nothing. Once it is open again, the list, its creator and the reader role read it. The
// follow runs in the database function the agreement's one list writer calls, so it holds
// whatever path changed the list.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as dsql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { resourceGrants } from "~/db/schema/kernel"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { insertAppRow } from "~/seed/factories/app-tables"
import { grantScopesThroughRole } from "~/seed/factories/people/scoped-role"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")

let orgId = ""
let listed = ""
let formerly = ""
let roleMember = ""
let admin = ""
let creator = ""
let next = ""
let roleId = ""
let agreementId = ""
let copyId = ""

function descriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "agreements", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(
      REPO_ROOT,
      "bundled-apps",
      "agreements",
      String(manifest.version),
      "bundle.js",
    ),
  }
}

async function reads(userId: string, scopes: string[]): Promise<number> {
  const roles = userId === roleMember ? [roleId] : []
  const actor: UserContext = {
    actorType: "user",
    userId,
    orgId,
    scopes,
    dimensionGrants: { "*": ["*"] },
    roles,
  } as UserContext
  return withRlsContext(actor, async (tx) => {
    const rows = extractRows<{ n: number }>(
      await tx.execute(
        dsql`SELECT count(*)::int AS n FROM app_knowledge.documents WHERE id = ${copyId}::uuid`,
      ),
    )
    return Number(rows[0]?.n ?? 0)
  })
}

async function follow(): Promise<void> {
  await withPrivilegedDb(orgId, "test:sow-copy-follow", async (tx) => {
    await tx.execute(
      dsql`SELECT kernel.restricted_access_follow(${orgId}::uuid, 'agreements.agreement', ${agreementId}::uuid)`,
    )
  })
}

async function grantees(): Promise<string[]> {
  const rows = (await sql`
    SELECT grantee_kind || ':' || grantee AS g FROM kernel.resource_grants
     WHERE resource_type = 'knowledge.document' AND resource_id = ${copyId}::uuid
     ORDER BY 1`) as unknown as Array<{ g: string }>
  return rows.map((r) => r.g)
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  orgId = (await createTestOrg()).id
  listed = (await minimal.session(orgId, { role: "member" })).userId
  formerly = (await minimal.session(orgId, { role: "member" })).userId
  roleMember = (await minimal.session(orgId, { role: "member" })).userId
  creator = (await minimal.session(orgId, { role: "member" })).userId
  next = (await minimal.session(orgId, { role: "member" })).userId
  admin = (await minimal.adminSession(orgId)).userId
  await ensureAppsForOrg(orgId)
  await initSandboxPool()
  await initWorkerPool()
  const { failedApps } = await registerApps([descriptor() as never], orgId)
  expect(failedApps).toEqual([])
  await primeOrgApps(orgId, 0)
  agreementId = crypto.randomUUID()
  copyId = crypto.randomUUID()
  roleId = (
    await grantScopesThroughRole(orgId, {
      adminUserId: admin,
      userId: roleMember,
      name: `readers-${agreementId.slice(0, 8)}`,
      scopes: [],
      dimensions: {},
    })
  ).roleId
  await withPrivilegedDb(orgId, "test:sow-copy-door", async (tx) => {
    await insertAppRow(tx, "agreements", "agreements", {
      org_id: orgId,
      id: agreementId,
      number: "AG-2026-401",
      kind: "sow",
      title: "Closed statement of work",
      org_access: "none",
      created_by_user_id: creator,
    })
    await insertAppRow(tx, "agreements", "agreement_shares", {
      org_id: orgId,
      agreement_id: agreementId,
      user_id: listed,
      role: "editor",
    })
    await insertAppRow(tx, "agreements", "agreements_settings", {
      org_id: orgId,
      sow_reader_role_id: roleId,
    })
    await insertAppRow(tx, "agreements", "agreement_versions", {
      org_id: orgId,
      agreement_id: agreementId,
      number: 1,
      status: "signed",
      sha256: "a".repeat(64),
      source_text: "1. Scope\nA website.",
      knowledge_document_id: copyId,
      frozen_at: new Date().toISOString(),
    })
  })
  // The copy as it stood before the list changed: written by the person on the list, and
  // shared with a colleague and a role who are no longer meant to read it.
  await withPrivilegedDb(orgId, "test:sow-copy-door", async (tx) => {
    await insertAppRow(tx, "knowledge", "documents", {
      org_id: orgId,
      id: copyId,
      title: "AG-2026-401 version 1",
      body: "Agreement AG-2026-401, version 1.",
      org_access: "none",
      created_by: listed,
      required_scopes: "{}",
      document_scope: "organization",
      sensitivity: "internal",
    })
    await tx.insert(resourceGrants).values(
      (
        [
          ["user", listed],
          ["user", formerly],
          ["role", roleId],
        ] as const
      ).map(([grantee_kind, grantee]) => ({
        orgId,
        resourceType: "knowledge.document",
        resourceId: copyId,
        granteeKind: grantee_kind,
        grantee,
        role: "viewer" as const,
      })),
    )
  })
}, 300_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  await sql`DELETE FROM kernel.resource_grants WHERE org_id = ${orgId}`.catch(() => {})
  await sql`DELETE FROM app_knowledge.documents WHERE org_id = ${orgId}`.catch(() => {})
  await sql`DELETE FROM kernel.apps WHERE org_id = ${orgId}`.catch(() => {})
  await releaseTestLock()
})

describe("a signed agreement's Knowledge copy after its list changes", () => {
  it("NT-67 while the agreement is closed, its Knowledge copy is read by exactly its list: not a colleague off it, a role's member or an admin holding every scope", async () => {
    expect(await reads(formerly, ["knowledge:*"])).toBe(1)
    await follow()
    expect(await grantees()).toEqual([`user:${listed}`])
    expect(await reads(listed, ["knowledge:*"])).toBe(1)
    expect(await reads(formerly, ["knowledge:*"])).toBe(0)
    expect(await reads(roleMember, ["knowledge:*"])).toBe(0)
    expect(await reads(admin, ["*"])).toBe(0)
    // The copy's own readers, as the restricted stamp reads them: the list.
    const [r] = (await sql`
      SELECT kernel.restricted_readers(${orgId}::uuid, ${`restricted:knowledge.document:${copyId}`})::text[] AS r`) as unknown as Array<{
      r: string[] | null
    }>
    expect(r?.r).toEqual([listed])
  }, 60_000)

  it("NT-67 the person who wrote the copy, once taken off the closed agreement's list, reads nothing of it: not the row, not the search projection, not the restricted readers", async () => {
    await sql`UPDATE app_agreements.agreement_shares SET removed_at = now() WHERE agreement_id = ${agreementId} AND user_id = ${listed}`
    await withPrivilegedDb(orgId, "test:sow-copy-door", async (tx) => {
      await insertAppRow(tx, "agreements", "agreement_shares", {
        org_id: orgId,
        agreement_id: agreementId,
        user_id: next,
        role: "editor",
      })
    })
    await follow()
    expect(await grantees()).toEqual([`user:${next}`])
    expect(await reads(next, ["knowledge:*"])).toBe(1)
    // The author of the copy holds no grant and no authorship right any more.
    expect(await reads(listed, ["knowledge:*"])).toBe(0)
    expect(await reads(listed, ["*"])).toBe(0)
    const [r] = (await sql`
      SELECT kernel.restricted_readers(${orgId}::uuid, ${`restricted:knowledge.document:${copyId}`})::text[] AS r`) as unknown as Array<{
      r: string[] | null
    }>
    expect(r?.r).toEqual([next])
    const [acl] = (await sql`
      SELECT acl_user_ids AS a FROM app_knowledge.documents WHERE id = ${copyId}::uuid`) as unknown as Array<{
      a: string[]
    }>
    expect(acl?.a).toEqual([next])
  }, 60_000)

  it("once the agreement is open again, its list, its creator and the reader role read the copy", async () => {
    await sql`UPDATE app_agreements.agreements SET org_access = 'viewer' WHERE id = ${agreementId}`
    await follow()
    expect(await grantees()).toEqual([`role:${roleId}`, `user:${creator}`, `user:${next}`].sort())
    // Open again, the copy's author reads it as its author.
    expect(await reads(listed, ["knowledge:*"])).toBe(1)
    expect(await reads(creator, ["knowledge:*"])).toBe(1)
    expect(await reads(roleMember, ["knowledge:*"])).toBe(1)
    expect(await reads(formerly, ["knowledge:*"])).toBe(0)
  }, 60_000)
})
