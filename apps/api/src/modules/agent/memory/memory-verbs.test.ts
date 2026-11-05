// SPDX-License-Identifier: FSL-1.1-ALv2
// P4m-T10: the six file verbs over the memory tree. Anthropic's memory tool
// contract: an ambiguous replace is an error, not a guess, and a create never
// silently overwrites.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"

const ORG_ID = "00000000-0000-0000-0000-000000d70001"
const USER_A = "00000000-0000-0000-0000-000000d70002"
const AGENT_A = "00000000-0000-0000-0000-000000d70003"

const actorA: UserContext = {
  actorType: "user",
  userId: USER_A,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

function ctxFor(tx: unknown) {
  return { userId: USER_A, orgId: ORG_ID, db: tx, scopes: [] } as never
}

async function readIndex(): Promise<string> {
  const [row] = await sql<{ content: string }[]>`SELECT content FROM kernel.agent_memory
    WHERE org_id = ${ORG_ID} AND type = '_index' AND name = '_index'`
  return row?.content ?? ""
}

describe("memory verbs", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'VerbOrg', 'verb-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_A}, ${ORG_ID}, 'verb-a@test.com', 'Verb A', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT_A}, ${ORG_ID}, 'personal', '@verb-a', 'Liaison', ${USER_A})
      ON CONFLICT DO NOTHING`
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

  it("memory_create refuses a path that already exists", async () => {
    const { memoryCreate } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      await memoryCreate({ path: "project/q3.md", body: "Ship on the 14th." }, ctxFor(tx))
      await expect(
        memoryCreate({ path: "project/q3.md", body: "Different." }, ctxFor(tx)),
      ).rejects.toThrow(/already exists/i)
    })
    const rows = await sql`SELECT id FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type = 'project' AND name = 'q3'`
    expect(rows.length).toBe(1)
  })

  it("memory_str_replace refuses an ambiguous old string", async () => {
    const { memoryCreate, memoryStrReplace } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      await memoryCreate({ path: "project/q3.md", body: "DHL twice: DHL" }, ctxFor(tx))
      await expect(
        memoryStrReplace({ path: "project/q3.md", old: "DHL", new: "UPS" }, ctxFor(tx)),
      ).rejects.toThrow(/more than once/i)
    })
    const [row] = await sql<{ content: string }[]>`SELECT content FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type = 'project' AND name = 'q3'`
    expect(row.content).toBe("DHL twice: DHL")
  })

  it("memory_view of a missing MEMORY.md is a typed 404, not a server fault", async () => {
    // An agent with no memory yet has no index row. The tool layers log a typed
    // 4xx at warn and an untyped throw at error, which pages the watchdog.
    const { memoryView } = await import("./memory")
    let caught: unknown = null
    await withRlsContext(actorA, async (tx) => {
      try {
        await memoryView({ path: "MEMORY.md" }, ctxFor(tx))
      } catch (err) {
        caught = err
      }
    })
    const err = caught as { message?: string; status?: unknown; code?: unknown } | null
    expect(err?.message).toBe("No memory file at MEMORY.md")
    expect(err?.status).toBe(404)
    expect(err?.code).toBe("E_MEMORY_NOT_FOUND")
  })

  it("memory_str_replace refuses an old string that is absent", async () => {
    const { memoryCreate, memoryStrReplace } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      await memoryCreate({ path: "project/q3.md", body: "Ship on the 14th." }, ctxFor(tx))
      await expect(
        memoryStrReplace({ path: "project/q3.md", old: "FedEx", new: "UPS" }, ctxFor(tx)),
      ).rejects.toThrow(/not found/i)
    })
  })

  it("memory_view on a directory lists its files and on a file returns the frontmatter and body", async () => {
    const { memoryCreate, memoryView } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      await memoryCreate({ path: "project/q3.md", body: "Ship on the 14th." }, ctxFor(tx))
      await memoryCreate({ path: "project/dhl.md", body: "Account 12345." }, ctxFor(tx))

      const listing = (await memoryView({ path: "project" }, ctxFor(tx))) as {
        entries: string[]
      }
      expect(listing.entries.length).toBe(2)

      const file = (await memoryView({ path: "project/q3.md" }, ctxFor(tx))) as { body: string }
      expect(file.body.startsWith("---\n")).toBe(true)
      expect(file.body.endsWith("Ship on the 14th.")).toBe(true)
    })
  })

  it("memory_rename moves the path and rewrites exactly one index line", async () => {
    const { memoryCreate, memoryRename } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      await memoryCreate({ path: "project/q3.md", body: "Ship on the 14th." }, ctxFor(tx))
      await memoryCreate({ path: "project/dhl.md", body: "Account 12345." }, ctxFor(tx))
      await memoryRename({ from: "project/q3.md", to: "project/q3-launch.md" }, ctxFor(tx))
    })
    const index = await readIndex()
    const lines = index.split("\n").filter((l) => l.trim() !== "")
    expect(lines.length).toBe(2)
    expect(lines.filter((l) => l.includes("(project/q3-launch.md)")).length).toBe(1)
    expect(index).not.toContain("(project/q3.md)")
  })

  // FX1 item 1: `visibleRows` is the ONLY requiredScopes enforcement on a
  // personal agent's OWN rows. 0057 grants the owner an unconditional read, so
  // RLS lets every row of theirs through and the scope filter in the service is
  // what a narrowed turn actually runs into. Dropping it left all 45 cases of
  // this suite green, which is why these exist: they fail the moment
  // `visibleRows` returns rows unfiltered.
  describe("required scopes on the caller's own rows", () => {
    const SCOPED = "finance:payouts:read"

    async function seedScopedRow(): Promise<void> {
      await sql`INSERT INTO kernel.agent_memory
        (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes)
        VALUES (${ORG_ID}, ${USER_A}, ${AGENT_A}, 'project', 'payouts', 'payout run',
                'PAYOUT_ROW_MARKER', 'project/payouts.md', ARRAY[${SCOPED}]::text[])`
    }

    it("memory_view on a scoped file throws not found for a turn without the scope", async () => {
      await seedScopedRow()
      const { memoryView } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        await expect(memoryView({ path: "project/payouts.md" }, ctxFor(tx))).rejects.toThrow(
          /No memory file at/,
        )
      })
    })

    it("memory_view on the type folder omits the scoped file for a turn without the scope", async () => {
      await seedScopedRow()
      const { memoryCreate, memoryView } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        await memoryCreate({ path: "project/q3.md", body: "Ship on the 14th." }, ctxFor(tx))
        const listing = (await memoryView({ path: "project" }, ctxFor(tx))) as { entries: string[] }
        expect(listing.entries).toContain("project/q3.md")
        expect(listing.entries).not.toContain("project/payouts.md")
      })
    })

    it("memory_view returns the scoped file to a turn that holds the scope", async () => {
      await seedScopedRow()
      const { memoryView } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        const ctx = { userId: USER_A, orgId: ORG_ID, db: tx, scopes: [SCOPED] } as never
        const file = (await memoryView({ path: "project/payouts.md" }, ctx)) as { body: string }
        expect(file.body).toContain("PAYOUT_ROW_MARKER")
        const listing = (await memoryView({ path: "project" }, ctx)) as { entries: string[] }
        expect(listing.entries).toContain("project/payouts.md")
      })
    })

    // FX1 item 2: existence is not a read. `memoryCreate` asked the SCOPE
    // FILTERED set whether the path was taken, so a turn that could not see the
    // file was told the path was free; `handleMemorySet` then upserted on
    // (orgId, ownerAgentId, type, name) with no visibility check of its own and
    // replaced the invisible file's body. The existence question is answered
    // against the unfiltered set, and the caller gets the same "already exists"
    // refusal the visible case gets: it discloses a path the caller already
    // named, and nothing about the content.
    it("memory_create refuses a path held by a file the turn cannot see, and never overwrites it", async () => {
      await seedScopedRow()
      const { memoryCreate } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        await expect(
          memoryCreate({ path: "project/payouts.md", body: "INJECTED_BODY" }, ctxFor(tx)),
        ).rejects.toThrow(/already exists/i)
      })
      const [row] = await sql<{ content: string }[]>`SELECT content FROM kernel.agent_memory
        WHERE org_id = ${ORG_ID} AND type = 'project' AND name = 'payouts'`
      expect(row.content).toBe("PAYOUT_ROW_MARKER")
    })

    it("memory_rename refuses a target held by a file the turn cannot see", async () => {
      await seedScopedRow()
      const { memoryCreate, memoryRename } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        await memoryCreate({ path: "project/q3.md", body: "INJECTED_BODY" }, ctxFor(tx))
        await expect(
          memoryRename({ from: "project/q3.md", to: "project/payouts.md" }, ctxFor(tx)),
        ).rejects.toThrow(/already exists/i)
      })
      const [row] = await sql<{ content: string }[]>`SELECT content FROM kernel.agent_memory
        WHERE org_id = ${ORG_ID} AND type = 'project' AND name = 'payouts'`
      expect(row.content).toBe("PAYOUT_ROW_MARKER")
    })

    it("memory_str_replace cannot reach a scoped file from a turn without the scope", async () => {
      await seedScopedRow()
      const { memoryStrReplace } = await import("./memory")
      await withRlsContext(actorA, async (tx) => {
        await expect(
          memoryStrReplace(
            { path: "project/payouts.md", old: "PAYOUT_ROW_MARKER", new: "OVERWRITTEN" },
            ctxFor(tx),
          ),
        ).rejects.toThrow(/No memory file at/)
      })
      const [row] = await sql<{ content: string }[]>`SELECT content FROM kernel.agent_memory
        WHERE org_id = ${ORG_ID} AND type = 'project' AND name = 'payouts'`
      expect(row.content).toBe("PAYOUT_ROW_MARKER")
    })
  })

  // FX1 item 10: the description is quoted into MEMORY.md, which is in context
  // every turn, so it is a budget item. `firstLineOf` was already capped at 160;
  // a description the model wrote in the file's own frontmatter was not.
  it("memory_create bounds a frontmatter description to 160 characters", async () => {
    const { memoryCreate } = await import("./memory")
    const long = "d".repeat(400)
    await withRlsContext(actorA, async (tx) => {
      await memoryCreate(
        { path: "project/q3.md", body: `---\ndescription: ${long}\n---\nShip on the 14th.` },
        ctxFor(tx),
      )
    })
    const [row] = await sql<{ description: string }[]>`SELECT description FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type = 'project' AND name = 'q3'`
    expect(row.description.length).toBe(160)
  })

  it("a memory write on a turn with unknown taint throws scopeUnknownError", async () => {
    const { memoryCreate } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      const blindCtx = { userId: USER_A, orgId: ORG_ID, db: tx } as never
      await expect(
        memoryCreate({ path: "project/q3.md", body: "Ship on the 14th." }, blindCtx),
      ).rejects.toThrow(/scope_unknown/)
    })
  })

  // FX1 item 8: every other verb refuses a turn whose taint cannot be
  // established, because an untagged write reads as "this turn touched no
  // scoped data" to every later reader. Delete is a write like the rest: a
  // turn that cannot say what it read must not be the one erasing a file.
  it("a memory delete on a turn with unknown taint throws scopeUnknownError", async () => {
    const { memoryCreate, memoryDelete } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      await memoryCreate({ path: "project/q3.md", body: "Ship on the 14th." }, ctxFor(tx))
      const blindCtx = { userId: USER_A, orgId: ORG_ID, db: tx } as never
      await expect(memoryDelete({ path: "project/q3.md" }, blindCtx)).rejects.toThrow(
        /scope_unknown/,
      )
    })
    const rows = await sql`SELECT id FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type = 'project' AND name = 'q3'`
    expect(rows.length).toBe(1)
  })
})
