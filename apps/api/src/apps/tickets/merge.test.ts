// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-218: merging a ticket whose messages carry a non-null external_message_id (i.e. a MAIL-CONVERTED
// ticket) used to abort with "Failed query … INSERT INTO messages" — the merge's INSERT…SELECT copied
// external_message_id verbatim, and app_tickets.messages has a partial UNIQUE (org_id,
// external_message_id) WHERE external_message_id IS NOT NULL, so the copy duplicated the pair. Native
// tickets (external_message_id NULL) never hit it. Fix: the merged COPY carries external_message_id =
// NULL (the source keeps the canonical synced id). This is the consolidation path the
// detect-duplicate / smart-merge cross-channel scenarios rely on.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { mergeTickets } from "~/apps/tickets/merge"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

const ORG_ID = "00000000-0000-0000-0000-0000000c2180"
const USER_ID = "00000000-0000-0000-0000-0000000c2181"

async function seedTicket(handle: string): Promise<string> {
  return withPrivilegedDb(ORG_ID, "merge-test-seed-ticket", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets
          (org_id, handle, subject, channel, reply_token, sla_target_seconds, sla_deadline, status)
        VALUES (${ORG_ID}, ${handle}, ${`Subject ${handle}`}, 'email', ${`tok-${handle}`}, 3600,
                now() + interval '1 day', 'open')
        RETURNING id`),
    )
    return rows[0]!.id
  })
}

describe("mergeTickets — external_message_id on the copy (BL-218)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'MergeTicketsOrg', 'merge-tickets-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'merge-tickets@test.com', 'Merge Tester') ON CONFLICT DO NOTHING`
  })

  afterEach(async () => {
    await withPrivilegedDb(ORG_ID, "merge-test-clean", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM app_tickets.messages WHERE org_id = ${ORG_ID}`)
      await tx.execute(
        drizzleSql`UPDATE app_tickets.tickets SET merged_into_ticket_id = NULL WHERE org_id = ${ORG_ID}`,
      )
      await tx.execute(drizzleSql`DELETE FROM app_tickets.tickets WHERE org_id = ${ORG_ID}`)
    })
  })

  // The org row is dropped ONCE, by the LAST describe in this file. The three
  // describes share ORG_ID, and `ensureAppsForOrg` memoizes the org id for the
  // life of the process: dropping the org here let the next describe recreate
  // the row and then get a no-op from the memoized initializer, so the tickets
  // settings its SLA clock reads were never seeded again ("tickets settings not
  // seeded for org"). Per-test rows are cleaned by afterEach above.

  it("merges a mail-converted ticket (message has external_message_id) without a unique violation; the copy is NULL", async () => {
    const target = await seedTicket("mt-target")
    const source = await seedTicket("mt-source")
    // A converted-from-mail message on the SOURCE carries the mail's external_message_id.
    await withPrivilegedDb(ORG_ID, "merge-test-seed-msg", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO app_tickets.messages
          (org_id, ticket_id, kind, from_email, subject, text_body, external_message_id, sent_at)
        VALUES (${ORG_ID}, ${source}, 'inbound', 'aki@example.jp', 'JP voltage', 'body',
                'ext-mail-aki-1', now())`),
    )

    const result = await withPrivilegedDb(ORG_ID, "merge-test-run", (tx) =>
      mergeTickets(
        tx,
        ORG_ID,
        { targetTicketId: target, sourceTicketIds: [source] },
        {
          actorType: "user",
          userId: USER_ID,
        },
      ),
    )

    // Pre-fix this threw a unique violation ("Failed query … INSERT INTO messages"); now it succeeds.
    expect("error" in result).toBe(false)
    if ("error" in result) throw new Error(`merge failed: ${result.error.code}`)
    expect(result.copiedMessageCount).toBe(1)

    const [copied, src] = await withPrivilegedDb(ORG_ID, "merge-test-assert", async (tx) => {
      const c = extractRows<{ external_message_id: string | null }>(
        await tx.execute(
          drizzleSql`SELECT external_message_id FROM app_tickets.messages WHERE org_id = ${ORG_ID} AND ticket_id = ${target}`,
        ),
      )
      const s = extractRows<{ external_message_id: string | null }>(
        await tx.execute(
          drizzleSql`SELECT external_message_id FROM app_tickets.messages WHERE org_id = ${ORG_ID} AND ticket_id = ${source}`,
        ),
      )
      return [c, s] as const
    })

    // The copied message on the TARGET has external_message_id NULL (the source keeps the synced id).
    expect(copied.length).toBe(1)
    expect(copied[0]!.external_message_id).toBeNull()
    // The source row STILL carries the canonical external_message_id (untouched).
    expect(src[0]!.external_message_id).toBe("ext-mail-aki-1")
  })
})

