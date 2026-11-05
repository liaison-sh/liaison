// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { sql as rawSql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { threadParticipants, threads, users } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { routines } from "~/db/schema/kernel/routines"
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
  const id = await withSystemDb("routines-test-seed", async (db) => {
    const [u] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: `u-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Owner",
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
  return { orgId: org.id, userId: id }
}

const baseValues = (orgId: string, userId: string, name: string) => ({
  orgId,
  ownerUserId: userId,
  name,
  description: "desc",
  cron: "*/5 * * * *",
  timezone: "UTC",
  prompt: "do the thing",
  scopes: ["kernel:threads:write"],
  createdByUserId: userId,
  createdByActorType: "user" as const,
})

describe("kernel.routines schema", () => {
  it("inserts a routine with createdByActorType='agent'", async () => {
    const { orgId, userId } = await makeOrgUser()
    await withPrivilegedDb(orgId, "routines-insert-agent", async (tx) => {
      const [row] = await tx
        .insert(routines)
        .values({
          ...baseValues(orgId, userId, "agent-created"),
          createdByActorType: "agent",
          createdByUserId: null,
        })
        .returning()
      expect(row.createdByActorType).toBe("agent")
      expect(row.status).toBe("active")
      expect(row.enabled).toBe(true)
    })
  })

  it("rejects status not in enum", async () => {
    const { orgId, userId } = await makeOrgUser()
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "routines-bad-status", async (tx) => {
        await tx
          .insert(routines)
          .values({ ...baseValues(orgId, userId, "bad"), status: "weird" as never })
      }),
      "23514",
    )
  })

  it("rejects description >200 chars and empty prompt", async () => {
    const { orgId, userId } = await makeOrgUser()
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "routines-desc-len", async (tx) => {
        await tx.insert(routines).values({
          ...baseValues(orgId, userId, "long-desc"),
          description: "x".repeat(201),
        })
      }),
      "23514",
    )
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "routines-empty-prompt", async (tx) => {
        await tx.insert(routines).values({
          ...baseValues(orgId, userId, "empty-prompt"),
          prompt: "",
        })
      }),
      "23514",
    )
  })

  it("UNIQUE (orgId, ownerUserId, name) prevents duplicate per user", async () => {
    const { orgId, userId } = await makeOrgUser()
    await withPrivilegedDb(orgId, "routines-unique-1", async (tx) => {
      await tx.insert(routines).values(baseValues(orgId, userId, "uniq"))
    })
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "routines-unique-2", async (tx) => {
        await tx.insert(routines).values(baseValues(orgId, userId, "uniq"))
      }),
      "23505",
    )
  })

  it("FK outputThreadId SET NULL on thread delete", async () => {
    const { orgId, userId } = await makeOrgUser()
    const threadId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "routines-fk-thread", async (tx) => {
      await tx.insert(threads).values({
        id: threadId,
        orgId,
        handle: `routine-out-${crypto.randomUUID().slice(0, 8)}`,
        title: "out",
        type: "routine",
        createdBy: userId,
      })
      await tx.insert(threadParticipants).values({ threadId, userId, orgId, role: "owner" })
      await tx
        .insert(routines)
        .values({ ...baseValues(orgId, userId, "thread-fk"), outputThreadId: threadId })
    })
    await withSystemDb("routines-delete-thread", async (db) => {
      await db.delete(threads).where(eq(threads.id, threadId))
    })
    const [row] = await withSystemDb("routines-after-thread-delete", (db) =>
      db
        .select()
        .from(routines)
        .where(and(eq(routines.orgId, orgId), eq(routines.name, "thread-fk"))),
    )
    expect(row.outputThreadId).toBeNull()
  })

  it("RLS row filter: ownerAgentId keyed to current_user_id's personal agent and read requires kernel:routines:read", async () => {
    const { orgId, userId } = await makeOrgUser()
    // Insert a second owner via privileged path
    const otherId = await withSystemDb("routines-other-user", async (db) => {
      const [u] = await db
        .insert(users)
        .values({
          orgId,
          email: `other-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Other",
          status: "active",
        })
        .returning({ id: users.id })
      return u.id
    })
    // Ownership now keys off ownerAgentId (A15): each user's own personal
    // agent, mirroring skills.test.ts's RLS fixture shape.
    const { myAgentId, otherAgentId } = await withPrivilegedDb(
      orgId,
      "routines-rls-agents-seed",
      async (tx) => {
        const [myAgent] = await tx
          .insert(agents)
          .values({
            orgId,
            kind: "personal",
            handle: `mine-agent-${crypto.randomUUID()}`,
            displayName: "Mine Agent",
            ownerUserId: userId,
          })
          .returning({ id: agents.id })
        const [otherAgent] = await tx
          .insert(agents)
          .values({
            orgId,
            kind: "personal",
            handle: `other-agent-${crypto.randomUUID()}`,
            displayName: "Other Agent",
            ownerUserId: otherId,
          })
          .returning({ id: agents.id })
        return { myAgentId: myAgent.id, otherAgentId: otherAgent.id }
      },
    )
    await withPrivilegedDb(orgId, "routines-rls-seed", async (tx) => {
      await tx
        .insert(routines)
        .values({ ...baseValues(orgId, userId, "mine"), ownerAgentId: myAgentId })
      await tx
        .insert(routines)
        .values({ ...baseValues(orgId, otherId, "theirs"), ownerAgentId: otherAgentId })
    })
    const { withRlsContext } = await import("~/db/rls")
    const mine = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId,
        scopes: ["kernel:routines:read"],
        dimensionGrants: {},
      },
      (rls) => rls.select({ name: routines.name }).from(routines).where(eq(routines.orgId, orgId)),
    )
    expect(mine.map((r) => r.name)).toEqual(["mine"])

    // No scope → no rows
    const none = await withRlsContext(
      { actorType: "user", orgId, userId, scopes: ["foo:bar"], dimensionGrants: {} },
      (rls) => rls.select().from(routines).where(eq(routines.orgId, orgId)),
    )
    expect(none).toHaveLength(0)
  })

  it("RLS insert requires kernel:routines:write", async () => {
    const { orgId, userId } = await makeOrgUser()
    const { withRlsContext } = await import("~/db/rls")
    await expectPgErrorCode(
      withRlsContext(
        {
          actorType: "user",
          orgId,
          userId,
          scopes: ["kernel:routines:read"],
          dimensionGrants: {},
        },
        async (rls) => {
          await rls.insert(routines).values(baseValues(orgId, userId, "no-write"))
        },
      ),
      "42501",
    )
  })
})

