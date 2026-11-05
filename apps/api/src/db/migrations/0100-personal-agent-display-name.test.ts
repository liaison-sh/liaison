// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Card 60: "why is the bot called Liaison? We have no such thing anymore, it
// should be called personal agent."
//
// The default moved to PERSONAL_AGENT_DISPLAY_NAME, and 0100 renames the rows
// already carrying the old one. What the rename must NOT do is as load-bearing
// as what it must: a personal agent its owner renamed keeps that name, and a
// role or system agent called "Liaison" is not this migration's business.
//
// The SQL is replayed here against real rows rather than string-matched, over
// the privileged DSN scripts/db-reset.ts establishes (migrations run as an
// owner role; DATABASE_URL is the unprivileged app role).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import postgres from "postgres"

const MIGRATION = new URL("./0100_personal_agent_display_name.sql", import.meta.url).pathname

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

const orgId = crypto.randomUUID()
const ownerId = crypto.randomUUID()
const tag = Date.now().toString(36)
const ids = {
  stillDefault: crypto.randomUUID(),
  renamedByOwner: crypto.randomUUID(),
  roleNamedLiaison: crypto.randomUUID(),
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
            VALUES (${orgId}, ${`Card60 ${tag}`}, ${`card60-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name)
            VALUES (${ownerId}, ${orgId}, ${`owner-${tag}@test.local`}, 'Owner')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
            VALUES (${ids.stillDefault}, ${orgId}, 'personal', ${`@p1-${tag}`}, 'Liaison', ${ownerId})`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
            VALUES (${ids.renamedByOwner}, ${orgId}, 'personal', ${`@p2-${tag}`}, 'Ada', ${ownerId})`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
            VALUES (${ids.roleNamedLiaison}, ${orgId}, 'role', ${`@r1-${tag}`}, 'Liaison')`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agents WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
  await sql.end()
})

async function nameOf(id: string): Promise<string> {
  const [row] = await sql<{ display_name: string }[]>`
    SELECT display_name FROM kernel.agents WHERE id = ${id}`
  return row!.display_name
}

describe("0100: the personal agent is not called Liaison", () => {
  it("renames the personal agents still on the old default, and nothing else", async () => {
    expect(await nameOf(ids.stillDefault)).toBe("Liaison")

    await sql.unsafe(readFileSync(MIGRATION, "utf8"))

    expect(await nameOf(ids.stillDefault)).toBe(PERSONAL_AGENT_DISPLAY_NAME)
    // An owner who named their own agent keeps that name.
    expect(await nameOf(ids.renamedByOwner)).toBe("Ada")
    // A role agent is not a personal agent, whatever it is called.
    expect(await nameOf(ids.roleNamedLiaison)).toBe("Liaison")
  })

  it("the default is not the product's own name", () => {
    // The whole point of card 60: Liaison is the product, not an agent.
    expect(PERSONAL_AGENT_DISPLAY_NAME).not.toBe("Liaison")
    expect(PERSONAL_AGENT_DISPLAY_NAME).toBe("Personal agent")
  })

  it("is safe to replay", async () => {
    await sql.unsafe(readFileSync(MIGRATION, "utf8"))
    expect(await nameOf(ids.stillDefault)).toBe(PERSONAL_AGENT_DISPLAY_NAME)
    expect(await nameOf(ids.renamedByOwner)).toBe("Ada")
  })
})
