// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createProject } from "./create-project"

let orgId: string
let userId: string
let actor: UserContext

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-create-org-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Projects Create Org', ${slug})
      RETURNING id
    `),
  )
  orgId = org!.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`projects-create-${Date.now()}@test.com`},
              'Projects Tester', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user!.id
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["projects:projects:write", "projects:projects:read"],
    dimensionGrants: { "*": ["*"] },
  }
})

afterAll(async () => {
  await releaseTestLock()
})

describe("projects.create", () => {
  it("projects.status.default-seeding", async () => {
    const result = await withRlsContext(actor, async (tx) =>
      createProject({
        tx,
        orgId,
        actor,
        input: { name: "Demo" },
      }),
    )
    expect(result.name).toBe("Demo")
    expect(result.statuses.map((s) => s.label)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "done",
      "cancelled",
    ])
    expect(result.statuses.map((s) => s.terminal)).toEqual([false, false, false, true, true])
    expect(result.statuses.map((s) => s.order)).toEqual([0, 1, 2, 3, 4])
  })

  it("projects.status.custom-columns-at-creation", async () => {
    const result = await withRlsContext(actor, async (tx) =>
      createProject({
        tx,
        orgId,
        actor,
        input: {
          name: "Roadmap",
          statuses: [
            { label: "Idea" },
            { label: "In discussion" },
            { label: "Candidate" },
            { label: "Todo" },
            { label: "In progress" },
            { label: "Done", terminal: true },
          ],
        },
      }),
    )
    expect(result.statuses.map((s) => s.label)).toEqual([
      "Idea",
      "In discussion",
      "Candidate",
      "Todo",
      "In progress",
      "Done",
    ])
    expect(result.statuses.map((s) => s.terminal)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ])
    expect(result.statuses.map((s) => s.order)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("projects.status.invalid-columns-roll-the-project-back", async () => {
    await expect(
      withRlsContext(actor, async (tx) =>
        createProject({
          tx,
          orgId,
          actor,
          input: { name: "Broken", statuses: [{ label: "Todo" }, { label: "todo" }] },
        }),
      ),
    ).rejects.toThrow(/invalid_statuses: duplicate column "todo"/)
    const rows = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT COUNT(*)::int AS n FROM app_projects.projects WHERE org_id = ${orgId}::uuid AND name = 'Broken'
      `),
    )
    expect(rows[0]!.n).toBe(0)
  })
})
