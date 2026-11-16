// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A restricted record, by id or by copy: a guess of its id answers exactly as a random id does,
// for a member holding the read scope and for an admin holding every scope; and the search
// indexer refuses a row whose access columns were dropped, instead of indexing it open.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { buildSearchDocument, SearchAclMissingError } from "~/modules/search/doc-builder"
import type { SearchableEntityRegistration } from "~/modules/search/searchable-entities"
import { insertAppRow } from "~/seed/factories/app-tables"
import { seedFileRow } from "~/seed/factories/files/file-row"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")

let orgId = ""
let listedId = ""
let memberId = ""
let adminId = ""
let closedId = ""

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

type Out = { data?: Record<string, unknown>; error?: { code: string; message: string } }

async function get(userId: string, scopes: string[], id: string): Promise<Out> {
  const actor: UserContext = { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
  return (await executeToolCore({
    toolName: "agreements:agreement_get",
    orgId,
    actor,
    params: { id },
    origin: "human-ui",
  } as never)) as Out
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  orgId = (await createTestOrg()).id
  listedId = (await minimal.session(orgId, { role: "admin" })).userId
  memberId = (await minimal.session(orgId, { role: "member" })).userId
  adminId = (await minimal.session(orgId, { role: "admin" })).userId
  await ensureAppsForOrg(orgId)
  await initSandboxPool()
  await initWorkerPool()
  const { failedApps } = await registerApps([descriptor() as never], orgId)
  expect(failedApps).toEqual([])
  await primeOrgApps(orgId, 0)
  closedId = crypto.randomUUID()
  await withPrivilegedDb(orgId, "test:restricted-door", async (tx) => {
    await insertAppRow(tx, "agreements", "agreements", {
      org_id: orgId,
      id: closedId,
      number: "AG-2026-201",
      kind: "nda",
      title: "Closed door terms",
      org_access: "none",
    })
    await insertAppRow(tx, "agreements", "agreement_shares", {
      org_id: orgId,
      agreement_id: closedId,
      user_id: listedId,
      role: "editor",
    })
  })
}, 300_000)

afterAll(async () => {
  await rebuildFilesSelectPolicy()
  forgetOrgApps(orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  await sql`DELETE FROM kernel.apps WHERE org_id = ${orgId}`.catch(() => {})
  await releaseTestLock()
})

describe("a restricted agreement, by id or by copy", () => {
  it("NT-67 a guessed restricted id answers a member with the read scope and an admin holding every scope exactly as a random id does", async () => {
    const random = crypto.randomUUID()
    const read = ["agreements:agreements:read"]
    const shape = (out: Out, id: string) => ({
      data: out.data === undefined,
      code: out.error?.code,
      message: out.error?.message.replaceAll(id, "<id>"),
    })
    const forRandom = shape(await get(memberId, read, random), random)
    expect(forRandom.code).toBeDefined()
    expect(shape(await get(memberId, read, closedId), closedId)).toEqual(forRandom)
    expect(shape(await get(adminId, ["*"], closedId), closedId)).toEqual(forRandom)
    // The person on the list reads it.
    const own = await get(listedId, read, closedId)
    expect(JSON.stringify(own.data)).toContain("AG-2026-201")
  })

  it("NT-67 a file parented to a restricted agreement's version answers a member and an admin on the files routes exactly as a random id does", async () => {
    const versionId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "test:restricted-door-file", async (tx) => {
      await insertAppRow(tx, "agreements", "agreement_versions", {
        org_id: orgId,
        id: versionId,
        agreement_id: closedId,
        number: 1,
        frozen_at: new Date().toISOString(),
      })
    })
    const fileId = await seedFileRow({
      orgId,
      app: "agreements",
      entityType: "agreement_version",
      entityId: versionId,
      filename: "closed-terms.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      storageKey: `test/restricted-door/${crypto.randomUUID()}`,
    })
    // Production builds the files row policy from the installed catalog; this app is
    // registered from its manifest, so the policy is built from the registry's parents.
    await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })
    const random = crypto.randomUUID()
    const bearers = {
      listed: (await minimal.sessionOf({ id: listedId, orgId })).bearer,
      member: (await minimal.sessionOf({ id: memberId, orgId })).bearer,
      admin: (await minimal.sessionOf({ id: adminId, orgId })).bearer,
    }
    const meta = async (bearer: string, id: string) => {
      const res = await app.request(`/api/files/${id}/metadata`, {
        headers: { Authorization: `Bearer ${bearer}` },
      })
      return { status: res.status, body: (await res.text()).replaceAll(id, "<id>") }
    }
    const forRandom = await meta(bearers.member, random)
    expect(forRandom.status).toBe(404)
    expect(await meta(bearers.member, fileId)).toEqual(forRandom)
    expect(await meta(bearers.admin, fileId)).toEqual(forRandom)
    // The person on the list (an admin too, so only the list differs) reaches it.
    expect((await meta(bearers.listed, fileId)).status).toBe(200)
  })

  it("NT-67 the search indexer refuses a row whose access columns were dropped instead of indexing it open", async () => {
    const reg = {
      app: "agreements",
      entityType: "agreement",
      readScope: "agreements:agreements:read",
      indexFields: { title: "title" },
      permissionFields: {
        aclFields: {
          orgWideField: "org_wide",
          userIdsField: "acl_user_ids",
          roleIdsField: "acl_role_ids",
        },
      },
    } as unknown as SearchableEntityRegistration
    const row = { id: closedId, title: "Closed door terms" }
    await expect(buildSearchDocument(reg, orgId, row)).rejects.toBeInstanceOf(SearchAclMissingError)
    // With its access columns the same row builds, carrying them and only for its list.
    const doc = await buildSearchDocument(reg, orgId, {
      ...row,
      org_wide: false,
      acl_user_ids: [listedId],
    })
    expect(doc.org_wide).toBe(false)
    expect(doc.acl_user_ids).toEqual([listedId])
  })
})
