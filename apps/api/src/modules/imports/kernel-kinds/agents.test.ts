// SPDX-License-Identifier: FSL-1.1-ALv2
// Kernel import kinds `agents.skill` and `agents.routine`. A skill or a
// routine carries capabilities, so an import never widens them: a skill's
// required scopes stay within the importer's, a routine's scopes within both
// its owner's and the importer's, and an imported routine arrives switched
// off with nothing scheduled (Q4).
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { Queue } from "bullmq"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import * as subscriber from "~/infra/jobs/event-routine-subscriber"
import { BUILTIN_IMPORT_HANDLERS } from "~/modules/imports/builtin-import-handlers"
import { KERNEL_IMPORT_KINDS } from "~/modules/imports/kernel-kinds"
import { runImport } from "~/modules/imports/runner"
import type { SourceItem } from "~/modules/imports/source"
import { undoImportRun } from "~/modules/imports/undo"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let adminId = ""
let memberId = ""
let memberEmail = ""
const tag = () => crypto.randomUUID().slice(0, 8)

function actor(userId: string, scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

function recordsOf(records: Array<Record<string, unknown>>): {
  type: "records"
  records: SourceItem[]
} {
  return { type: "records", records: records.map((record, i) => ({ line: i + 1, record })) }
}

function run(kind: string, records: Array<Record<string, unknown>>, who = actor(adminId)) {
  return runImport({
    orgId,
    actor: who,
    kinds: [kind],
    source: recordsOf(records),
    sourceLabel: "agents",
    mode: "cli",
  })
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `imp-agents-${tag()}`, name: "Agents Import" })).orgId
  adminId = (
    await ensureUser({
      orgId,
      email: `owner-${tag()}@fabrikam.example`,
      name: "Owner",
      password: "pw-import-1!",
      role: "admin",
    })
  ).userId
  memberEmail = `member-${tag()}@fabrikam.example`
  memberId = (
    await ensureUser({
      orgId,
      email: memberEmail,
      name: "Member",
      password: "pw-import-1!",
      role: "member",
    })
  ).userId
}, 120_000)
afterAll(releaseTestLock)

describe("agents kinds: wiring", () => {
  it("both kernel kinds have a host handler", () => {
    for (const name of Object.keys(KERNEL_IMPORT_KINDS)) {
      expect(BUILTIN_IMPORT_HANDLERS[name]).toBeDefined()
    }
  })
})

