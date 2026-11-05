// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  audienceBreakdown,
  backfillAudienceFromExternalRef,
  setAudience,
} from "~/apps/tickets/audience"
import { extractRows, type PrivilegedDb } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

const sqlDb = db as unknown as PrivilegedDb

interface Seed {
  externalRef?: string | null
  audience?: "b2b" | "b2c" | null
  team?: string | null
}

async function withFixture<T>(
  rows: Seed[],
  fn: (f: { orgId: string; ids: string[] }) => Promise<T>,
): Promise<T> {
  const slug = `aud-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Audience Org', ${slug}) RETURNING id`),
  )
  const orgId = org.id
  await ensureAppsForOrg(orgId, {})

  const ids: string[] = []
  await withSystemDb("audience-fixture", async (tx) => {
    let seq = 0
    for (const r of rows) {
      const handle = `au-${slug}-${seq}`
      const token = `AUT${slug.slice(-6)}${seq.toString().padStart(4, "0")}`
      seq++
      const [row] = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO app_tickets.tickets (
            id, org_id, handle, subject, status, priority, channel, sensitivity,
            team, audience, external_ref,
            reply_token, sla_target_seconds, sla_elapsed_seconds, message_count,
            created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${orgId}, ${handle}, ${handle}, 'open', 'normal', 'manual', 'internal',
            ${r.team ?? null}, ${r.audience ?? null}, ${r.externalRef ?? null},
            ${token}, 3600, 0, 1, now(), now()
          ) RETURNING id`),
      )
      ids.push(row.id)
    }
  })
  return fn({ orgId, ids })
}

describe("audience — the database refuses a third value", () => {
  it("rejects anything outside the enum, at the CHECK constraint", async () => {
    // The reason this is an enum and not free text: `team` IS free text, and it
    // accumulated sixteen near-duplicate spellings that had to be merged by
    // hand. Here the eleventh spelling must be impossible, not discouraged.
    await withFixture([{ externalRef: "LVN-1" }], async ({ orgId, ids }) => {
      // Drizzle's builder is a thenable, not a promise — await it inside a
      // function so the rejection is a real one.
      const tryWrite = async (v: string) => {
        await db.execute(drizzleSql`
          UPDATE app_tickets.tickets SET audience = ${drizzleSql.raw(`'${v}'`)}
          WHERE id = ${ids[0]}::uuid AND org_id = ${orgId}`)
      }
      expect(
        await tryWrite("B2B").then(
          () => "accepted",
          () => "refused",
        ),
      ).toBe("refused")
      expect(
        await tryWrite("partner").then(
          () => "accepted",
          () => "refused",
        ),
      ).toBe("refused")
      // …and the legal one still goes through, so the test is not passing by
      // accident on a broken statement.
      expect(
        await tryWrite("b2b").then(
          () => "accepted",
          () => "refused",
        ),
      ).toBe("accepted")
    })
  })
})

describe("audience — setAudience", () => {
  it("sets, clears, and refuses an unknown value without touching the row", async () => {
    await withFixture([{ externalRef: "LVN-1" }], async ({ orgId, ids }) => {
      const id = ids[0]!
      expect(await setAudience(sqlDb, orgId, id, "b2c")).toEqual({ ticketId: id, audience: "b2c" })
      // null is a real state (mail whose side is unknown), not a gap.
      expect(await setAudience(sqlDb, orgId, id, null)).toEqual({ ticketId: id, audience: null })

      const bad = await setAudience(sqlDb, orgId, id, "B2C" as never)
      expect("error" in bad && bad.error.code).toBe("invalid_params")
    })
  })

  it("reports a ticket it cannot see rather than claiming success", async () => {
    await withFixture([{ externalRef: "LVN-1" }], async ({ orgId }) => {
      const out = await setAudience(sqlDb, orgId, "00000000-0000-0000-0000-000000000000", "b2b")
      expect("error" in out && out.error.code).toBe("not_found")
    })
  })
})

describe("audience — backfill from the migration key", () => {
  it("classifies TPSD as b2b and every other desk as b2c", async () => {
    await withFixture(
      [
        { externalRef: "TPSD-1" },
        { externalRef: "TPSD-2" },
        { externalRef: "LVN-1" },
        { externalRef: "BES-1" },
        { externalRef: "LGA-1" },
      ],
      async ({ orgId }) => {
        const r = await backfillAudienceFromExternalRef(sqlDb, orgId)
        expect(r).toEqual({ b2b: 2, b2c: 3, unclassified: 0, dryRun: false })
      },
    )
  })

  it("leaves a ticket with no external_ref alone — its side is genuinely unknown", async () => {
    // Guessing here is how a partner escalation gets filed as a member
    // complaint. Unclassified must stay visible.
    await withFixture([{ externalRef: null }, { externalRef: "TPSD-9" }], async ({ orgId }) => {
      const r = await backfillAudienceFromExternalRef(sqlDb, orgId)
      expect(r.b2b).toBe(1)
      expect(r.unclassified).toBe(1)
    })
  })

  it("never overwrites an existing value, so a human correction survives a re-run", async () => {
    // TPSD by key, but someone classified it b2c by hand — the backfill must
    // not "fix" that back.
    await withFixture([{ externalRef: "TPSD-1", audience: "b2c" }], async ({ orgId }) => {
      const r = await backfillAudienceFromExternalRef(sqlDb, orgId)
      expect(r).toMatchObject({ b2b: 0, b2c: 0 })
      expect(await audienceBreakdown(sqlDb, orgId)).toEqual([{ audience: "b2c", count: 1 }])
    })
  })

  it("is idempotent: the second run moves nothing", async () => {
    await withFixture([{ externalRef: "TPSD-1" }, { externalRef: "LVN-1" }], async ({ orgId }) => {
      await backfillAudienceFromExternalRef(sqlDb, orgId)
      const second = await backfillAudienceFromExternalRef(sqlDb, orgId)
      expect(second).toMatchObject({ b2b: 0, b2c: 0, unclassified: 0 })
    })
  })

  it("dryRun reports the same split and writes nothing", async () => {
    await withFixture([{ externalRef: "TPSD-1" }, { externalRef: "LVN-1" }], async ({ orgId }) => {
      const dry = await backfillAudienceFromExternalRef(sqlDb, orgId, { dryRun: true })
      expect(dry).toEqual({ b2b: 1, b2c: 1, unclassified: 0, dryRun: true })
      expect(await audienceBreakdown(sqlDb, orgId)).toEqual([{ audience: null, count: 2 }])
    })
  })
})

describe("audience — it is orthogonal to team, which is the whole reason it exists", () => {
  it("one centre carries both audiences, and each is separately countable", async () => {
    // The measurement that decided the design: on the real corpus `B'EST` holds
    // 231 b2b and 207 b2c. If `team` could have carried the audience, this
    // shape would be impossible.
    await withFixture(
      [
        { team: "B'EST", externalRef: "TPSD-1" },
        { team: "B'EST", externalRef: "TPSD-2" },
        { team: "B'EST", externalRef: "BES-1" },
      ],
      async ({ orgId }) => {
        await backfillAudienceFromExternalRef(sqlDb, orgId)
        const rows = extractRows<{ audience: string; n: string }>(
          await db.execute(drizzleSql`
            SELECT audience, COUNT(*) AS n FROM app_tickets.tickets
            WHERE org_id = ${orgId} AND team = 'B''EST'
            GROUP BY audience ORDER BY audience`),
        )
        expect(rows.map((r) => [r.audience, Number(r.n)])).toEqual([
          ["b2b", 2],
          ["b2c", 1],
        ])
      },
    )
  })
})