describe("routines schema — kind discriminator", () => {
  it("accepts a recurring routine with cron + timezone and null runAt", async () => {
    const { orgId, userId } = await makeOrgUser()
    await withPrivilegedDb(orgId, "routines-kind-rec", async (tx) => {
      const [row] = await tx
        .insert(routines)
        .values({
          ...baseValues(orgId, userId, "sch-test-rec"),
          kind: "recurring",
          cron: "0 8 * * 1-5",
          timezone: "America/Toronto",
          runAt: null,
          visibility: "personal",
        })
        .returning()
      expect(row.kind).toBe("recurring")
      expect(row.visibility).toBe("personal")
    })
  })

  it("accepts a scheduled routine with run_at and null cron/timezone", async () => {
    const { orgId, userId } = await makeOrgUser()
    await withPrivilegedDb(orgId, "routines-kind-one", async (tx) => {
      const [row] = await tx
        .insert(routines)
        .values({
          ...baseValues(orgId, userId, "sch-test-one"),
          kind: "scheduled",
          cron: null,
          timezone: null,
          runAt: new Date(Date.now() + 3 * 86_400_000),
          visibility: "shared",
        })
        .returning()
      expect(row.kind).toBe("scheduled")
      expect(row.visibility).toBe("shared")
    })
  })

  it("rejects a recurring routine with null cron", async () => {
    const { orgId, userId } = await makeOrgUser()
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "routines-kind-bad1", async (tx) => {
        await tx.insert(routines).values({
          ...baseValues(orgId, userId, "sch-test-bad1"),
          kind: "recurring",
          cron: null,
          timezone: null,
          runAt: null,
        })
      }),
      "23514",
    )
  })

  it("rejects a scheduled routine with null run_at", async () => {
    const { orgId, userId } = await makeOrgUser()
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "routines-kind-bad2", async (tx) => {
        await tx.insert(routines).values({
          ...baseValues(orgId, userId, "sch-test-bad2"),
          kind: "scheduled",
          cron: null,
          timezone: null,
          runAt: null,
        })
      }),
      "23514",
    )
  })

  it("accepts the 'completed' status", async () => {
    const { orgId, userId } = await makeOrgUser()
    await withPrivilegedDb(orgId, "routines-kind-done", async (tx) => {
      const [row] = await tx
        .insert(routines)
        .values({
          ...baseValues(orgId, userId, "sch-test-done"),
          kind: "scheduled",
          cron: null,
          timezone: null,
          runAt: new Date(),
          status: "completed",
        })
        .returning()
      expect(row.status).toBe("completed")
    })
  })

  it("rejects an invalid visibility", async () => {
    const { orgId, userId } = await makeOrgUser()
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "routines-kind-bad3", async (tx) => {
        await tx.insert(routines).values({
          ...baseValues(orgId, userId, "sch-test-bad3"),
          kind: "recurring",
          visibility: "company" as never,
        })
      }),
      "23514",
    )
  })
})