describe("agents.skill", () => {
  it("creates an org skill the agent can reach, and skips the same name on a second run", async () => {
    const name = `rma-playbook-${tag()}`
    const first = await run("agents.skill", [
      { name, description: "How to process an RMA", body: "1. Check warranty." },
    ])
    expect(first.counts["agents.skill"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const [skill] = await sql`
      SELECT id, author_user_id, owner_agent_id, created_by_user_id, enabled, body
      FROM kernel.skills WHERE org_id = ${orgId} AND name = ${name}`
    expect(skill!.author_user_id).toBeNull()
    expect(skill!.owner_agent_id).not.toBeNull()
    expect(skill!.enabled).toBe(true)
    const index = await sql`SELECT 1 FROM kernel.agent_skill_index WHERE skill_id = ${skill!.id}`
    expect(index.length).toBe(1)

    const again = await run("agents.skill", [{ name, description: "Other", body: "Replaced?" }])
    expect(again.counts["agents.skill"]).toEqual({ created: 0, skipped: 1, failed: 0 })
    const [kept] = await sql`SELECT body FROM kernel.skills WHERE id = ${skill!.id}`
    expect(kept!.body).toBe("1. Check warranty.")
  })

  it("refuses required scopes beyond the importer's, and an org skill without app admin", async () => {
    const limited = actor(memberId, ["kernel:skills:write", "tickets:tickets:read"])
    const result = await run(
      "agents.skill",
      [
        {
          name: `wide-${tag()}`,
          description: "Needs more",
          body: "x",
          visibility: "personal",
          requiredScopes: ["kernel:users:admin"],
        },
        { name: `shared-${tag()}`, description: "Org wide", body: "x", visibility: "org" },
        {
          name: `mine-${tag()}`,
          description: "Fits",
          body: "x",
          visibility: "personal",
          requiredScopes: ["tickets:tickets:read"],
        },
      ],
      limited,
    )
    expect(result.counts["agents.skill"]).toEqual({ created: 1, skipped: 0, failed: 2 })
    expect(result.errors.map((e) => String(e.error))).toEqual([
      expect.stringMatching(/^scope_ceiling: .*kernel:users:admin/),
      expect.stringMatching(/^out_of_scope: /),
    ])
  })
})

describe("agents.skill: authors", () => {
  it("names another author only with user or app administration, else keeps the importer", async () => {
    const limited = actor(adminId, ["kernel:skills:write"])
    const name = `authored-${tag()}`
    const plain = await run(
      "agents.skill",
      [{ name, description: "d", body: "b", visibility: "personal", authorEmail: memberEmail }],
      limited,
    )
    expect(plain.counts["agents.skill"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    expect(plain.report.authorNotAttributed).toBe(1)
    const [kept] = await sql`
      SELECT created_by_user_id FROM kernel.skills WHERE org_id = ${orgId} AND name = ${name}`
    expect(kept!.created_by_user_id).toBe(adminId)

    const adminName = `authored-admin-${tag()}`
    const attributed = await run("agents.skill", [
      { name: adminName, description: "d", body: "b", authorEmail: memberEmail },
    ])
    expect(attributed.counts["agents.skill"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const [row] = await sql`
      SELECT created_by_user_id FROM kernel.skills WHERE org_id = ${orgId} AND name = ${adminName}`
    expect(row!.created_by_user_id).toBe(memberId)
  })
})

describe("agents.routine", () => {
  it("arrives switched off with nothing scheduled, owned by the person the record names", async () => {
    const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockImplementation(async () => {
      throw new Error("an imported routine must not be scheduled")
    })
    // Every enqueue is one addBulk (infra/jobs/fairness.ts fairEnqueue).
    const add = spyOn(Queue.prototype, "addBulk").mockImplementation(async () => {
      throw new Error("an imported routine must not be enqueued")
    })
    const subscribe = spyOn(subscriber, "registerEventRoutineSubscription").mockImplementation(
      async () => {
        throw new Error("an imported routine must not subscribe")
      },
    )
    // A scope the member (the routine's owner) holds; the admin importer holds all.
    const memberScope = (
      await withPrivilegedDb(orgId, "t", (tx) => loadEffectivePermissions(tx, memberId, orgId))
    ).scopes.find((s) => s !== "*")
    expect(memberScope).toBeDefined()
    try {
      const recurring = `weekly-digest-${tag()}`
      const scheduled = `once-${tag()}`
      const result = await run("agents.routine", [
        {
          name: recurring,
          description: "Monday digest",
          prompt: "Summarize last week's tickets.",
          kind: "recurring",
          cron: "0 9 * * 1",
          timezone: "Europe/Paris",
          scopes: [memberScope!],
          ownerEmail: memberEmail,
          visibility: "shared",
        },
        {
          name: scheduled,
          description: "Once",
          prompt: "Remind me.",
          kind: "scheduled",
          runAt: "2030-01-01T09:00:00Z",
          scopes: [],
        },
      ])
      expect(result.counts["agents.routine"]).toEqual({ created: 2, skipped: 0, failed: 0 })
      const [row] = await sql`
        SELECT enabled, status, owner_user_id, created_by_user_id, scopes, visibility, cron, timezone
        FROM kernel.routines WHERE org_id = ${orgId} AND name = ${recurring}`
      expect(row!.enabled).toBe(false)
      expect(row!.owner_user_id).toBe(memberId)
      expect(row!.created_by_user_id).toBe(adminId)
      expect(row!.scopes).toEqual([memberScope])
      // A routine imported for someone else is theirs alone, whatever the
      // record asked: the importer could otherwise switch on a shared routine
      // that runs as its owner.
      expect([row!.visibility, row!.cron, row!.timezone]).toEqual([
        "personal",
        "0 9 * * 1",
        "Europe/Paris",
      ])
      expect(upsert).not.toHaveBeenCalled()
      expect(add).not.toHaveBeenCalled()
      expect(subscribe).not.toHaveBeenCalled()

      const again = await run("agents.routine", [
        {
          name: scheduled,
          description: "Once",
          prompt: "Remind me.",
          kind: "scheduled",
          runAt: "2030-01-01T09:00:00Z",
          scopes: [],
        },
      ])
      expect(again.counts["agents.routine"]).toEqual({ created: 0, skipped: 1, failed: 0 })
    } finally {
      upsert.mockRestore()
      add.mockRestore()
      subscribe.mockRestore()
    }
  })

  it("refuses scopes the importer or the owner lacks, and a kind without its timing", async () => {
    const limited = actor(adminId, ["kernel:routines:write", "tickets:tickets:read"])
    const result = await run(
      "agents.routine",
      [
        {
          name: `importer-lacks-${tag()}`,
          description: "x",
          prompt: "p",
          kind: "recurring",
          cron: "0 9 * * *",
          timezone: "UTC",
          scopes: ["projects:tasks:write"],
        },
        {
          name: `no-cron-${tag()}`,
          description: "x",
          prompt: "p",
          kind: "recurring",
          scopes: [],
        },
      ],
      limited,
    )
    expect(result.counts["agents.routine"]).toEqual({ created: 0, skipped: 0, failed: 2 })
    expect(String(result.errors[0]?.error)).toMatch(/^scope_ceiling: .*projects:tasks:write/)
    expect(String(result.errors[1]?.error)).toMatch(/cron/)

    const ownerLacks = await run("agents.routine", [
      {
        name: `owner-lacks-${tag()}`,
        description: "x",
        prompt: "p",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        scopes: ["kernel:users:admin"],
        ownerEmail: memberEmail,
      },
    ])
    expect(ownerLacks.counts["agents.routine"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    expect(String(ownerLacks.errors[0]?.error)).toMatch(/^scope_ceiling: .*kernel:users:admin/)
  })

  it("a shared routine needs kernel:apps:admin", async () => {
    const limited = actor(adminId, ["kernel:routines:write"])
    const shared = (name: string) => ({
      name,
      description: "x",
      prompt: "p",
      kind: "scheduled",
      runAt: "2030-01-01T09:00:00Z",
      scopes: [],
      visibility: "shared",
    })
    const refused = await run("agents.routine", [shared(`shared-${tag()}`)], limited)
    expect(refused.counts["agents.routine"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    expect(String(refused.errors[0]?.error)).toMatch(/^out_of_scope: .*kernel:apps:admin/)
    const name = `shared-admin-${tag()}`
    const allowed = await run("agents.routine", [shared(name)])
    expect(allowed.counts["agents.routine"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const [row] =
      await sql`SELECT visibility FROM kernel.routines WHERE org_id = ${orgId} AND name = ${name}`
    expect(row!.visibility).toBe("shared")
  })

  it("a routine for someone else needs the delegate authority", async () => {
    const limited = actor(adminId, ["kernel:routines:write"])
    const result = await run(
      "agents.routine",
      [
        {
          name: `delegated-${tag()}`,
          description: "x",
          prompt: "p",
          kind: "scheduled",
          runAt: "2030-01-01T09:00:00Z",
          scopes: [],
          ownerEmail: memberEmail,
        },
      ],
      limited,
    )
    expect(result.counts["agents.routine"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    expect(String(result.errors[0]?.error)).toMatch(/^delegation_forbidden: /)
  })
})

describe("undo of skills and routines", () => {
  it("deletes both, and refuses a routine edited after the import", async () => {
    const skillName = `undo-skill-${tag()}`
    const routineName = `undo-routine-${tag()}`
    const editedName = `edited-routine-${tag()}`
    const routine = (name: string) => ({
      name,
      description: "x",
      prompt: "p",
      kind: "scheduled",
      runAt: "2030-01-01T09:00:00Z",
      scopes: [],
    })
    const skills = await run("agents.skill", [{ name: skillName, description: "d", body: "b" }])
    const routines = await run("agents.routine", [routine(routineName), routine(editedName)])
    await sql`
      UPDATE kernel.routines SET enabled = true, updated_at = clock_timestamp()
      WHERE org_id = ${orgId} AND name = ${editedName}`

    expect(await undoImportRun(orgId, skills.runId, { userId: adminId })).toEqual({
      deleted: 1,
      refused: [],
    })
    const report = await undoImportRun(orgId, routines.runId, { userId: adminId })
    expect(report.deleted).toBe(1)
    expect(report.refused.map((r) => r.reason)).toEqual(["changed_after_import"])
    const left = await sql`
      SELECT name FROM kernel.routines WHERE org_id = ${orgId} AND name IN (${routineName}, ${editedName})`
    expect(left.map((r) => r.name)).toEqual([editedName])
    expect((await sql`SELECT 1 FROM kernel.skills WHERE name = ${skillName}`).length).toBe(0)
  })
})
