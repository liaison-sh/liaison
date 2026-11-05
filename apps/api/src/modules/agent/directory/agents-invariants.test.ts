// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { agents } from "~/db/schema/kernel/agents"

const ORG = "00000000-0000-0000-0000-c00000000101"
const AGENT = "00000000-0000-0000-0000-c00000000102"

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Agents Invariants Org', 'agents-invariants-org') ON CONFLICT DO NOTHING`

  await withPrivilegedDb(ORG, "test-seed", async (tx) => {
    await tx
      .insert(agents)
      .values({
        id: AGENT,
        orgId: ORG,
        kind: "role",
        handle: "billing",
        displayName: "Billing Agent",
      })
      .onConflictDoNothing()
  })
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("AGENT HANDLE", () => {
  it("AGENT HANDLE: updating an agent's handle is refused", async () => {
    await expect(
      withPrivilegedDb(ORG, "test-handle-guard", async (tx) => {
        await tx.update(agents).set({ handle: "billing-renamed" }).where(eq(agents.id, AGENT))
      }),
    ).rejects.toThrow()

    const rows = await withPrivilegedDb(ORG, "test-handle-guard-verify", async (tx) => {
      return tx.select().from(agents).where(eq(agents.id, AGENT))
    })
    expect(rows[0]?.handle).toBe("billing")
  })

  it("AGENT HANDLE: updating an agent's displayName succeeds", async () => {
    const rows = await withPrivilegedDb(ORG, "test-displayname-rename", async (tx) => {
      return tx
        .update(agents)
        .set({ displayName: "Billing Support Agent" })
        .where(eq(agents.id, AGENT))
        .returning()
    })

    expect(rows.length).toBe(1)
    expect(rows[0]?.handle).toBe("billing")
    expect(rows[0]?.displayName).toBe("Billing Support Agent")
  })
})
