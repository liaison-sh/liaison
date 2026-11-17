// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where a client's decision goes on Home: the sender and the client company's
// manager, the manager's next in line while they are away, the new manager once
// it changed; on a restricted document only the people its list names, manager
// or not, and no stand-in.
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import { processTranslationEvent } from "~/modules/attention/translator"
import { insertSql } from "~/seed/factories/org/test-rows"
import { k, useClientActionWorld } from "../../../test-support/client-actions-kit"
import { SYSTEM_ACTOR_ID } from "./mint"

const kit = useClientActionWorld("routingdocs")

function decided(data: Record<string, unknown> = {}): AppEvent {
  return {
    app: "kernel",
    entity: "client_action",
    action: "decided",
    orgId: kit.w.orgId,
    actorId: SYSTEM_ACTOR_ID,
    actorType: "system",
    entityId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    data: {
      title: "Avenant Alpha",
      decision: "approved",
      invitedName: "Anne",
      companyId: kit.w.companyA,
      senderUserIds: [kit.w.admin.userId],
      ...data,
    },
  }
}

async function usersFor(e: AppEvent): Promise<string[]> {
  await processTranslationEvent(e)
  const rows = (await sql`
    SELECT user_id FROM ${k("attention_events")}
     WHERE org_id = ${kit.w.orgId} AND entity_id = ${e.entityId ?? ""}`) as unknown as Array<{
    user_id: string
  }>
  return rows.map((r) => r.user_id).sort()
}

async function setManager(userId: string | null) {
  await sql`UPDATE ${k("companies")} SET owner_user_id = ${userId} WHERE id = ${kit.w.companyA}`
}

const sorted = (ids: string[]) => [...ids].sort()

describe("a client's decision on Home", () => {
  it("reaches the sender and the company's manager; after the manager changed, the new one", async () => {
    await setManager(kit.w.member.userId)
    expect(await usersFor(decided())).toEqual(sorted([kit.w.admin.userId, kit.w.member.userId]))
    await setManager(kit.w.admin.userId)
    expect(await usersFor(decided())).toEqual([kit.w.admin.userId])
    await setManager(null)
    expect(await usersFor(decided())).toEqual([kit.w.admin.userId])
  })

  it("while the manager is away, their next in line hears it too, never on a restricted document", async () => {
    const standIn = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.users", {
        id: standIn,
        org_id: kit.w.orgId,
        email: `standin-${standIn.slice(0, 8)}@doors.example.com`,
        name: "Stand In",
      }),
    )
    const away = crypto.randomUUID()
    await sql`
      INSERT INTO ${k("away_ranges")} (id, org_id, user_id, starts_on, ends_on, next_in_line_id, source, status)
      VALUES (${away}, ${kit.w.orgId}, ${kit.w.member.userId}, (now() - interval '2 days')::date,
              (now() + interval '2 days')::date, ${standIn}, 'said', 'active')`
    try {
      await setManager(kit.w.member.userId)
      expect(await usersFor(decided())).toEqual(
        sorted([kit.w.admin.userId, kit.w.member.userId, standIn]),
      )
      // Restricted, the list naming the sender and the manager: no stand-in.
      expect(
        await usersFor(decided({ visibleTo: [kit.w.admin.userId, kit.w.member.userId] })),
      ).toEqual(sorted([kit.w.admin.userId, kit.w.member.userId]))
      // Restricted, the list naming the sender only: the manager hears nothing.
      expect(await usersFor(decided({ visibleTo: [kit.w.admin.userId] }))).toEqual([
        kit.w.admin.userId,
      ])
    } finally {
      await sql`DELETE FROM ${k("attention_events")} WHERE org_id = ${kit.w.orgId}`
      await sql`DELETE FROM ${k("away_ranges")} WHERE id = ${away}`
      await setManager(null)
      await sql`DELETE FROM ${k("users")} WHERE id = ${standIn}`
    }
  })
})
