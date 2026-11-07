// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `ctx.approvals.statusOf(id)`: an app reads where one of ITS OWN approval requests stands (so a
// job can release work whose approval was declined or expired). Status only; another app's
// approval, or a malformed id, reads as unknown.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const ORG = randomUUID()
const OTHER_ORG = randomUUID()
const USER = randomUUID()
const THREAD = randomUUID()

async function approval(
  org: string,
  tool: string,
  status: string,
  expiresIn: string,
): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO kernel.approval_requests
      (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params, current_payload, expires_at, requested_by, status)
    VALUES (${org}, ${`st-${randomUUID().slice(0, 8)}`}, ${org === ORG ? THREAD : null}, ${org === ORG ? THREAD : null}, ${tool},
      '{}'::jsonb, '{"secret":"payload"}'::jsonb, now() + ${expiresIn}::interval, ${USER}, ${status})
    RETURNING id`
  return row!.id
}

describe("approvals.statusOf", () => {
  beforeAll(async () => {
    for (const [id, slug] of [
      [ORG, `as-${ORG.slice(0, 8)}`],
      [OTHER_ORG, `as-${OTHER_ORG.slice(0, 8)}`],
    ] as const) {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${id}, 'Approval Status Org', ${slug})`
    }
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, ${`as-${USER.slice(0, 8)}@test.com`}, 'Requester', 'active', 'hash')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, ${`as-thread-${THREAD.slice(0, 8)}`}, 'agent_chat', ${USER})`
  })
  afterAll(async () => {
    await sql`DELETE FROM kernel.approval_requests WHERE org_id IN (${ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.threads WHERE id = ${THREAD}`
    await sql`DELETE FROM kernel.users WHERE id = ${USER}`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${OTHER_ORG})`
  })

  // A production bridge runs on the job's RLS session, never on a privileged slot.
  const statusOf = (app: string, id: string) =>
    withRlsContext(
      { actorType: "system", orgId: ORG, purpose: "job", scopes: [`${app}:*`] },
      async (tx) =>
        JSON.parse(
          await createRpcBridge(
            app,
            "system",
            ORG,
            tx as never,
            { name: app } as never,
            [`${app}:*`],
            "system",
          ).approvals_statusOf(id),
        ),
    )

  it("reports its own approvals' status (pending past its expiry counts as expired), never the payload", async () => {
    const pending = await approval(ORG, "invoicing:einvoice_book_batch", "pending", "1 day")
    const lapsed = await approval(ORG, "invoicing:einvoice_book_batch", "pending", "-1 hour")
    const denied = await approval(ORG, "invoicing:einvoice_book_batch", "denied", "1 day")
    expect(await statusOf("invoicing", pending)).toEqual({ status: "pending", expired: false })
    expect(await statusOf("invoicing", lapsed)).toEqual({ status: "pending", expired: true })
    expect(await statusOf("invoicing", denied)).toEqual({ status: "denied", expired: false })
  })

  it("another app's approval, or a malformed id, reads as unknown", async () => {
    const theirs = await approval(ORG, "mail:send", "pending", "1 day")
    expect(await statusOf("invoicing", theirs)).toEqual({ status: null })
    expect(await statusOf("invoicing", "not-a-uuid")).toEqual({ status: null })
  })
})
