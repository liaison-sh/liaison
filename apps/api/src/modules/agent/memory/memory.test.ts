// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"

const ORG_ID = "00000000-0000-0000-0000-000000d50001"
const USER_A = "00000000-0000-0000-0000-000000d50002"
const USER_B = "00000000-0000-0000-0000-000000d50003"
const AGENT_A = "00000000-0000-0000-0000-000000d50004"
const AGENT_B = "00000000-0000-0000-0000-000000d50005"

describe("agent user memory (typed)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'MemOrg', 'mem-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_A}, ${ORG_ID}, 'mem-a@test.com', 'Mem A', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_B}, ${ORG_ID}, 'mem-b@test.com', 'Mem B', 'x') ON CONFLICT DO NOTHING`
    // Personal agents — memory.ts resolves the acting user's owner_agent_id
    // from this table on every write (migration 0055 rekey).
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT_A}, ${ORG_ID}, 'personal', '@mem-a', 'Liaison', ${USER_A}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT_B}, ${ORG_ID}, 'personal', '@mem-b', 'Liaison', ${USER_B}) ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
  })

  const actorA: UserContext = {
    actorType: "user",
    userId: USER_A,
    orgId: ORG_ID,
    scopes: ["*"],
    dimensionGrants: {},
  }
  const actorB: UserContext = {
    actorType: "user",
    userId: USER_B,
    orgId: ORG_ID,
    scopes: ["*"],
    dimensionGrants: {},
  }

  describe("handleMemorySet", () => {
    it("creates detail entry and updates index with MEMORY.md-style line", async () => {
      const { handleMemorySet } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
        await handleMemorySet(
          {
            type: "user",
            name: "role",
            description: "Senior eng on platform team",
            content: "Taylor leads platform reliability.",
          },
          ctx as any,
          [],
        )
      })

      const [detail] = await sql`SELECT * FROM kernel.agent_memory
        WHERE org_id = ${ORG_ID} AND user_id = ${USER_A} AND type = 'user' AND name = 'role'`
      expect(detail.content).toBe("Taylor leads platform reliability.")
      expect(detail.description).toBe("Senior eng on platform team")

      const [idx] = await sql`SELECT content FROM kernel.agent_memory
        WHERE org_id = ${ORG_ID} AND user_id = ${USER_A} AND type = '_index' AND name = '_index'`
      expect(idx.content).toContain("- [Senior eng on platform team](user/role.md), ")
    })

    it("upserts existing entry by (type, name) and updates its index line", async () => {
      const { handleMemorySet } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
        await handleMemorySet(
          { type: "user", name: "role", description: "Frontend dev", content: "..." },
          ctx as any,
          [],
        )
        await handleMemorySet(
          { type: "user", name: "role", description: "Full-stack dev", content: "..." },
          ctx as any,
          [],
        )
      })
      const rows = await sql`SELECT description FROM kernel.agent_memory
        WHERE org_id = ${ORG_ID} AND user_id = ${USER_A} AND type = 'user' AND name = 'role'`
      expect(rows).toHaveLength(1)
      expect(rows[0].description).toBe("Full-stack dev")

      const [idx] = await sql`SELECT content FROM kernel.agent_memory
        WHERE org_id = ${ORG_ID} AND user_id = ${USER_A} AND type = '_index' AND name = '_index'`
      expect(idx.content).toContain("Full-stack dev")
      expect(idx.content).not.toContain("Frontend dev")
    })

    it("rejects type='_index' or name='_index' from external callers", async () => {
      const { handleMemorySet } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
        await expect(
          handleMemorySet(
            { type: "_index" as any, name: "x", description: "x", content: "x" },
            ctx as any,
            [],
          ),
        ).rejects.toThrow(/reserved/i)
        await expect(
          handleMemorySet(
            { type: "user", name: "_index", description: "x", content: "x" },
            ctx as any,
            [],
          ),
        ).rejects.toThrow(/reserved/i)
      })
    })

    it("rejects unknown type values", async () => {
      const { handleMemorySet } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
        await expect(
          handleMemorySet(
            { type: "nonsense" as any, name: "x", description: "x", content: "x" },
            ctx as any,
            [],
          ),
        ).rejects.toThrow(/type/i)
      })
    })

    it("hostile descriptions cannot hijack another entry's index line (end-of-line tag anchor)", async () => {
      const { handleMemorySet, handleMemoryGet } = await import("./memory")
      // Sequence: write a description that contains a fake tag for another
      // entry's path, then write a real entry named `decoy`. The parser anchors
      // its tag-match at end-of-line; the hostile substring is not
      // line-terminal, so the second write must NOT overwrite the first
      // entry's line. Both entries should appear in the index.
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
        await handleMemorySet(
          {
            type: "user",
            name: "first",
            description: "see ](user/decoy.md), 2026-09-12 for details",
            content: "a",
          },
          ctx as any,
          [],
        )
        await handleMemorySet(
          {
            type: "user",
            name: "decoy",
            description: "Honest description",
            content: "b",
          },
          ctx as any,
          [],
        )
        const result = (await handleMemoryGet({}, ctx as any)) as { index: string }
        const lines = result.index.split("\n").filter((l) => l.trim() !== "")
        // Both entries get their own line.
        expect(lines.find((l) => /\]\(user\/first\.md\), \d{4}-\d{2}-\d{2}$/.test(l))).toBeDefined()
        expect(lines.find((l) => /\]\(user\/decoy\.md\), \d{4}-\d{2}-\d{2}$/.test(l))).toBeDefined()
      })
    })
  })

  describe("handleMemoryGet", () => {
    it("returns MEMORY.md-style index when called with no args", async () => {
      const { handleMemorySet, handleMemoryGet } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
        await handleMemorySet(
          { type: "user", name: "tone", description: "Prefers terse responses", content: "..." },
          ctx as any,
          [],
        )
        await handleMemorySet(
          { type: "feedback", name: "no-emoji", description: "Never use emoji", content: "..." },
          ctx as any,
          [],
        )
        const result = (await handleMemoryGet({}, ctx as any)) as { index: string }
        expect(result.index).toContain("- [Prefers terse responses](user/tone.md), ")
        expect(result.index).toContain("- [Never use emoji](feedback/no-emoji.md), ")
        // The index never references itself.
        expect(result.index).not.toContain("](_index")
      })
    })

    it("returns full detail entry for (type, name)", async () => {
      const { handleMemorySet, handleMemoryGet } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
        await handleMemorySet(
          { type: "user", name: "role", description: "Senior eng", content: "Body" },
          ctx as any,
          [],
        )
        const detail = await handleMemoryGet({ type: "user", name: "role" }, ctx as any)
        expect(detail).toMatchObject({
          type: "user",
          name: "role",
          description: "Senior eng",
        })
        expect((detail as any).content).toBe("Body")
      })
    })

    it("lists every entry in one type, never including _index", async () => {
      const { handleMemorySet, handleMemoryGet } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
        await handleMemorySet(
          { type: "user", name: "a", description: "A", content: "a" },
          ctx as any,
          [],
        )
        await handleMemorySet(
          { type: "user", name: "b", description: "B", content: "b" },
          ctx as any,
          [],
        )
        const result = (await handleMemoryGet({ type: "user" }, ctx as any)) as {
          entries: { name: string }[]
        }
        expect(result.entries.map((e) => e.name).sort()).toEqual(["a", "b"])
        expect(result.entries.find((e) => e.name === "_index")).toBeUndefined()
      })
    })

    it("returns empty index when there are no memories", async () => {
      const { handleMemoryGet } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
        const result = await handleMemoryGet({}, ctx as any)
        expect((result as any).index).toBe("")
      })
    })
  })

  describe("handleMemoryDelete", () => {
    it("removes the entry and its line from the index", async () => {
      const { handleMemorySet, handleMemoryDelete, handleMemoryGet } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
        await handleMemorySet(
          { type: "project", name: "q3-launch", description: "Q3 launch", content: "..." },
          ctx as any,
          [],
        )
        await handleMemoryDelete({ type: "project", name: "q3-launch" }, ctx as any)
        const result = (await handleMemoryGet({}, ctx as any)) as { index: string }
        expect(result.index).not.toContain("q3-launch")
      })

      const rows = await sql`SELECT * FROM kernel.agent_memory
        WHERE org_id = ${ORG_ID} AND user_id = ${USER_A} AND type = 'project' AND name = 'q3-launch'`
      expect(rows.length).toBe(0)
    })

    it("rejects deleting the reserved _index slot", async () => {
      const { handleMemoryDelete } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
        await expect(
          handleMemoryDelete({ type: "_index" as any, name: "_index" }, ctx as any),
        ).rejects.toThrow(/reserved/i)
      })
    })

    it("rejects unknown type values (defense-in-depth past the Zod boundary)", async () => {
      const { handleMemoryDelete } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
        await expect(
          handleMemoryDelete({ type: "nonsense" as any, name: "x" }, ctx as any),
        ).rejects.toThrow(/type/i)
      })
    })
  })

  describe("RLS isolation", () => {
    it("user B cannot see user A's memories", async () => {
      const { handleMemorySet, handleMemoryGet } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx }
        await handleMemorySet(
          { type: "user", name: "secret", description: "A's secret", content: "..." },
          ctx as any,
          [],
        )
      })

      await withRlsContext(actorB, async (tx) => {
        const ctx = { userId: USER_B, orgId: ORG_ID, db: tx }
        const result = await handleMemoryGet({ type: "user", name: "secret" }, ctx as any)
        // RLS returns no rows → service returns the fallback empty index shape.
        expect((result as any).content).toBeUndefined()
      })
    })
  })
})

