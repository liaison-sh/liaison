// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S29 walk on demo (2026-10-09): a routine whose scopes hold only
// mail:conversations:write tried to stage an owner-approved reply. Its tick taint
// is that write scope projected to its read sibling (A42), and the requester
// check compared it with the ROUTINE's capped scopes, which lack the read: every
// gated draft of such a routine was refused ("1 person (you) lacks
// mail:conversations:read"), although the card goes to the owner, a person who
// holds it. Inside a routine tick the requester is judged by the person's own
// grants; outside one, by the turn's scopes as before.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { taintApprovalAudienceGapDetail } from "~/modules/agent/scopes/taint-approval-audience"

const ORG = randomUUID()
const OWNER = randomUUID()
const READ = "mail:conversations:read"

describe("taint approval audience inside a routine tick", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Audience routine', ${`aud-${ORG.slice(0, 8)}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
      VALUES (${OWNER}, ${ORG}, ${`owner-${OWNER.slice(0, 8)}@test.com`}, 'Owner')`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${OWNER}, ${ORG}, ${READ}), (${OWNER}, ${ORG}, 'mail:conversations:write')`
  })
  afterAll(async () => {
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  const ask = () =>
    taintApprovalAudienceGapDetail({
      orgId: ORG,
      requesterUserId: OWNER,
      requesterScopes: ["mail:conversations:write"],
      taintScopes: [READ],
    })

  it("in a routine tick the requester is judged by the owner's own grants", async () => {
    const runId = randomUUID()
    const gap = await runContextStore.run(
      { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, routineId: randomUUID() },
      ask,
    )
    expect(gap).toBeNull()
  })

  it("outside a routine the turn's scopes still decide (unchanged)", async () => {
    expect((await ask())?.audience).toBe("requester")
  })

  it("an owner lacking the taint is still refused in a routine tick", async () => {
    const runId = randomUUID()
    const gap = await runContextStore.run(
      { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, routineId: randomUUID() },
      () =>
        taintApprovalAudienceGapDetail({
          orgId: ORG,
          requesterUserId: OWNER,
          requesterScopes: ["mail:conversations:write"],
          taintScopes: ["crm:deals:read"],
        }),
    )
    expect(gap?.audience).toBe("requester")
  })
})
