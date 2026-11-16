// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A restricted record, by id or by copy: a guess of its id answers exactly as a random id does,
// for a member holding the read scope and for an admin holding every scope; and the search
// indexer refuses a row whose access columns were dropped, instead of indexing it open.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { buildSearchDocument, SearchAclMissingError } from "~/modules/search/doc-builder"
import type { SearchableEntityRegistration } from "~/modules/search/searchable-entities"
import { insertAppRow } from "~/seed/factories/app-tables"
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
  listedId = (await minimal.session(orgId, { role: "member" })).userId
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
