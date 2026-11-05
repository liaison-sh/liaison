// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { disabledAppSkills } from "~/db/schema/kernel/disabled-app-skills"
import { createTestOrg } from "~/tests/helpers/org"

async function expectPgErrorCode(p: Promise<unknown>, expected: string): Promise<void> {
  let caught: unknown
  try {
    await p
  } catch (e) {
    caught = e
  }
  if (caught === undefined) throw new Error(`expected pg error ${expected} but resolved`)
  let cur: unknown = caught
  let code: string | undefined
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const o = cur as { code?: string; cause?: unknown }
    if (typeof o.code === "string") {
      code = o.code
      break
    }
    cur = o.cause
  }
  if (code !== expected) {
    throw new Error(`expected pg error ${expected}, got ${code ?? "<none>"}: ${String(caught)}`)
  }
}

async function makeOrgUser(): Promise<{ orgId: string; userId: string }> {
  const org = await createTestOrg()
  const id = await withSystemDb("disabled-app-skills-test-seed", async (db) => {
    const [u] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: `u-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "U",
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
  return { orgId: org.id, userId: id }
}

describe("kernel.disabled_app_skills schema", () => {
  it("inserts an org-wide disable (userId NULL) and a user-level disable for the same (app, skill)", async () => {
    const { orgId, userId } = await makeOrgUser()
    await withPrivilegedDb(orgId, "das-pair", async (tx) => {
      await tx.insert(disabledAppSkills).values({
        orgId,
        userId: null,
        appName: "tickets",
        skillName: "draft-reply",
      })
      await tx.insert(disabledAppSkills).values({
        orgId,
        userId,
        appName: "tickets",
        skillName: "draft-reply",
      })
      // Scope the assertion to the (app, skill) pair under test. A fresh org
      // also carries default-disabled `seed` rows auto-inserted by app
      // registration (e.g. projects/diagnose-routine-state), so an org-wide
      // `WHERE org_id = ...` count would include unrelated seeded rows. The
      // contract here is specifically: an org-wide (userId NULL) disable and a
      // user-level disable for the SAME (app, skill) coexist → exactly 2 rows.
      const rows = await tx
        .select()
        .from(disabledAppSkills)
        .where(
          and(
            eq(disabledAppSkills.orgId, orgId),
            eq(disabledAppSkills.appName, "tickets"),
            eq(disabledAppSkills.skillName, "draft-reply"),
          ),
        )
      expect(rows).toHaveLength(2)
    })
  })

  it("unique constraint prevents duplicate org-wide rows", async () => {
    const { orgId } = await makeOrgUser()
    await withPrivilegedDb(orgId, "das-dupe-1", async (tx) => {
      await tx
        .insert(disabledAppSkills)
        .values({ orgId, userId: null, appName: "tickets", skillName: "dupe" })
    })
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "das-dupe-2", async (tx) => {
        await tx
          .insert(disabledAppSkills)
          .values({ orgId, userId: null, appName: "tickets", skillName: "dupe" })
      }),
      "23505",
    )
  })

  it("user FK cascades on user delete", async () => {
    const { orgId, userId } = await makeOrgUser()
    await withPrivilegedDb(orgId, "das-cascade", async (tx) => {
      await tx
        .insert(disabledAppSkills)
        .values({ orgId, userId, appName: "tickets", skillName: "cascade" })
    })
    await withSystemDb("das-delete-user", async (db) => {
      await db.delete(users).where(eq(users.id, userId))
    })
    const rows = await withSystemDb("das-after-delete", (db) =>
      db
        .select()
        .from(disabledAppSkills)
        .where(and(eq(disabledAppSkills.orgId, orgId), eq(disabledAppSkills.userId, userId))),
    )
    expect(rows).toHaveLength(0)
  })

  it("RLS read requires kernel:skills:read; RLS write requires kernel:skills:write", async () => {
    const { orgId, userId } = await makeOrgUser()
    await withPrivilegedDb(orgId, "das-rls-seed", async (tx) => {
      await tx
        .insert(disabledAppSkills)
        .values({ orgId, userId, appName: "tickets", skillName: "rls" })
    })
    const { withRlsContext } = await import("~/db/rls")
    // Scope reads to the (app, skill) pair under test: a fresh org also carries
    // default-disabled `seed` rows from app registration, which a read-scoped
    // query would otherwise see, inflating the count beyond the single row this
    // test inserts.
    const seededRowFilter = and(
      eq(disabledAppSkills.orgId, orgId),
      eq(disabledAppSkills.appName, "tickets"),
      eq(disabledAppSkills.skillName, "rls"),
    )
    const noScope = await withRlsContext(
      { actorType: "user", orgId, userId, scopes: ["unrelated"], dimensionGrants: {} },
      (rls) => rls.select().from(disabledAppSkills).where(seededRowFilter),
    )
    expect(noScope).toHaveLength(0)

    const withScope = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId,
        scopes: ["kernel:skills:read"],
        dimensionGrants: {},
      },
      (rls) => rls.select().from(disabledAppSkills).where(seededRowFilter),
    )
    expect(withScope).toHaveLength(1)

    // Write without write-scope must fail
    await expectPgErrorCode(
      withRlsContext(
        {
          actorType: "user",
          orgId,
          userId,
          scopes: ["kernel:skills:read"],
          dimensionGrants: {},
        },
        async (rls) => {
          await rls
            .insert(disabledAppSkills)
            .values({ orgId, userId, appName: "tickets", skillName: "nope" })
        },
      ),
      "42501",
    )
  })
})

describe("disabled_app_skills.disabledBy (A2)", () => {
  it("defaults to 'user' when omitted (pre-existing rows are user-authored)", async () => {
    const { orgId } = await makeOrgUser()
    const [row] = await withPrivilegedDb(orgId, "das-default", (tx) =>
      tx
        .insert(disabledAppSkills)
        .values({ orgId, userId: null, appName: "x", skillName: "s1" })
        .returning(),
    )
    expect(row.disabledBy).toBe("user")
  })

  it("persists 'seed' when set", async () => {
    const { orgId } = await makeOrgUser()
    const [row] = await withPrivilegedDb(orgId, "das-seed", (tx) =>
      tx
        .insert(disabledAppSkills)
        .values({ orgId, userId: null, appName: "x", skillName: "s2", disabledBy: "seed" })
        .returning(),
    )
    expect(row.disabledBy).toBe("seed")
  })

  it("rejects an out-of-enum value", async () => {
    const { orgId } = await makeOrgUser()
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "das-bad", async (tx) => {
        await tx.insert(disabledAppSkills).values({
          orgId,
          userId: null,
          appName: "x",
          skillName: "s3",
          disabledBy: "bogus" as never,
        })
      }),
      "23514",
    )
  })
})
