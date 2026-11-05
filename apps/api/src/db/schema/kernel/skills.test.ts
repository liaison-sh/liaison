// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { sql as rawSql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { organizations, users } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { skills } from "~/db/schema/kernel/skills"
import { createTestOrg } from "~/tests/helpers/org"

/**
 * Drizzle wraps postgres.js errors in `DrizzleQueryError`, which loses the
 * original error message string. Walk the cause chain to find the underlying
 * PostgresError SQLSTATE code (e.g. 23505 unique violation, 23514 check
 * violation) and assert against that.
 */
async function expectPgErrorCode(promise: Promise<unknown>, expectedCode: string): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (e) {
    caught = e
  }
  if (caught === undefined) {
    throw new Error(`expected pg error ${expectedCode} but promise resolved`)
  }
  let cur: unknown = caught
  let code: string | undefined
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const obj = cur as { code?: string; cause?: unknown }
    if (typeof obj.code === "string") {
      code = obj.code
      break
    }
    cur = obj.cause
  }
  if (code !== expectedCode) {
    throw new Error(
      `expected pg error code ${expectedCode}, got ${code ?? "<none>"}; original=${String(caught)}`,
    )
  }
}

async function makeOrgWithUsers(): Promise<{ orgId: string; aliceId: string; bobId: string }> {
  const org = await createTestOrg()
  const { aliceId, bobId } = await withSystemDb("skills-test-seed-users", async (db) => {
    const [alice] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: `alice-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Alice",
        status: "active",
      })
      .returning({ id: users.id })
    const [bob] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: `bob-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Bob",
        status: "active",
      })
      .returning({ id: users.id })
    return { aliceId: alice.id, bobId: bob.id }
  })
  return { orgId: org.id, aliceId, bobId }
}

