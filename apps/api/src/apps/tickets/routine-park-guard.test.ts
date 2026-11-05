// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine must not park a ticket the customer is still waiting on. The
// support triage routine drafted a reply (a pending approval) and then set a
// 7-day follow-up on the ticket, which moved it out of Needs attention while
// nothing had actually been sent: the customer waited a week unseen.

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { validateAndApply } from "./state-machine"

const rows = (r: unknown): any[] => (r as any).rows ?? r

let orgId: string
let userId: string

beforeAll(async () => {
  const slug = `park-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("park-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Park Guard', ${slug}) RETURNING id`),
    )[0].id
    userId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'P', 'active', 'h', 1, 1) RETURNING id`),
    )[0].id
  })
  await ensureAppsForOrg(orgId, {})
})

async function makeTicket(opts: { customerHasLastWord: boolean }): Promise<string> {
  return withPrivilegedDb(orgId, "park-create", async (tx) => {
    const outbound = opts.customerHasLastWord
      ? drizzleSql`now() - interval '2 days'`
      : drizzleSql`now() - interval '1 minute'`
    return extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity, reply_token,
          sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
          first_response_at, last_inbound_at, last_outbound_at, message_count, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${`ticket_${Math.random().toString(36).slice(2, 8)}`},
          'Question', 'open', 'normal', 'email', 'internal', ${Math.random().toString(36).slice(2, 12)},
          3600, now() + interval '1 hour', null, 0,
          now() - interval '3 days', now() - interval '1 hour', ${outbound}, 3, now(), now()
        )
        RETURNING id`),
    )[0]!.id
  })
}

const routineFrame = (): RunContext =>
  ({
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    background: true,
    routineId: crypto.randomUUID(),
  }) as RunContext

const followupIn7Days = () => ({
  kind: "setFollowup" as const,
  at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  reason: "awaiting customer reply",
})

async function apply(ticketId: string, input: Parameters<typeof validateAndApply>[2]) {
  return withPrivilegedDb(orgId, "park-apply", (tx) =>
    validateAndApply(tx as never, ticketId, input, { actorType: "user", userId, orgId }),
  )
}

async function statusOf(ticketId: string): Promise<string> {
  return withPrivilegedDb(orgId, "park-status", async (tx) =>
    String(
      extractRows<{ status: string }>(
        await tx.execute(
          drizzleSql`SELECT status FROM app_tickets.tickets WHERE id = ${ticketId}::uuid`,
        ),
      )[0]!.status,
    ),
  )
}

describe("routine park guard", () => {
  it("a routine cannot set a follow-up while the customer has the last word", async () => {
    const ticketId = await makeTicket({ customerHasLastWord: true })
    const result = await runContextStore.run(routineFrame(), () =>
      apply(ticketId, followupIn7Days()),
    )
    expect(result).toMatchObject({ ok: false, code: "customer_awaiting_reply" })
    expect(await statusOf(ticketId)).toBe("open")
  })

  it("a routine cannot set awaiting_customer while the customer has the last word", async () => {
    const ticketId = await makeTicket({ customerHasLastWord: true })
    const result = await runContextStore.run(routineFrame(), () =>
      apply(ticketId, { kind: "setStatus", intended: "awaiting_customer" }),
    )
    expect(result).toMatchObject({ ok: false, code: "customer_awaiting_reply" })
    expect(await statusOf(ticketId)).toBe("open")
  })

  it("a routine can still set a follow-up once we replied last", async () => {
    const ticketId = await makeTicket({ customerHasLastWord: false })
    const result = await runContextStore.run(routineFrame(), () =>
      apply(ticketId, followupIn7Days()),
    )
    expect(result).toMatchObject({ ok: true })
    expect(await statusOf(ticketId)).toBe("awaiting_followup")
  })

  it("a human can still defer a ticket the customer wrote last", async () => {
    const ticketId = await makeTicket({ customerHasLastWord: true })
    const result = await apply(ticketId, followupIn7Days())
    expect(result).toMatchObject({ ok: true })
    expect(await statusOf(ticketId)).toBe("awaiting_followup")
  })
})
