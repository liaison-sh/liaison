// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { resolveProjectId } from "./resolve"

// resolveProjectId takes the app's SqlClient (an RLS tx in production). These
// cases exercise pure id/name resolution, which needs no RLS context, so the
// privileged handle stands in -- narrowed here once rather than at each call.
const tx = db as unknown as Parameters<typeof resolveProjectId>[0]

let orgId: string
let userId: string
let projectId: string
let siblingId: string

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-prefix-org-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Projects Prefix Org', ${slug})
      RETURNING id
    `),
  )
  orgId = org!.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`projects-prefix-${Date.now()}@test.com`},
              'Prefix Tester', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user!.id

  // Two projects whose ids share a leading hex run, so an ambiguous prefix is
  // testable alongside a unique one.
  const [p] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_projects.projects (id, org_id, owner_id, name, key)
      VALUES ('abcdef01-1111-4111-8111-111111111111'::uuid, ${orgId}::uuid, ${userId}::uuid, 'Tessera bugs', 'ERB')
      RETURNING id
    `),
  )
  projectId = p!.id
  const [s] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_projects.projects (id, org_id, owner_id, name, key)
      VALUES ('abcdef02-2222-4222-8222-222222222222'::uuid, ${orgId}::uuid, ${userId}::uuid, 'Feature Requests', 'FRQ')
      RETURNING id
    `),
  )
  siblingId = s!.id
})

afterAll(async () => {
  await db.execute(drizzleSql`DELETE FROM app_projects.projects WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}::uuid`)
  await releaseTestLock()
})

describe("resolveProjectId — UUID prefix (field regression 2026-08-04)", () => {
  // Liaison's OWN approval card renders the short id ("In 0431f720"), so an
  // agent copying what it was shown passes a truncated uuid. That fell through
  // to the NAME branch and failed with "no project with that name", which
  // parked a gated projects:create at `approving` from 2026-07-22 to
  // 2026-08-04. If the product displays short ids it has to accept them.
  it("resolves a unique 8-char id prefix", async () => {
    const resolved = await resolveProjectId(tx, orgId, { projectId: "abcdef01" })
    expect(resolved).toBe(projectId)
  })

  it("resolves a longer unique prefix", async () => {
    const resolved = await resolveProjectId(tx, orgId, { projectId: "abcdef01-1111" })
    expect(resolved).toBe(projectId)
  })

  it("still resolves a full uuid unchanged", async () => {
    expect(await resolveProjectId(tx, orgId, { projectId })).toBe(projectId)
  })

  it("still resolves by exact name", async () => {
    expect(await resolveProjectId(tx, orgId, { projectName: "Tessera bugs" })).toBe(projectId)
  })

  it("reports an AMBIGUOUS prefix rather than silently picking one", async () => {
    // "abcdef0" matches both. Guessing here would file a task into the wrong
    // project, which is worse than failing.
    await expect(resolveProjectId(tx, orgId, { projectId: "abcdef0" })).rejects.toThrow(
      /multiple projects match that id prefix/i,
    )
  })

  it("falls back to the name branch for a hex-looking project NAME", async () => {
    await db.execute(drizzleSql`
      INSERT INTO app_projects.projects (id, org_id, owner_id, name, key)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${userId}::uuid, 'deadbeef', 'DBF')
    `)
    // No id starts with "deadbeef", so it must be tried as a name, not 400.
    const resolved = await resolveProjectId(tx, orgId, { projectId: "deadbeef" })
    expect(resolved).toBeTruthy()
  })

  it("does not match a prefix from another org", async () => {
    await expect(
      resolveProjectId(tx, "00000000-0000-4000-8000-0000000abcde", { projectId: "abcdef01" }),
    ).rejects.toThrow()
  })

  it("still rejects a genuinely unknown value", async () => {
    await expect(resolveProjectId(tx, orgId, { projectId: "ffffff99" })).rejects.toThrow(
      /no project with that name/i,
    )
  })

  it("prefers an explicit projectName over an id-prefix guess", async () => {
    const resolved = await resolveProjectId(tx, orgId, {
      projectId: "abcdef01",
      projectName: "Feature Requests",
    })
    expect(resolved).toBe(siblingId)
  })
})
