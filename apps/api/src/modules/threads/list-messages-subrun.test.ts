// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T12 — `listMessages` allows reading a hidden sub-run thread when the caller
// participates in the chain's ROOT thread (parent-of-sub-run access rule).
//
// These cases run through `withRlsContext`, so the participant-gated SELECT
// policies on threads / messages / agent_runs / thread_participants are ACTUALLY
// enforced — exactly the production path (`withRequestRls` → `listMessages`).
// That is the point: a sub-run thread has NO participant rows, so under the
// caller's RLS context the drill-down lookups (and the message read itself)
// would all see nothing. The fix reads those rows PRIVILEGED and enforces
// org + root-thread participation in code. A test that ran on the privileged
// connection (as the previous version did) bypasses RLS and so could never
// catch the dead-feature bug this guards.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { listMessages } from "~/modules/threads/message"

const ORG = "00000000-0000-0000-0000-00000000c001"
const OTHER_ORG = "00000000-0000-0000-0000-00000000c0f1"
const USER_OPERATOR = "00000000-0000-0000-0000-00000000c002" // participates in root thread
const USER_OUTSIDER = "00000000-0000-0000-0000-00000000c003" // in ORG, not in either thread
const USER_CROSS_ORG = "00000000-0000-0000-0000-00000000c0f2" // belongs to OTHER_ORG

let rootThreadId: string
let subrunThreadId: string

const ctx = (orgId: string, userId: string): UserContext => ({
  actorType: "user",
  userId,
  orgId,
  scopes: ["*"],
  dimensionGrants: {},
})

describe("listMessages — sub-run access exception (T12)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'T12 Org', 't12-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${OTHER_ORG}, 'T12 Other Org', 't12-other-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_OPERATOR}, ${ORG}, 'op@t12.test', 'Operator') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_OUTSIDER}, ${ORG}, 'out@t12.test', 'Outsider') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_CROSS_ORG}, ${OTHER_ORG}, 'cross@t12.test', 'Cross Org') ON CONFLICT (id) DO NOTHING`

    // Root thread (operator's primary) — operator is a participant.
    const [rootT] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, type, created_by)
      VALUES (${ORG}, ${`t12-root-${crypto.randomUUID().slice(0, 6)}`}, 'Root', 'thread', ${USER_OPERATOR})
      RETURNING id
    `
    rootThreadId = rootT.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${rootThreadId}, ${USER_OPERATOR}, ${ORG})`

    // Hidden sub-run thread — NO participant rows, type='subrun'.
    const [subT] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, type, hidden_from_list, created_by)
      VALUES (${ORG}, ${`t12-sub-${crypto.randomUUID().slice(0, 6)}`}, 'Sub-Run', 'subrun', true, ${USER_OPERATOR})
      RETURNING id
    `
    subrunThreadId = subT.id

    // Root agent_run + child sub-run row linking the two threads.
    const rootRunId = crypto.randomUUID()
    const childRunId = crypto.randomUUID()
    const actorJson = JSON.stringify({
      actorType: "user",
      userId: USER_OPERATOR,
      orgId: ORG,
      scopes: [],
      dimensionGrants: {},
    })
    await sql`INSERT INTO kernel.agent_runs (
      id, org_id, parent_run_id, root_run_id, thread_id, subagent_type, actor,
      effective_scopes, status, prompt, max_steps, timeout_ms, schema_retry_budget,
      nesting_depth
    ) VALUES (
      ${rootRunId}, ${ORG}, NULL, ${rootRunId}, ${rootThreadId}, NULL, ${actorJson}::jsonb,
      ARRAY[]::text[], 'running', '', 10, 60000, 3, 0
    )`
    await sql`INSERT INTO kernel.agent_runs (
      id, org_id, parent_run_id, root_run_id, thread_id, subagent_type, actor,
      effective_scopes, status, prompt, max_steps, timeout_ms, schema_retry_budget,
      nesting_depth
    ) VALUES (
      ${childRunId}, ${ORG}, ${rootRunId}, ${rootRunId}, ${subrunThreadId},
      'ticket-investigator', ${actorJson}::jsonb, ARRAY[]::text[], 'running', '', 10, 60000, 3, 1
    )`

    // Plant one message in the hidden thread so listMessages has something to return.
    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${subrunThreadId}, ${ORG}, ${USER_OPERATOR}, 'system', 'Investigating ticket...', '{}')`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${subrunThreadId}`
    await sql`DELETE FROM kernel.agent_runs WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${rootThreadId}`
    await sql`DELETE FROM kernel.threads WHERE id IN (${rootThreadId}, ${subrunThreadId})`
    await sql`DELETE FROM kernel.users WHERE id IN (${USER_OPERATOR}, ${USER_OUTSIDER}, ${USER_CROSS_ORG})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${OTHER_ORG})`
  })

  it("operator (root thread participant) can read the hidden sub-run thread under RLS", async () => {
    const result = await withRlsContext(ctx(ORG, USER_OPERATOR), (tx) =>
      listMessages(tx, {
        orgId: ORG,
        userId: USER_OPERATOR,
        threadId: subrunThreadId,
        limit: 50,
      }),
    )
    expect(result).not.toBeNull()
    // The actual hidden-thread message is returned — proves the read path is
    // privileged too (a participant-gated RLS read would yield an empty list).
    expect(result!.messages.length).toBeGreaterThan(0)
    expect(result!.messages[0].content).toBe("Investigating ticket...")
  })

  it("outsider (in org, not in root, not in subrun) is denied with 404 (null)", async () => {
    const result = await withRlsContext(ctx(ORG, USER_OUTSIDER), (tx) =>
      listMessages(tx, {
        orgId: ORG,
        userId: USER_OUTSIDER,
        threadId: subrunThreadId,
        limit: 50,
      }),
    )
    expect(result).toBeNull()
  })

  it("cross-org caller cannot see the sub-run thread (404 / null, no existence leak)", async () => {
    const result = await withRlsContext(ctx(OTHER_ORG, USER_CROSS_ORG), (tx) =>
      listMessages(tx, {
        orgId: OTHER_ORG,
        userId: USER_CROSS_ORG,
        threadId: subrunThreadId,
        limit: 50,
      }),
    )
    expect(result).toBeNull()
  })
})
