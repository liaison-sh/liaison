// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A project another app's step makes (a signed agreement starting its project)
// names that step: two deliveries of the same step, at once or one after the
// other, make one project, and a person's project without a step is unchanged.

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

async function projectsWithRef(ref: string) {
  return extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      SELECT id::text AS id FROM app_projects.projects
       WHERE org_id = ${orgId}::uuid AND external_ref = ${ref}`),
  )
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

describe("a project made for another app's step", () => {
  it("two concurrent deliveries of one step make one project", async () => {
    const ref = `agreement:${crypto.randomUUID()}`
    const [a, b] = await Promise.all([
      createProject({ name: "Maison Vidal site", externalRef: ref }),
      createProject({ name: "Maison Vidal site", externalRef: ref }),
    ])
    expect(a.id).toBeDefined()
    expect(b.id).toBe(a.id)
    expect(await projectsWithRef(ref)).toHaveLength(1)
  })

  it("a later delivery returns the project already made and says nothing new was made", async () => {
    const ref = `agreement:${crypto.randomUUID()}`
    const first = await createProject({ name: "Maison Rey app", externalRef: ref })
    const again = await createProject({ name: "Maison Rey app (again)", externalRef: ref })
    expect(again.id).toBe(first.id)
    expect(again.existing).toBe(true)
    expect(String(again.message)).toContain("nothing new was created")
  })

  it("projects without a step stay independent", async () => {
    const a = await createProject({ name: "Maison Brun one" })
    const b = await createProject({ name: "Maison Brun two" })
    expect(a.id).not.toBe(b.id)
    expect(a.externalRef).toBeUndefined()
  })
})
