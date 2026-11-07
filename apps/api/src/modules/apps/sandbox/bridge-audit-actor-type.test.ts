// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX2 item 3. X10 split the sandbox bridge's `actorType` into an RLS actor and
// an AUDIT category, but only two emitters read the split value: queueAppEvent
// and the app's declared emit. Every other audit-bearing seam in the bridge
// still handed the RAW `actorType` down -- the tickets state-machine calls, the
// converted-to-mail timeline write, the file attach -- so a ticket mutated by a
// sandboxed app inside an agent turn still audited as an anonymous human write
// and A11's "what did this agent do" stayed blind to it.
//
// The RLS actor is NOT what moves here, and the tickets modules prove it: their
// `actor.actorType` still decides self-assignment ('me'), created_by and the
// note author. Only the audit category follows the acting agent.
import { beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import ticketsManifest from "~/apps/tickets/app.manifest.json"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { asOrgMember } from "~/tests/helpers/org-caller"

let orgId: string
let userId: string
let agentId: string

const SCOPES = ["tickets:tickets:read", "tickets:tickets:write"]

beforeAll(async () => {
  const slug = `fx2-bridge-audit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("fx2-bridge-audit-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'FX2 Bridge Audit', ${slug}) RETURNING id
    `)) as any
    orgId = (orgRows.rows ?? orgRows)[0].id
    const u = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userId = (u.rows ?? u)[0].id
    const a = (await tx.execute(drizzleSql`
      INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (gen_random_uuid(), ${orgId}, 'role', ${`@fx2-${slug.slice(-12)}`}, 'FX2 Agent', '["*"]'::jsonb)
      RETURNING id
    `)) as any
    agentId = (a.rows ?? a)[0].id
  })
  await ensureAppsForOrg(orgId, {})
}, 60_000)

/** The turn frame an in-app agent dispatch runs under. */
function agentFrame() {
  const rootRunId = crypto.randomUUID()
  return {
    runId: rootRunId,
    parentRunId: null,
    rootRunId,
    nestingDepth: 0,
    background: false,
    agentId,
    agentCeiling: ["*"],
    effectiveScope: [...SCOPES],
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
}

/** Every ticket event this org queued, newest first. */
async function ticketEvents() {
  return sql<{ payload: { actorType?: string; agentId?: string | null; action?: string } }[]>`
    SELECT payload FROM kernel.pending_events
    WHERE org_id = ${orgId} AND payload->>'entity' = 'ticket'
    ORDER BY created_at DESC`
}

describe("FX2: every audit-bearing bridge seam follows the acting agent", () => {
  it("a ticket created and re-prioritised by a sandboxed app inside an agent turn audits as the agent", async () => {
    const ticketId = await asOrgMember(orgId, userId, async (tx) => {
      const bridge = runContextStore.run(agentFrame(), () =>
        createRpcBridge("tickets", userId, orgId, tx as never, ticketsManifest as never, SCOPES),
      )
      const created = JSON.parse(
        await bridge.tickets_create(
          JSON.stringify({
            subject: "FX2 audit seam",
            channel: "manual",
            initialMessage: { kind: "note", textBody: "FX2 note" },
          }),
        ),
      ) as { ticketId?: string; error?: unknown }
      expect(created.error).toBeUndefined()
      await bridge.tickets_setPriority(created.ticketId as string, "urgent")
      return created.ticketId as string
    })
    expect(ticketId).toBeTruthy()

    const rows = await ticketEvents()
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const r of rows) {
      // The audit CATEGORY follows the agent...
      expect(r.payload.actorType).toBe("agent")
      // ...and names it, since a categorised row with no agent answers nothing.
      expect(r.payload.agentId).toBe(agentId)
    }
  }, 60_000)

  it("the RLS actor is untouched: the ticket message still records the HUMAN as its author", async () => {
    const rows = await sql<{ created_by: string | null }[]>`
      SELECT created_by FROM app_tickets.messages WHERE org_id = ${orgId}`
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.created_by).toBe(userId)
  })
})