describe("mergeTickets -- reopens a closed target whose customer wrote last", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'MergeTicketsOrg', 'merge-tickets-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'merge-tickets@test.com', 'Merge Tester') ON CONFLICT DO NOTHING`
    // Reopening a closed target resumes its SLA clock, which reads org
    // settings -- seed the tickets app defaults (idempotent).
    await ensureAppsForOrg(ORG_ID, {})
  })

  afterEach(async () => {
    await withPrivilegedDb(ORG_ID, "merge-test-clean-2", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM app_tickets.messages WHERE org_id = ${ORG_ID}`)
      await tx.execute(
        drizzleSql`UPDATE app_tickets.tickets SET merged_into_ticket_id = NULL WHERE org_id = ${ORG_ID}`,
      )
      await tx.execute(drizzleSql`DELETE FROM app_tickets.tickets WHERE org_id = ${ORG_ID}`)
    })
  })

  // The org row is dropped ONCE, by the LAST describe in this file. The three
  // describes share ORG_ID, and `ensureAppsForOrg` memoizes the org id for the
  // life of the process: dropping the org here let the next describe recreate
  // the row and then get a no-op from the memoized initializer, so the tickets
  // settings its SLA clock reads were never seeded again ("tickets settings not
  // seeded for org"). Per-test rows are cleaned by afterEach above.

  it("merging a thread whose customer wrote last reopens a closed target", async () => {
    const target = await seedTicket("mt-reopen-target")
    const source = await seedTicket("mt-reopen-source")

    // Target was closed a while ago -- its own last_outbound_at is old, well
    // before the inbound message the merge is about to carry over.
    await withPrivilegedDb(ORG_ID, "merge-test-seed-target-closed", (tx) =>
      tx.execute(drizzleSql`
        UPDATE app_tickets.tickets
        SET status = 'closed', closed_reason = 'resolved',
            last_outbound_at = now() - interval '2 days'
        WHERE id = ${target} AND org_id = ${ORG_ID}
      `),
    )

    // The source carries the customer's most recent (inbound) word -- newer
    // than the target's last outbound reply.
    await withPrivilegedDb(ORG_ID, "merge-test-seed-source-inbound", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO app_tickets.messages
          (org_id, ticket_id, kind, from_email, subject, text_body, sent_at)
        VALUES (${ORG_ID}, ${source}, 'inbound', 'customer@example.com', 'still broken', 'body', now())
      `),
    )

    const result = await withPrivilegedDb(ORG_ID, "merge-test-run-reopen", (tx) =>
      mergeTickets(
        tx,
        ORG_ID,
        { targetTicketId: target, sourceTicketIds: [source] },
        { actorType: "user", userId: USER_ID },
      ),
    )
    expect("error" in result).toBe(false)
    if ("error" in result) throw new Error(`merge failed: ${result.error.code}`)

    const row = extractRows<{ status: string; closed_reason: string | null }>(
      await withPrivilegedDb(ORG_ID, "merge-test-assert-reopen", (tx) =>
        tx.execute(
          drizzleSql`SELECT status, closed_reason FROM app_tickets.tickets WHERE id = ${target} AND org_id = ${ORG_ID}`,
        ),
      ),
    )[0]!
    expect(row.status).toBe("open")
    expect(row.closed_reason).toBeNull()
  })
})

describe("mergeTickets -- never moves the target last_inbound_at backwards", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'MergeTicketsOrg', 'merge-tickets-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'merge-tickets@test.com', 'Merge Tester') ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(ORG_ID, {})
  })

  afterEach(async () => {
    await withPrivilegedDb(ORG_ID, "merge-test-clean-3", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM app_tickets.messages WHERE org_id = ${ORG_ID}`)
      await tx.execute(
        drizzleSql`UPDATE app_tickets.tickets SET merged_into_ticket_id = NULL WHERE org_id = ${ORG_ID}`,
      )
      await tx.execute(drizzleSql`DELETE FROM app_tickets.tickets WHERE org_id = ${ORG_ID}`)
    })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.users WHERE id = ${USER_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("merge never moves the target last_inbound_at backwards", async () => {
    const target = await seedTicket("mt-noregress-target")
    const source = await seedTicket("mt-noregress-source")

    // Target already has a recent, real last_inbound_at from an earlier
    // customer message that is not part of this merge's copied batch.
    const targetInboundAt = new Date().toISOString()
    await withPrivilegedDb(ORG_ID, "merge-test-seed-target-inbound", (tx) =>
      tx.execute(drizzleSql`
        UPDATE app_tickets.tickets
        SET status = 'closed', closed_reason = 'resolved',
            last_inbound_at = ${targetInboundAt}::timestamptz,
            last_outbound_at = now()
        WHERE id = ${target} AND org_id = ${ORG_ID}
      `),
    )

    // The source carries only an OUTBOUND message, older than the target's
    // last_inbound_at -- the merge's own MAX(sent_at) inbound subquery over
    // the target returns NULL (zero inbound rows on the target), which the
    // unconditional overwrite used to turn into a backwards jump.
    await withPrivilegedDb(ORG_ID, "merge-test-seed-source-outbound", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO app_tickets.messages
          (org_id, ticket_id, kind, from_email, subject, text_body, sent_at)
        VALUES (${ORG_ID}, ${source}, 'outbound', 'agent@example.com', 'old reply', 'body', now() - interval '2 days')
      `),
    )

    const result = await withPrivilegedDb(ORG_ID, "merge-test-run-noregress", (tx) =>
      mergeTickets(
        tx,
        ORG_ID,
        { targetTicketId: target, sourceTicketIds: [source] },
        { actorType: "user", userId: USER_ID },
      ),
    )
    expect("error" in result).toBe(false)
    if ("error" in result) throw new Error(`merge failed: ${result.error.code}`)

    const row = extractRows<{ last_inbound_at: Date | null }>(
      await withPrivilegedDb(ORG_ID, "merge-test-assert-noregress", (tx) =>
        tx.execute(
          drizzleSql`SELECT last_inbound_at FROM app_tickets.tickets WHERE id = ${target} AND org_id = ${ORG_ID}`,
        ),
      ),
    )[0]!
    expect(row.last_inbound_at).not.toBeNull()
    expect(new Date(row.last_inbound_at as Date).getTime()).toBe(
      new Date(targetInboundAt).getTime(),
    )
  })
})
