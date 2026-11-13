// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hourly reconcile housekeeping on the real database: an idle proposal goes with the cards it
// drew, a card past proposed stays, and claims follow their document.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { IDLE_PROPOSAL_DAYS, sweepClaims, sweepIdleProposals } from "./reconcile-sweep"

let orgId = ""
let owner: minimal.Session
let projectId = ""
let threadId = ""

async function card(state: string, idleDays: number, period: string): Promise<string> {
  return extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_projects.reconciliations
        (org_id, project_id, period_start, period_end, basis, state, created_by, thread_id,
         updated_at)
      VALUES (${orgId}::uuid, ${projectId}::uuid, ${`${period}-01`}::date, ${`${period}-28`}::date,
              'daily', ${state}, ${owner.userId}::uuid, ${threadId}::uuid,
              now() - make_interval(days => ${idleDays}))
      RETURNING id::text AS id`),
  )[0]!.id
}

async function storeCard(id: string): Promise<void> {
  const call = {
    toolCallId: `call-${id.slice(0, 8)}`,
    toolName: "projects__reconcile_propose",
    args: {},
    result: { reconciliationId: id, lines: [{ proofs: [{ label: "Demo, 15 Oct" }] }] },
    card: { kind: "groups", pill: { label: "Projects: reconcile" }, latestKey: `reconcile:${id}` },
  }
  await db.execute(drizzleSql`
    INSERT INTO kernel.messages
      (org_id, thread_id, author_id, author_type, content, metadata, required_scopes)
    VALUES (${orgId}::uuid, ${threadId}::uuid, ${owner.userId}::uuid, 'user', 'A card.',
            ${JSON.stringify({ toolCalls: [call] })}::jsonb, '{}'::text[])`)
}

async function stillStored(id: string): Promise<{ row: boolean; card: boolean }> {
  const row = extractRows<{ n: number }>(
    await db.execute(
      drizzleSql`SELECT count(*)::int AS n FROM app_projects.reconciliations WHERE id = ${id}::uuid`,
    ),
  )[0]?.n
  const cards = extractRows<{ n: number }>(
    await db.execute(drizzleSql`
      SELECT count(*)::int AS n FROM kernel.messages
       WHERE thread_id = ${threadId}::uuid AND metadata::text LIKE ${`%"latestKey": "reconcile:${id}"%`}`),
  )[0]?.n
  return { row: row === 1, card: (cards ?? 0) > 0 }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.adminSession(orgId)
  projectId = crypto.randomUUID()
  await db.execute(drizzleSql`
    INSERT INTO app_projects.projects (id, org_id, name, key, owner_id)
    VALUES (${projectId}::uuid, ${orgId}::uuid, 'Maison Delorme platform', 'ATLAS',
            ${owner.userId}::uuid)`)
  threadId = crypto.randomUUID()
  await db.execute(drizzleSql`
    INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${threadId}::uuid, ${orgId}::uuid, ${`sweep-${threadId.slice(0, 8)}`}, 'agent_chat',
            ${owner.userId}::uuid)`)
}, 120_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("the hourly reconcile housekeeping", () => {
  it("a proposal idle thirty days is deleted with its stored cards", async () => {
    const idle = await card("proposed", IDLE_PROPOSAL_DAYS + 1, "2026-08")
    const recent = await card("proposed", IDLE_PROPOSAL_DAYS - 1, "2026-09")
    const drafted = await card("drafted", IDLE_PROPOSAL_DAYS + 10, "2026-07")
    for (const id of [idle, recent, drafted]) await storeCard(id)

    const out = await sweepIdleProposals()
    expect(out.deleted).toBeGreaterThanOrEqual(1)
    expect(await stillStored(idle)).toEqual({ row: false, card: false })
    // Twenty-nine days idle, or a card that left proposed: both stay, cards and all.
    expect(await stillStored(recent)).toEqual({ row: true, card: true })
    expect(await stillStored(drafted)).toEqual({ row: true, card: true })
    // The cleared row keeps its call, with no card and no result left to show a proof label.
    const text = extractRows<{ m: string }>(
      await db.execute(drizzleSql`
        SELECT metadata::text AS m FROM kernel.messages WHERE thread_id = ${threadId}::uuid`),
    )
      .map((r) => r.m)
      .join("\n")
    expect(text.match(/Demo, 15 Oct/g)).toHaveLength(2)
  })

  it("a reservation with no document an hour on is released, and the sweep runs on empty claims", async () => {
    expect(await sweepClaims()).toEqual(expect.objectContaining({ billed: 0 }))
    const old = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO app_projects.billing_claims
          (org_id, project_id, source_kind, source_ref, period_key, state, created_at)
        VALUES (${orgId}::uuid, ${projectId}::uuid, 'task', 'ATLAS-1', '2026-10', 'reserved',
                now() - interval '2 hours'),
               (${orgId}::uuid, ${projectId}::uuid, 'task', 'ATLAS-2', '2026-10', 'reserved', now())
        RETURNING id::text AS id`),
    )
    await sweepClaims()
    const states = extractRows<{ state: string }>(
      await db.execute(drizzleSql`
        SELECT state FROM app_projects.billing_claims
         WHERE id IN (${old[0]!.id}::uuid, ${old[1]!.id}::uuid) ORDER BY source_ref`),
    ).map((r) => r.state)
    expect(states).toEqual(["released", "reserved"])
  })
})