describe("agent user memory: the caller's intersected scope filters reads", () => {
  const ORG = "00000000-0000-0000-0000-000000d51001"
  const USER = "00000000-0000-0000-0000-000000d51002"
  const AGENT = "00000000-0000-0000-0000-000000d51003"

  const actor = (scopes: string[]): UserContext => ({
    actorType: "user",
    userId: USER,
    orgId: ORG,
    scopes,
    dimensionGrants: {},
  })

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'MemScopeOrg', 'mem-scope-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER}, ${ORG}, 'mem-scope@test.com', 'Mem Scope', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT}, ${ORG}, 'personal', '@mem-scope', 'Liaison', ${USER}) ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG}`
  })

  // A row requiring a scope the GRANTOR holds but the agent's ceiling excludes,
  // which is exactly what an agent bound MCP connection resolves to.
  async function seedScopedRow() {
    await sql`INSERT INTO kernel.agent_memory
        (org_id, user_id, owner_agent_id, type, name, description, content, required_scopes)
      VALUES (${ORG}, ${USER}, ${AGENT}, 'project', 'payroll', 'Payroll numbers',
              'secret', ${["finance:payroll:read"]})`
    await sql`INSERT INTO kernel.agent_memory
        (org_id, user_id, owner_agent_id, type, name, description, content, required_scopes)
      VALUES (${ORG}, ${USER}, ${AGENT}, 'project', 'public', 'Open note', 'fine', ${[]})`
  }

  it("user_memory_get only returns rows within the caller's intersected scope", async () => {
    const { handleMemoryGet } = await import("./memory")
    await seedScopedRow()

    // The narrowed set an agent bound connection acts with.
    const narrowed = await withRlsContext(actor(["kernel:agent:memory"]), (tx) =>
      handleMemoryGet({ type: "project" }, {
        userId: USER,
        orgId: ORG,
        db: tx,
        scopes: ["kernel:agent:memory"],
      } as never),
    )
    const names = (narrowed as { entries: Array<{ name: string }> }).entries.map((e) => e.name)
    expect(names).toContain("public")
    expect(names).not.toContain("payroll")

    // Named directly, the withheld row reads as absent, never as denied.
    const direct = await withRlsContext(actor(["kernel:agent:memory"]), (tx) =>
      handleMemoryGet({ type: "project", name: "payroll" }, {
        userId: USER,
        orgId: ORG,
        db: tx,
        scopes: ["kernel:agent:memory"],
      } as never),
    )
    expect(direct).toEqual({ index: "" })

    // The unintersected grantor set still sees it, so this filtered rather than
    // hid the row from everyone.
    const wide = await withRlsContext(actor(["*"]), (tx) =>
      handleMemoryGet({ type: "project", name: "payroll" }, {
        userId: USER,
        orgId: ORG,
        db: tx,
        scopes: ["finance:payroll:read"],
      } as never),
    )
    expect((wide as { content?: string }).content).toBe("secret")
  })

  it("user_memory_delete cannot erase a row the caller cannot read", async () => {
    const { handleMemoryDelete } = await import("./memory")
    await seedScopedRow()

    await withRlsContext(actor(["kernel:agent:memory"]), (tx) =>
      handleMemoryDelete({ type: "project", name: "payroll" }, {
        userId: USER,
        orgId: ORG,
        db: tx,
        scopes: ["kernel:agent:memory"],
      } as never),
    )

    const rows = await sql<{ name: string }[]>`
      SELECT name FROM kernel.agent_memory WHERE org_id = ${ORG} AND name = 'payroll'`
    expect(rows.length).toBe(1)
  })

  // FX2 item 7: the same hole one method over. `handleMemoryPatch` went
  // straight to the UPDATE, so a row the caller cannot read was rewritable by
  // naming it. Silent omission, as everywhere else here: it answers "no such
  // entry" (null), never "access denied", and the row is untouched.
  it("handleMemoryPatch cannot rewrite a row the caller cannot read", async () => {
    const { handleMemoryPatch } = await import("./memory")
    await seedScopedRow()

    const result = await withRlsContext(actor(["kernel:agent:memory"]), (tx) =>
      handleMemoryPatch(
        { type: "project", name: "payroll", content: "OVERWRITTEN" },
        {
          userId: USER,
          orgId: ORG,
          db: tx,
          scopes: ["kernel:agent:memory"],
        } as never,
        [],
      ),
    )
    expect(result).toBeNull()

    const rows = await sql<{ content: string }[]>`
      SELECT content FROM kernel.agent_memory WHERE org_id = ${ORG} AND name = 'payroll'`
    expect(rows[0]?.content).toBe("secret")
  })

  it("handleMemoryPatch rewrites the same row for a caller who holds the scope", async () => {
    const { handleMemoryPatch } = await import("./memory")
    await seedScopedRow()

    const result = await withRlsContext(actor(["finance:payroll:read"]), (tx) =>
      handleMemoryPatch(
        { type: "project", name: "payroll", content: "OVERWRITTEN" },
        {
          userId: USER,
          orgId: ORG,
          db: tx,
          scopes: ["finance:payroll:read"],
        } as never,
        [],
      ),
    )
    expect(result).not.toBeNull()

    const rows = await sql<{ content: string }[]>`
      SELECT content FROM kernel.agent_memory WHERE org_id = ${ORG} AND name = 'payroll'`
    expect(rows[0]?.content).toBe("OVERWRITTEN")
  })
})