describe("kernel.skills schema", () => {
  it("inserts an org-shared skill (authorUserId NULL) and a personal one with the same name", async () => {
    const { orgId, aliceId } = await makeOrgWithUsers()
    await withPrivilegedDb(orgId, "skills-test-insert-pair", async (tx) => {
      await tx.insert(skills).values({
        orgId,
        authorUserId: null,
        name: "draft-reply",
        description: "shared",
        body: "shared body",
        requiredScopes: [],
        createdByUserId: aliceId,
        createdByActorType: "user",
      })
      await tx.insert(skills).values({
        orgId,
        authorUserId: aliceId,
        name: "draft-reply",
        description: "personal",
        body: "personal body",
        requiredScopes: [],
        createdByUserId: aliceId,
        createdByActorType: "user",
      })
      const rows = await tx.select().from(skills).where(eq(skills.orgId, orgId))
      expect(rows).toHaveLength(2)
    })
  })

  it("rejects duplicate (ownerAgentId, name) — same owner agent, same name", async () => {
    // Post P1a-T05: uniqueness moved from (orgId, authorUserId, name) to
    // (ownerAgentId, name). authorUserId alone no longer dedupes; two rows
    // sharing an ownerAgentId and name still collide.
    const { orgId, aliceId } = await makeOrgWithUsers()
    const [agentA] = await withSystemDb("skills-test-dupe-seed-agent", (db) =>
      db
        .insert(agents)
        .values({
          orgId,
          kind: "personal",
          handle: `agent-dupe-${crypto.randomUUID()}`,
          displayName: "Agent Dupe",
          ownerUserId: aliceId,
        })
        .returning({ id: agents.id }),
    )
    await withPrivilegedDb(orgId, "skills-test-dupe", async (tx) => {
      await tx.insert(skills).values({
        orgId,
        authorUserId: aliceId,
        ownerAgentId: agentA.id,
        name: "dup",
        description: "x",
        body: "y",
        requiredScopes: [],
        createdByUserId: aliceId,
        createdByActorType: "user",
      })
    })
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "skills-test-dupe-2", async (tx) => {
        await tx.insert(skills).values({
          orgId,
          authorUserId: aliceId,
          ownerAgentId: agentA.id,
          name: "dup",
          description: "x",
          body: "z",
          requiredScopes: [],
          createdByUserId: aliceId,
          createdByActorType: "user",
        })
      }),
      "23505", // unique_violation
    )
  })

  it("rejects description >100 chars", async () => {
    const { orgId, aliceId } = await makeOrgWithUsers()
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "skills-test-desc-len", async (tx) => {
        await tx.insert(skills).values({
          orgId,
          authorUserId: null,
          name: "bad",
          description: "x".repeat(101),
          body: "y",
          requiredScopes: [],
          createdByUserId: aliceId,
          createdByActorType: "user",
        })
      }),
      "23514", // check_violation
    )
  })

  it("rejects empty body", async () => {
    const { orgId, aliceId } = await makeOrgWithUsers()
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "skills-test-empty-body", async (tx) => {
        await tx.insert(skills).values({
          orgId,
          authorUserId: null,
          name: "empty-body",
          description: "x",
          body: "",
          requiredScopes: [],
          createdByUserId: aliceId,
          createdByActorType: "user",
        })
      }),
      "23514", // check_violation
    )
  })

  it("rejects unknown createdByActorType", async () => {
    const { orgId, aliceId } = await makeOrgWithUsers()
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "skills-test-bad-actor-type", async (tx) => {
        await tx.insert(skills).values({
          orgId,
          authorUserId: null,
          name: "bad-actor",
          description: "x",
          body: "y",
          requiredScopes: [],
          createdByUserId: aliceId,
          createdByActorType: "system" as never,
        })
      }),
      "23514", // check_violation
    )
  })

  it("authorUserId SET NULL on user delete; row survives (orphan personal becomes org-shared)", async () => {
    const { orgId, aliceId } = await makeOrgWithUsers()
    const [created] = await withPrivilegedDb(orgId, "skills-test-fk-author", (tx) =>
      tx
        .insert(skills)
        .values({
          orgId,
          authorUserId: aliceId,
          name: "personal-survives",
          description: "x",
          body: "y",
          requiredScopes: [],
          createdByUserId: aliceId,
          createdByActorType: "user",
        })
        .returning(),
    )
    await withSystemDb("skills-test-delete-author", async (db) => {
      await db.delete(users).where(eq(users.id, aliceId))
    })
    const [reloaded] = await withSystemDb("skills-test-read-after-delete", (db) =>
      db.select().from(skills).where(eq(skills.id, created.id)),
    )
    expect(reloaded.authorUserId).toBeNull()
    expect(reloaded.createdByUserId).toBeNull()
    expect(reloaded.createdByActorType).toBe("user")
  })

  it("cascade-deletes when org is deleted", async () => {
    const { orgId, aliceId } = await makeOrgWithUsers()
    await withPrivilegedDb(orgId, "skills-test-org-cascade-seed", async (tx) => {
      await tx.insert(skills).values({
        orgId,
        authorUserId: null,
        name: "org-cascade",
        description: "x",
        body: "y",
        requiredScopes: [],
        createdByUserId: aliceId,
        createdByActorType: "user",
      })
    })
    // users_org_fk is RESTRICT — drop the users first, then the org.
    await withSystemDb("skills-test-delete-users-then-org", async (db) => {
      await db.delete(users).where(eq(users.orgId, orgId))
      await db.delete(organizations).where(eq(organizations.id, orgId))
    })
    const rows = await withSystemDb("skills-test-confirm-cascade", (db) =>
      db.select().from(skills).where(eq(skills.orgId, orgId)),
    )
    expect(rows).toHaveLength(0)
  })

  it("RLS read returns only authorUserId IS NULL OR authorUserId = current_user_id", async () => {
    const { orgId, aliceId, bobId } = await makeOrgWithUsers()
    // Ownership now keys off ownerAgentId (A15): alice's and bob's personal agents,
    // plus a role agent for the org-shared row. authorUserId stays as provenance only.
    const { aliceAgentId, bobAgentId, roleAgentId } = await withPrivilegedDb(
      orgId,
      "skills-test-rls-agents-seed",
      async (tx) => {
        const [aliceAgent] = await tx
          .insert(agents)
          .values({
            orgId,
            kind: "personal",
            handle: `alice-agent-${crypto.randomUUID()}`,
            displayName: "Alice Agent",
            ownerUserId: aliceId,
          })
          .returning({ id: agents.id })
        const [bobAgent] = await tx
          .insert(agents)
          .values({
            orgId,
            kind: "personal",
            handle: `bob-agent-${crypto.randomUUID()}`,
            displayName: "Bob Agent",
            ownerUserId: bobId,
          })
          .returning({ id: agents.id })
        const [roleAgent] = await tx
          .insert(agents)
          .values({
            orgId,
            kind: "role",
            handle: `shared-agent-${crypto.randomUUID()}`,
            displayName: "Shared Role Agent",
          })
          .returning({ id: agents.id })
        return { aliceAgentId: aliceAgent.id, bobAgentId: bobAgent.id, roleAgentId: roleAgent.id }
      },
    )
    // Seed: 1 personal-alice, 1 personal-bob, 1 org-shared
    await withPrivilegedDb(orgId, "skills-test-rls-seed", async (tx) => {
      await tx.insert(skills).values([
        {
          orgId,
          authorUserId: aliceId,
          ownerAgentId: aliceAgentId,
          name: "alice-private",
          description: "a",
          body: "ab",
          requiredScopes: [],
          createdByUserId: aliceId,
          createdByActorType: "user",
        },
        {
          orgId,
          authorUserId: bobId,
          ownerAgentId: bobAgentId,
          name: "bob-private",
          description: "b",
          body: "bb",
          requiredScopes: [],
          createdByUserId: bobId,
          createdByActorType: "user",
        },
        {
          orgId,
          authorUserId: null,
          ownerAgentId: roleAgentId,
          name: "shared",
          description: "s",
          body: "sb",
          requiredScopes: [],
          createdByUserId: aliceId,
          createdByActorType: "user",
        },
      ])
    })

    // Alice's RLS view: alice's private + shared (2 rows).
    const { withRlsContext } = await import("~/db/rls")
    const aliceRows = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: aliceId,
        scopes: ["kernel:skills:read"],
        dimensionGrants: {},
      },
      (rls) => rls.select({ name: skills.name }).from(skills).where(eq(skills.orgId, orgId)),
    )
    expect(aliceRows.map((r) => r.name).sort()).toEqual(["alice-private", "shared"])

    // Bob's RLS view: bob's private + shared (2 rows).
    const bobRows = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: bobId,
        scopes: ["kernel:skills:read"],
        dimensionGrants: {},
      },
      (rls) => rls.select({ name: skills.name }).from(skills).where(eq(skills.orgId, orgId)),
    )
    expect(bobRows.map((r) => r.name).sort()).toEqual(["bob-private", "shared"])
  })

  it("RLS read denies caller without kernel:skills:read scope", async () => {
    const { orgId, aliceId } = await makeOrgWithUsers()
    await withPrivilegedDb(orgId, "skills-test-rls-no-scope-seed", async (tx) => {
      await tx.insert(skills).values({
        orgId,
        authorUserId: null,
        name: "no-scope-readable",
        description: "x",
        body: "y",
        requiredScopes: [],
        createdByUserId: aliceId,
        createdByActorType: "user",
      })
    })
    const { withRlsContext } = await import("~/db/rls")
    const rows = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: aliceId,
        scopes: ["unrelated:scope"],
        dimensionGrants: {},
      },
      (rls) => rls.select().from(skills).where(eq(skills.orgId, orgId)),
    )
    expect(rows).toHaveLength(0)
  })

  it("RLS write requires kernel:skills:write — insert without scope fails", async () => {
    const { orgId, aliceId } = await makeOrgWithUsers()
    const { withRlsContext } = await import("~/db/rls")
    await expectPgErrorCode(
      withRlsContext(
        {
          actorType: "user",
          orgId,
          userId: aliceId,
          scopes: ["kernel:skills:read"],
          dimensionGrants: {},
        },
        async (rls) => {
          await rls.insert(skills).values({
            orgId,
            authorUserId: aliceId,
            name: "no-write-scope",
            description: "x",
            body: "y",
            requiredScopes: [],
            createdByUserId: aliceId,
            createdByActorType: "user",
          })
        },
      ),
      "42501", // insufficient_privilege (RLS policy violation)
    )
  })

  it("RLS write succeeds with kernel:skills:write", async () => {
    const { orgId, aliceId } = await makeOrgWithUsers()
    // Ownership keys off ownerAgentId (A15): alice writes a skill owned by her own
    // personal agent, which the personal-kind branch of skills_insert permits.
    const [aliceAgent] = await withPrivilegedDb(orgId, "skills-test-rls-write-agent-seed", (tx) =>
      tx
        .insert(agents)
        .values({
          orgId,
          kind: "personal",
          handle: `alice-write-agent-${crypto.randomUUID()}`,
          displayName: "Alice Write Agent",
          ownerUserId: aliceId,
        })
        .returning({ id: agents.id }),
    )
    const { withRlsContext } = await import("~/db/rls")
    await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: aliceId,
        scopes: ["kernel:skills:read", "kernel:skills:write"],
        dimensionGrants: {},
      },
      async (rls) => {
        await rls.insert(skills).values({
          orgId,
          authorUserId: aliceId,
          ownerAgentId: aliceAgent.id,
          name: "with-write-scope",
          description: "x",
          body: "y",
          requiredScopes: [],
          createdByUserId: aliceId,
          createdByActorType: "user",
        })
      },
    )
    const rows = await withSystemDb("skills-test-rls-write-verify", (db) =>
      db
        .select()
        .from(skills)
        .where(and(eq(skills.orgId, orgId), eq(skills.name, "with-write-scope"))),
    )
    expect(rows).toHaveLength(1)
  })

  it("SKILLS SCHEMA: owner_agent_id column exists and is nullable at the DB level", async () => {
    const rows = (await rawSql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'kernel' AND table_name = 'skills'
        AND column_name = 'owner_agent_id'
    `) as unknown as Array<{ column_name: string; is_nullable: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.column_name).toBe("owner_agent_id")
    expect(rows[0]?.is_nullable).toBe("YES")
  })

  it("SKILLS SCHEMA: two skills with the same name but different owner agents can both exist", async () => {
    const { orgId, aliceId, bobId } = await makeOrgWithUsers()
    const { agentAId, agentBId } = await withSystemDb(
      "skills-test-seed-owner-agents",
      async (db) => {
        const [agentA] = await db
          .insert(agents)
          .values({
            orgId,
            kind: "personal",
            handle: `agent-a-${crypto.randomUUID()}`,
            displayName: "Agent A",
            ownerUserId: aliceId,
          })
          .returning({ id: agents.id })
        const [agentB] = await db
          .insert(agents)
          .values({
            orgId,
            kind: "personal",
            handle: `agent-b-${crypto.randomUUID()}`,
            displayName: "Agent B",
            ownerUserId: bobId,
          })
          .returning({ id: agents.id })
        return { agentAId: agentA.id, agentBId: agentB.id }
      },
    )
    await withPrivilegedDb(orgId, "skills-test-owner-agent-dupe-name", async (tx) => {
      await tx.insert(skills).values({
        orgId,
        authorUserId: aliceId,
        ownerAgentId: agentAId,
        name: "same-name-different-owner",
        description: "owned by agent A",
        body: "body a",
        requiredScopes: [],
        createdByUserId: aliceId,
        createdByActorType: "user",
      })
      await tx.insert(skills).values({
        orgId,
        authorUserId: bobId,
        ownerAgentId: agentBId,
        name: "same-name-different-owner",
        description: "owned by agent B",
        body: "body b",
        requiredScopes: [],
        createdByUserId: bobId,
        createdByActorType: "user",
      })
    })
    const rows = await withSystemDb("skills-test-owner-agent-dupe-name-verify", (db) =>
      db
        .select({ ownerAgentId: skills.ownerAgentId })
        .from(skills)
        .where(and(eq(skills.orgId, orgId), eq(skills.name, "same-name-different-owner"))),
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.ownerAgentId).sort()).toEqual([agentAId, agentBId].sort())
  })
})
