// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0221: every agent gets a stored avatar colour. Per org, agents take distinct
// slots in creation order (live role agents, then the built-in agent, then the
// archived ones), wrapping only past eight with the repeats spread evenly; a colour
// already stored is kept; another org is numbered on its own; a second run
// changes nothing; the CHECK refuses a slot outside 0-7.
//
// Everything runs in ONE transaction on one superuser connection and is rolled
// back, so tests sharing this database see nothing.

import { afterAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0221_agents_avatar_color.sql", import.meta.url).pathname

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const conn = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

afterAll(async () => {
  await conn.end()
})

class Rollback extends Error {}

type Row = { handle: string; color: number | null }

describe("0221 agents avatar color", () => {
  it("gives each org's agents distinct colours in creation order, once", async () => {
    const big = crypto.randomUUID()
    const small = crypto.randomUUID()
    let bigAfter: Row[] = []
    let smallAfter: Row[] = []
    let bigAgain: Row[] = []
    let smallAgain: Row[] = []
    let outOfRange: unknown = null
    await conn
      .begin(async (tx) => {
        for (const [id, name] of [
          [big, "Big"],
          [small, "Small"],
        ] as const) {
          await tx`INSERT INTO kernel.organizations (id, name, slug)
            VALUES (${id}, ${`${name} Org`}, ${`colors-${name.toLowerCase()}-${id.slice(0, 8)}`})`
        }
        // Ten live role agents, created a minute apart, plus an archived one
        // and the built-in agent, both created first: the built-in ranks after
        // every live role agent, the archived one after every live agent.
        const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes))
        const agent = (
          org: string,
          handle: string,
          created: Date,
          extra: { kind?: string; archived?: boolean; color?: number | null } = {},
        ) =>
          tx`INSERT INTO kernel.agents (org_id, kind, handle, display_name, created_at, archived_at, avatar_color)
             VALUES (${org}, ${extra.kind ?? "role"}, ${handle}, ${handle}, ${created},
                     ${extra.archived ? created : null}, ${extra.color ?? null})`
        await agent(big, "@base", at(0), { kind: "system" })
        await agent(big, "@gone", at(0), { archived: true })
        for (let i = 0; i < 10; i++) await agent(big, `@a${i}`, at(i + 1))
        // The small org already has one coloured agent: kept as it is.
        await agent(small, "@first", at(1))
        await agent(small, "@second", at(2), { color: 6 })
        await agent(small, "@third", at(3))

        const read = (org: string) =>
          tx<Row[]>`SELECT handle, avatar_color AS color FROM kernel.agents
                     WHERE org_id = ${org} ORDER BY handle`
        await tx.unsafe(readFileSync(FILE, "utf8"))
        bigAfter = await read(big)
        smallAfter = await read(small)
        await tx.unsafe(readFileSync(FILE, "utf8"))
        bigAgain = await read(big)
        smallAgain = await read(small)
        await tx.unsafe("SAVEPOINT range")
        outOfRange = await tx`UPDATE kernel.agents SET avatar_color = 8 WHERE org_id = ${small}`
          .then(() => null)
          .catch((err: unknown) => err)
        await tx.unsafe("ROLLBACK TO SAVEPOINT range")
        throw new Rollback()
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err
      })

    const color = (rows: Row[], handle: string) => rows.find((r) => r.handle === handle)?.color
    // The first eight live agents take all eight slots, in creation order.
    expect(Array.from({ length: 8 }, (_, i) => color(bigAfter, `@a${i}`))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ])
    // Past eight the slots wrap: the 9th and 10th live agent, then the live
    // built-in one, then the archived one. Every slot is used once or twice.
    expect(color(bigAfter, "@a8")).toBe(0)
    expect(color(bigAfter, "@a9")).toBe(1)
    expect(color(bigAfter, "@base")).toBe(2)
    expect(color(bigAfter, "@gone")).toBe(3)
    const uses = new Map<number, number>()
    for (const r of bigAfter) uses.set(r.color as number, (uses.get(r.color as number) ?? 0) + 1)
    expect(Math.max(...uses.values()) - Math.min(...uses.values())).toBeLessThanOrEqual(1)

    // Another org is numbered on its own, and a stored colour is kept.
    expect(smallAfter).toEqual([
      { handle: "@first", color: 0 },
      { handle: "@second", color: 6 },
      { handle: "@third", color: 2 },
    ])

    expect(bigAgain).toEqual(bigAfter)
    expect(smallAgain).toEqual(smallAfter)
    expect(String((outOfRange as Error | null)?.message)).toContain("agents_avatar_color_range_chk")
  })
})