describe("routines schema — kind='event' + provenance columns (A1)", () => {
  it("accepts an event routine with event set and all timing cols null", async () => {
    const { orgId, userId } = await makeOrgUser()
    const [row] = await withPrivilegedDb(orgId, "routines-event-ok", (tx) =>
      tx
        .insert(routines)
        .values({
          orgId,
          ownerUserId: userId,
          name: "evt-ok",
          description: "d",
          kind: "event",
          event: "social:finding:created",
          cron: null,
          timezone: null,
          runAt: null,
          prompt: "p",
          scopes: [],
          createdByUserId: userId,
          createdByActorType: "user",
          appName: "social",
          templateKey: "triage-event",
          sourceKind: "app",
        })
        .returning(),
    )
    expect(row.kind).toBe("event")
    expect(row.event).toBe("social:finding:created")
    expect(row.sourceKind).toBe("app")
    expect(row.appName).toBe("social")
    expect(row.templateKey).toBe("triage-event")
  })

  it("rejects an event routine with a non-null cron (violates the event arm)", async () => {
    const { orgId, userId } = await makeOrgUser()
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "routines-event-bad-cron", async (tx) => {
        await tx.insert(routines).values({
          orgId,
          ownerUserId: userId,
          name: "evt-bad",
          description: "d",
          kind: "event",
          event: "social:finding:created",
          cron: "0 9 * * *",
          timezone: "UTC",
          runAt: null,
          prompt: "p",
          scopes: [],
          createdByUserId: userId,
          createdByActorType: "user",
        })
      }),
      "23514",
    )
  })

  it("rejects an event routine with a null event", async () => {
    const { orgId, userId } = await makeOrgUser()
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "routines-event-no-event", async (tx) => {
        await tx.insert(routines).values({
          orgId,
          ownerUserId: userId,
          name: "evt-noevt",
          description: "d",
          kind: "event",
          event: null,
          cron: null,
          timezone: null,
          runAt: null,
          prompt: "p",
          scopes: [],
          createdByUserId: userId,
          createdByActorType: "user",
        })
      }),
      "23514",
    )
  })

  it("sourceKind defaults to 'user' when omitted", async () => {
    const { orgId, userId } = await makeOrgUser()
    const [row] = await withPrivilegedDb(orgId, "routines-source-default", (tx) =>
      tx
        .insert(routines)
        .values(baseValues(orgId, userId, "src-default"))
        .returning(),
    )
    expect(row.sourceKind).toBe("user")
  })

  it("rejects a sourceKind out of enum", async () => {
    const { orgId, userId } = await makeOrgUser()
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "routines-source-bad", async (tx) => {
        await tx.insert(routines).values({
          ...baseValues(orgId, userId, "src-bad"),
          sourceKind: "bogus" as never,
        })
      }),
      "23514",
    )
  })

  it("accepts the 'paused_app_disabled' status", async () => {
    const { orgId, userId } = await makeOrgUser()
    const [row] = await withPrivilegedDb(orgId, "routines-paused-app", (tx) =>
      tx
        .insert(routines)
        .values({
          ...baseValues(orgId, userId, "paused-app"),
          status: "paused_app_disabled",
        })
        .returning(),
    )
    expect(row.status).toBe("paused_app_disabled")
  })

  it("still accepts recurring + scheduled (regression)", async () => {
    const { orgId, userId } = await makeOrgUser()
    const [rec] = await withPrivilegedDb(orgId, "routines-event-regress", (tx) =>
      tx
        .insert(routines)
        .values({
          ...baseValues(orgId, userId, "rec-regress"),
          kind: "recurring",
          cron: "0 9 * * *",
          timezone: "UTC",
        })
        .returning(),
    )
    expect(rec.kind).toBe("recurring")
  })
})

describe("routines schema — owner_agent_id (A15 sequencing)", () => {
  it("ROUTINES SCHEMA: owner_agent_id column exists and is nullable", async () => {
    const rows = (await rawSql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'kernel' AND table_name = 'routines'
        AND column_name = 'owner_agent_id'
    `) as unknown as Array<{ column_name: string; is_nullable: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.column_name).toBe("owner_agent_id")
    expect(rows[0]?.is_nullable).toBe("YES")
  })
})
