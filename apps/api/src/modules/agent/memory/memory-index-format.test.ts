// SPDX-License-Identifier: FSL-1.1-ALv2
// P4m-T08: MEMORY.md's line format is the tree's path form, and the parser
// anchor moves with it. Both change together or the index silently stops
// matching its own lines and duplicates entries instead of replacing them.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"

const ORG_ID = "00000000-0000-0000-0000-000000d60001"
const USER_A = "00000000-0000-0000-0000-000000d60002"
const AGENT_A = "00000000-0000-0000-0000-000000d60003"

const actorA: UserContext = {
  actorType: "user",
  userId: USER_A,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

async function readIndex(): Promise<string> {
  const [row] = await sql<{ content: string }[]>`SELECT content FROM kernel.agent_memory
    WHERE org_id = ${ORG_ID} AND type = '_index' AND name = '_index'`
  return row?.content ?? ""
}

describe("MEMORY.md index line format", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'IdxOrg', 'idx-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_A}, ${ORG_ID}, 'idx-a@test.com', 'Idx A', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT_A}, ${ORG_ID}, 'personal', '@idx-a', 'Liaison', ${USER_A})
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

  it("an index line uses the path form and carries no dash punctuation", async () => {
    const { renderIndexLine } = await import("./memory")
    const line = renderIndexLine(
      "user",
      "response-format",
      "Prefers bullet points",
      new Date("2026-09-12T23:59:00.000Z"),
    )
    expect(line).toBe("- [Prefers bullet points](user/response-format.md), 2026-09-12")
    expect(line.split("—").length - 1).toBe(0)
    expect(line.split("–").length - 1).toBe(0)
  })

  it("updating an entry replaces its own line and leaves the other lines untouched", async () => {
    const { handleMemorySet } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      const ctx = { userId: USER_A, orgId: ORG_ID, db: tx } as never
      for (const name of ["alpha", "bravo", "charlie"]) {
        await handleMemorySet(
          { type: "user", name, description: `about ${name}`, content: "body" },
          ctx,
          [],
        )
      }
      await handleMemorySet(
        { type: "user", name: "bravo", description: "about bravo, revised", content: "body" },
        ctx,
        [],
      )
    })

    const lines = (await readIndex()).split("\n")
    expect(lines.length).toBe(3)
    expect(lines[0]).toContain("(user/alpha.md)")
    expect(lines[1]).toContain("about bravo, revised")
    expect(lines[2]).toContain("(user/charlie.md)")
  })

  it("a write with its own clock stamps the row and its line with it, not the wall clock", async () => {
    const { handleMemorySet } = await import("./memory")
    const now = new Date("2025-01-15T09:00:00.000Z")
    await withRlsContext(actorA, async (tx) => {
      const ctx = { userId: USER_A, orgId: ORG_ID, db: tx, now } as never
      await handleMemorySet(
        { type: "user", name: "clocked", description: "about the clock", content: "body" },
        ctx,
        [],
      )
      // A second write of the same entry goes through the update branch.
      await handleMemorySet(
        { type: "user", name: "clocked", description: "about the clock, again", content: "b" },
        ctx,
        [],
      )
    })

    expect(await readIndex()).toBe("- [about the clock, again](user/clocked.md), 2025-01-15")
    const rows = await sql<
      { type: string; updated_at: string; last_confirmed_at: string | null }[]
    >`
      SELECT type, updated_at, last_confirmed_at FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    expect(rows.length).toBe(2)
    for (const row of rows) expect(new Date(row.updated_at).getTime()).toBe(now.getTime())
    const entry = rows.find((r) => r.type === "user")
    expect(new Date(entry?.last_confirmed_at ?? 0).getTime()).toBe(now.getTime())
  })

  it("a line written in the old em dash form is still removable", async () => {
    const { handleMemoryDelete, handleMemorySet } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      const ctx = { userId: USER_A, orgId: ORG_ID, db: tx } as never
      await handleMemorySet(
        { type: "user", name: "legacy", description: "a legacy entry", content: "body" },
        ctx,
        [],
      )
    })
    // Rewrite the index the way it was rendered before this task.
    const legacy = ["- [a legacy entry](legacy) — user", "- [another](other) — user"].join("\n")
    await sql`UPDATE kernel.agent_memory SET content = ${legacy}
      WHERE org_id = ${ORG_ID} AND type = '_index' AND name = '_index'`

    await withRlsContext(actorA, async (tx) => {
      const ctx = { userId: USER_A, orgId: ORG_ID, db: tx } as never
      await handleMemoryDelete({ type: "user", name: "legacy" }, ctx)
    })

    const lines = (await readIndex()).split("\n").filter((l) => l.trim() !== "")
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain("(other)")
  })
})

// P4m-T09: the index has hard caps. Past 160 lines the runtime context says so;
// at 200 lines or 25600 bytes a write is REFUSED with the exact copy and the
// five least recently confirmed entries. Never a silent truncation.
describe("MEMORY.md caps", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'IdxOrg', 'idx-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_A}, ${ORG_ID}, 'idx-a@test.com', 'Idx A', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT_A}, ${ORG_ID}, 'personal', '@idx-a', 'Liaison', ${USER_A})
      ON CONFLICT DO NOTHING`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
  })

  async function seedIndex(lines: string[]): Promise<void> {
    await sql`INSERT INTO kernel.agent_memory
      (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes)
      VALUES (${ORG_ID}, ${USER_A}, ${AGENT_A}, '_index', '_index', 'index',
              ${lines.join("\n")}, 'MEMORY.md', '{}')`
  }

  async function seedEntry(name: string, confirmedAt: string | null): Promise<void> {
    await sql`INSERT INTO kernel.agent_memory
      (org_id, user_id, owner_agent_id, type, name, description, content, path,
       required_scopes, last_confirmed_at)
      VALUES (${ORG_ID}, ${USER_A}, ${AGENT_A}, 'user', ${name}, ${`about ${name}`}, 'body',
              ${`user/${name}.md`}, '{}', ${confirmedAt})`
  }

  async function attemptWrite(): Promise<unknown> {
    const { handleMemorySet } = await import("./memory")
    return await withRlsContext(actorA, async (tx) => {
      const ctx = { userId: USER_A, orgId: ORG_ID, db: tx } as never
      return await handleMemorySet(
        { type: "project", name: "one-too-many", description: "the straw", content: "body" },
        ctx,
        [],
      )
    })
  }

  it("a write that would push MEMORY.md past 200 lines is refused with the exact index full string", async () => {
    await seedIndex(
      Array.from({ length: 200 }, (_, i) => `- [entry ${i}](user/e${i}.md), 2026-09-01`),
    )
    await expect(attemptWrite()).rejects.toThrow(
      "MEMORY.md is full. Merge or remove an entry before adding one.",
    )
  })

  it("the index full refusal names the five least recently confirmed entries", async () => {
    await seedIndex(
      Array.from({ length: 200 }, (_, i) => `- [entry ${i}](user/e${i}.md), 2026-09-01`),
    )
    // Written oldest first, so the expected candidate order is the seed order.
    const seeded = [
      ["oldest", "2026-01-01T00:00:00Z"],
      ["second", "2026-02-01T00:00:00Z"],
      ["third", "2026-03-01T00:00:00Z"],
      ["fourth", "2026-04-01T00:00:00Z"],
      ["fifth", "2026-05-01T00:00:00Z"],
      ["sixth", "2026-06-01T00:00:00Z"],
    ] as const
    for (const [name, at] of seeded) await seedEntry(name, at)

    let caught: { code?: string; candidates?: Array<{ path: string }> } | undefined
    try {
      await attemptWrite()
    } catch (err) {
      caught = err as never
    }
    expect(caught?.code).toBe("E_MEMORY_INDEX_FULL")
    expect(caught?.candidates?.length).toBe(5)
    expect(caught?.candidates?.map((c) => c.path)).toEqual([
      "user/oldest.md",
      "user/second.md",
      "user/third.md",
      "user/fourth.md",
      "user/fifth.md",
    ])
  })

  it("the index is refused past 25 KB even under 200 lines", async () => {
    const long = "x".repeat(700)
    await seedIndex(Array.from({ length: 40 }, (_, i) => `- [${long}](user/e${i}.md), 2026-09-01`))
    await expect(attemptWrite()).rejects.toThrow(
      "MEMORY.md is full. Merge or remove an entry before adding one.",
    )
  })

  // FX1 item 10: the cap is INCLUSIVE. 200 lines is the cap, not one past it,
  // and a write landing exactly on it must be accepted: an off by one here
  // refuses the last legal entry and sends the model consolidating a full
  // index it is still allowed to fill.
  it("a write that lands MEMORY.md on exactly 200 lines is accepted", async () => {
    await seedIndex(
      Array.from({ length: 199 }, (_, i) => `- [entry ${i}](user/e${i}.md), 2026-09-01`),
    )
    await expect(attemptWrite()).resolves.toEqual({ saved: true })
    const lines = (await readIndex()).split("\n").filter((l) => l.trim() !== "")
    expect(lines.length).toBe(200)
  })

  it("past 160 lines the near limit flag is set and under 160 it is not", async () => {
    const { memoryIndexFill } = await import("./memory")
    const at161 = Array.from({ length: 161 }, (_, i) => `- [e${i}](user/e${i}.md), 2026-09-01`)
    const at159 = Array.from({ length: 159 }, (_, i) => `- [e${i}](user/e${i}.md), 2026-09-01`)
    expect(memoryIndexFill(at161.join("\n")).nearLimit).toBe(true)
    expect(memoryIndexFill(at161.join("\n")).lines).toBe(161)
    expect(memoryIndexFill(at159.join("\n")).nearLimit).toBe(false)
  })
})
