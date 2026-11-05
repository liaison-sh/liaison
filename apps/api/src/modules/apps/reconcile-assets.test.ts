// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { disabledAppSkills, routines, subAgentDefinitions, users } from "~/db/schema/kernel"
import {
  pauseAppRoutinesForOrg,
  reconcileAgents,
  reconcileDefaultDisabledSkills,
  resumeAppRoutinesForOrg,
} from "~/modules/apps/reconcile-assets"
import { createTestOrg } from "~/tests/helpers/org"

async function makeOrg(): Promise<string> {
  const org = await createTestOrg()
  return org.id
}

const decls = [
  { name: "triage-social-findings", enabledByDefault: false },
  { name: "social-overview", enabledByDefault: true },
]

describe("reconcileDefaultDisabledSkills (A4)", () => {
  let orgId: string
  beforeEach(async () => {
    orgId = await makeOrg()
  })

  async function rows() {
    return withPrivilegedDb(orgId, "r", (tx) =>
      tx
        .select()
        .from(disabledAppSkills)
        .where(and(eq(disabledAppSkills.orgId, orgId), eq(disabledAppSkills.appName, "social"))),
    )
  }

  it("seeds a disabledBy='seed' org-wide row for each enabledByDefault:false skill only", async () => {
    await reconcileDefaultDisabledSkills(orgId, "social", decls)
    const r = await rows()
    expect(r.length).toBe(1)
    expect(r[0]).toMatchObject({
      skillName: "triage-social-findings",
      disabledBy: "seed",
      userId: null,
    })
  })

  it("is idempotent — a second reconcile does not duplicate the seed row", async () => {
    await reconcileDefaultDisabledSkills(orgId, "social", decls)
    await reconcileDefaultDisabledSkills(orgId, "social", decls)
    expect((await rows()).length).toBe(1)
  })

  it("does NOT re-seed a skill the user enabled (deleted the seed row)", async () => {
    await reconcileDefaultDisabledSkills(orgId, "social", decls)
    await withPrivilegedDb(orgId, "del", (tx) =>
      tx
        .delete(disabledAppSkills)
        .where(
          and(
            eq(disabledAppSkills.orgId, orgId),
            eq(disabledAppSkills.appName, "social"),
            eq(disabledAppSkills.skillName, "triage-social-findings"),
          ),
        ),
    )
    await reconcileDefaultDisabledSkills(orgId, "social", decls)
    expect((await rows()).length).toBe(0)
  })

  it("does NOT re-disable when only a user row exists for a skill", async () => {
    await withPrivilegedDb(orgId, "u", (tx) =>
      tx.insert(disabledAppSkills).values({
        orgId,
        userId: null,
        appName: "social",
        skillName: "social-overview",
        disabledBy: "user",
      }),
    )
    await reconcileDefaultDisabledSkills(orgId, "social", decls)
    const r = await rows()
    expect(r.find((x) => x.skillName === "social-overview")?.disabledBy).toBe("user")
    expect(r.find((x) => x.skillName === "triage-social-findings")?.disabledBy).toBe("seed")
  })

  it("no default-off skills → no-op", async () => {
    await reconcileDefaultDisabledSkills(orgId, "social", [
      { name: "social-overview", enabledByDefault: true },
    ])
    expect((await rows()).length).toBe(0)
  })
})

