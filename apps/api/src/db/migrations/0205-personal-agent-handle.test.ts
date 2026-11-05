// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A personal agent's handle names its owner's agent, not the owner: `@ada` in
// a discussion read as the person Ada. 0205 renames the personal agents created
// under the old `@<name>` form to `@<name>s-agent` (`@<name>-agent` after a
// final "s"), collision-safe within each org, and leaves every other agent and
// the immutability trigger alone.
//
// The SQL is replayed here against real rows, over the privileged DSN
// scripts/db-reset.ts establishes (migrations run as an owner role;
// DATABASE_URL is the unprivileged app role).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const MIGRATION = new URL("./0205_personal_agent_handle.sql", import.meta.url).pathname

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

const orgId = crypto.randomUUID()
const otherOrgId = crypto.randomUUID()
const tag = Date.now().toString(36)

// One owner per personal agent (the check constraint ties each to a user).
const users = {
  ada: crypto.randomUUID(),
  adaTwin: crypto.randomUUID(),
  thomas: crypto.randomUUID(),
  numbered: crypto.randomUUID(),
  migrated: crypto.randomUUID(),
  otherOrg: crypto.randomUUID(),
}
const ids = {
  ada: crypto.randomUUID(),
  adaTwin: crypto.randomUUID(),
  thomas: crypto.randomUUID(),
  numbered: crypto.randomUUID(),
  migrated: crypto.randomUUID(),
  roleHoldingNewName: crypto.randomUUID(),
  roleNamedLikePerson: crypto.randomUUID(),
  otherOrg: crypto.randomUUID(),
}

async function personal(id: string, org: string, owner: string, handle: string, minute: number) {
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, created_at)
            VALUES (${id}, ${org}, 'personal', ${handle}, 'Personal agent', ${owner},
                    ${new Date(Date.UTC(2026, 0, 1, 0, minute))})`
}

beforeAll(async () => {
  for (const [org, slug] of [
    [orgId, `h205-${tag}`],
    [otherOrgId, `h205b-${tag}`],
  ] as const) {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${org}, ${slug}, ${slug})`
  }
  for (const [key, id] of Object.entries(users)) {
    const org = key === "otherOrg" ? otherOrgId : orgId
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
              VALUES (${id}, ${org}, ${`${key}-${tag}@test.local`}, ${key})`
  }
  // A role agent already holds the name the first Ada's agent would take.
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
            VALUES (${ids.roleHoldingNewName}, ${orgId}, 'role', '@adas-agent', 'Front desk')`
  // A role agent whose handle looks like a person's: not a personal agent.
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
            VALUES (${ids.roleNamedLikePerson}, ${orgId}, 'role', '@grace', 'Grace')`
  await personal(ids.ada, orgId, users.ada, "@ada", 1)
  // The old collision discriminator: the second Ada in the org.
  await personal(ids.adaTwin, orgId, users.adaTwin, "@ada2", 2)
  await personal(ids.thomas, orgId, users.thomas, "@thomas", 3)
  // A number that is part of the name (no `@jdoe` beside it).
  await personal(ids.numbered, orgId, users.numbered, "@jdoe85", 4)
  // Already in the new form.
  await personal(ids.migrated, orgId, users.migrated, "@lins-agent", 5)
  // The same name in another org is allocated independently.
  await personal(ids.otherOrg, otherOrgId, users.otherOrg, "@ada", 1)
})

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    await sql`DELETE FROM kernel.agents WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
  }
  await sql.end()
})

async function handleOf(id: string): Promise<string> {
  const [row] = await sql<{ handle: string }[]>`SELECT handle FROM kernel.agents WHERE id = ${id}`
  return row!.handle
}

async function runMigration(): Promise<void> {
  // One transaction, as the migrator runs it: a failure cannot leave the
  // trigger disabled on the test database.
  await sql.begin((tx) => tx.unsafe(readFileSync(MIGRATION, "utf8")))
}

describe("0205: a personal agent's handle names its owner's agent", () => {
  it("renames old-form personal handles, collision-safe within each org", async () => {
    expect(await handleOf(ids.ada)).toBe("@ada")

    await runMigration()

    // `@adas-agent` is taken by a role agent, so the oldest Ada takes the
    // first free discriminator and her namesake the next.
    expect(await handleOf(ids.ada)).toBe("@adas-agent2")
    expect(await handleOf(ids.adaTwin)).toBe("@adas-agent3")
    // A name ending in "s" takes no second one.
    expect(await handleOf(ids.thomas)).toBe("@thomas-agent")
    expect(await handleOf(ids.numbered)).toBe("@jdoe85s-agent")
    expect(await handleOf(ids.migrated)).toBe("@lins-agent")
    expect(await handleOf(ids.otherOrg)).toBe("@adas-agent")
  })

  it("leaves non-personal agents untouched", async () => {
    expect(await handleOf(ids.roleHoldingNewName)).toBe("@adas-agent")
    expect(await handleOf(ids.roleNamedLikePerson)).toBe("@grace")
  })

  it("keeps the immutability trigger: a normal handle update is still refused", async () => {
    // A postgres.js query runs only once awaited, so each update is awaited
    // inside its own async function for `rejects` to see the error.
    const rename = async (id: string, handle: string) => {
      await sql`UPDATE kernel.agents SET handle = ${handle} WHERE id = ${id}`
    }
    await expect(rename(ids.thomas, "@someone-else")).rejects.toThrow(/agents_handle_immutable/)
    await expect(rename(ids.roleNamedLikePerson, "@grace2")).rejects.toThrow(
      /agents_handle_immutable/,
    )
    expect(await handleOf(ids.thomas)).toBe("@thomas-agent")
  })

  it("is safe to replay", async () => {
    await runMigration()
    expect(await handleOf(ids.ada)).toBe("@adas-agent2")
    expect(await handleOf(ids.adaTwin)).toBe("@adas-agent3")
    expect(await handleOf(ids.thomas)).toBe("@thomas-agent")
    expect(await handleOf(ids.roleNamedLikePerson)).toBe("@grace")
  })
})
