// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Many projects whose names start with the same letters derive the same key.
// Creating one more must still pick a free key, never fail.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let owner: minimal.Session

type Out = Record<string, unknown>

async function createProject(params: Record<string, unknown>): Promise<Out> {
  const actor: UserContext = {
    actorType: "user",
    userId: owner.userId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
  const out = (await executeToolCore({
    toolName: "projects:createProject",
    orgId,
    actor,
    params,
    origin: "human-ui",
  } as never)) as Out
  return ((out.data as Out | undefined) ?? out) as Out
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.adminSession(orgId)
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
})

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("project key allocation under many collisions", () => {
  it("keeps creating projects after the one-character suffix range is used up", async () => {
    const total = 45
    for (let i = 0; i < total; i++) {
      const out = await createProject({ name: `Arlon site ${i}` })
      expect(out.error).toBeUndefined()
      expect(out.id).toBeDefined()
    }
    const rows = extractRows<{ key: string }>(
      await db.execute(drizzleSql`
        SELECT key FROM app_projects.projects
         WHERE org_id = ${orgId}::uuid AND name LIKE 'Arlon site %'`),
    )
    expect(rows).toHaveLength(total)
    expect(new Set(rows.map((r) => r.key)).size).toBe(total)
    for (const r of rows) expect(r.key).toMatch(/^[A-Z][A-Z0-9]{1,9}$/)
  }, 120_000)
})