describe("reconcileAgents (A5)", () => {
  let orgId: string
  let userId: string
  beforeEach(async () => {
    orgId = await makeOrg()
    userId = await withSystemDb("ra-user", async (db) => {
      const [u] = await db
        .insert(users)
        .values({
          orgId,
          email: `ra-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "U",
          status: "active",
        })
        .returning({ id: users.id })
      return u.id
    })
  })

  const AG = {
    "community-manager": {
      whenToUse: "draft social replies",
      systemPrompt: "be cool but useful",
      scopeCeiling: ["social:findings:read", "social:findings:write"],
      skills: ["draft-brand-reply"],
    },
  }

  it("seeds a sub_agent_definitions row when scopeCeiling ⊆ app scopes", async () => {
    await reconcileAgents(orgId, "social", AG, [
      "social:findings:read",
      "social:findings:write",
      "social:dm:write",
    ])
    const [row] = await withPrivilegedDb(orgId, "r", (tx) =>
      tx
        .select()
        .from(subAgentDefinitions)
        .where(
          and(
            eq(subAgentDefinitions.orgId, orgId),
            eq(subAgentDefinitions.agentType, "community-manager"),
          ),
        ),
    )
    expect(row.appName).toBe("social")
    expect(row.scopeCeiling).toEqual(["social:findings:read", "social:findings:write"])
    expect(row.skills).toEqual(["draft-brand-reply"])
  })

  it("rejects when scopeCeiling exceeds app granted scopes", async () => {
    await expect(reconcileAgents(orgId, "social", AG, ["social:findings:read"])).rejects.toThrow(
      /scope ceiling.*exceeds|exceeds.*granted/i,
    )
  })

  it("upserts idempotently by agentType (no duplicate rows)", async () => {
    await reconcileAgents(orgId, "social", AG, ["social:findings:read", "social:findings:write"])
    await reconcileAgents(
      orgId,
      "social",
      {
        ...AG,
        "community-manager": { ...AG["community-manager"], systemPrompt: "updated" },
      },
      ["social:findings:read", "social:findings:write"],
    )
    const rows = await withPrivilegedDb(orgId, "r", (tx) =>
      tx.select().from(subAgentDefinitions).where(eq(subAgentDefinitions.orgId, orgId)),
    )
    expect(rows.length).toBe(1)
    expect(rows[0].systemPrompt).toBe("updated")
  })
})

describe("pause/resumeAppRoutinesForOrg (A12)", () => {
  let orgId: string
  let userId: string
  beforeEach(async () => {
    orgId = await makeOrg()
    userId = await withSystemDb("a12-user", async (db) => {
      const [u] = await db
        .insert(users)
        .values({
          orgId,
          email: `a12-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "U",
          status: "active",
        })
        .returning({ id: users.id })
      return u.id
    })
  })

  async function insertAppRoutine(
    name: string,
    overrides: Partial<typeof routines.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await withPrivilegedDb(orgId, "a12-ins", (tx) =>
      tx
        .insert(routines)
        .values({
          orgId,
          ownerUserId: userId,
          name,
          description: "d",
          kind: "recurring",
          cron: "0 9 * * *",
          timezone: "UTC",
          prompt: "p",
          scopes: [],
          createdByActorType: "user",
          status: "active",
          enabled: true,
          appName: "social",
          templateKey: name,
          sourceKind: "app",
          ...overrides,
        })
        .returning({ id: routines.id }),
    )
    return row.id
  }

  async function read(id: string) {
    const [row] = await withPrivilegedDb(orgId, "a12-read", (tx) =>
      tx.select().from(routines).where(eq(routines.id, id)),
    )
    return row
  }

  it("uninstall pauses instantiated app routines (status=paused_app_disabled, enabled=false)", async () => {
    const id = await insertAppRoutine("triage-event", {
      kind: "event",
      event: "social:finding:created",
      cron: null,
      timezone: null,
    })
    await pauseAppRoutinesForOrg(orgId, "social")
    const row = await read(id)
    expect(row.status).toBe("paused_app_disabled")
    expect(row.enabled).toBe(false)
  })

  it("pause skips user-authored routines (sourceKind='user' untouched)", async () => {
    const [user] = await withPrivilegedDb(orgId, "a12-user-routine", (tx) =>
      tx
        .insert(routines)
        .values({
          orgId,
          ownerUserId: userId,
          name: "my-own",
          description: "d",
          kind: "recurring",
          cron: "0 9 * * *",
          timezone: "UTC",
          prompt: "p",
          scopes: [],
          createdByActorType: "user",
          status: "active",
          enabled: true,
        })
        .returning({ id: routines.id }),
    )
    await pauseAppRoutinesForOrg(orgId, "social")
    const still = await read(user.id)
    expect(still.status).toBe("active")
  })

  it("reinstall resumes only the rows uninstall paused (back to active)", async () => {
    const id = await insertAppRoutine("morning-digest")
    await pauseAppRoutinesForOrg(orgId, "social")
    await resumeAppRoutinesForOrg(orgId, "social")
    const row = await read(id)
    expect(row.status).toBe("active")
    expect(row.enabled).toBe(true)
  })

  it("resume does NOT un-pause a routine the USER paused (paused_user stays paused)", async () => {
    const id = await insertAppRoutine("morning-digest")
    await withPrivilegedDb(orgId, "a12-user-pause", (tx) =>
      tx.update(routines).set({ status: "paused_user", enabled: false }).where(eq(routines.id, id)),
    )
    await resumeAppRoutinesForOrg(orgId, "social")
    const row = await read(id)
    expect(row.status).toBe("paused_user")
  })

  it("pausing an already-paused app row is a no-op (status filter)", async () => {
    const id = await insertAppRoutine("morning-digest")
    await pauseAppRoutinesForOrg(orgId, "social")
    // user then pauses it themselves
    await withPrivilegedDb(orgId, "a12-flip", (tx) =>
      tx.update(routines).set({ status: "paused_user" }).where(eq(routines.id, id)),
    )
    await pauseAppRoutinesForOrg(orgId, "social") // re-pause must not clobber paused_user
    const row = await read(id)
    expect(row.status).toBe("paused_user")
  })
})
