// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seed route's thread message and the product must name the SAME speaking agent.
//
// `test-support/seed/inject.ts` attributes an agent-authored fixture row (the
// api e2e scenarios' `helpers/thread-seed.ts` asks it to). The e2e helper used
// to re-derive the rule instead of following the runtime's: it
// selected on the handle `@base` and ignored `archived_at`, while
// `resolveActingAgentIdForWrite` takes the org's earliest NON-ARCHIVED
// `kind='system'` agent whatever it is called. An org that does not match that
// one spelling got a fixture the product would never have written, which is a
// scenario asserting something about a row that does not exist in production.
//
// These cases run BOTH answerers against the same org and compare.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { turnEndRequiredScopes } from "~/modules/agent/runtime/agent-service"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { resolveActingAgentIdForWrite } from "~/modules/threads/message"
import {
  defaultAgentReplyRequiredScopes,
  speakingAgentIdFor,
} from "../../../test-support/seed/inject"

const ORG_NAMED = crypto.randomUUID()
const ORG_ARCHIVED = crypto.randomUUID()
const USER_NAMED = crypto.randomUUID()
const USER_ARCHIVED = crypto.randomUUID()

function ctx(orgId: string, userId: string): UserContext {
  return { actorType: "user", userId, orgId, scopes: [], dimensionGrants: {} }
}

async function seedOrg(orgId: string, userId: string, label: string): Promise<void> {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${orgId}, ${label}, ${`${label}-${orgId.slice(0, 8)}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${userId}, ${orgId}, ${`${label}-${orgId.slice(0, 8)}@test.com`}, 'writer', 'x')`
}

/** What the product would attribute an agent-authored write to. */
function runtimeAnswer(orgId: string, userId: string): Promise<string | null> {
  return withRlsContext(ctx(orgId, userId), (tx) =>
    resolveActingAgentIdForWrite(tx, { orgId, userId, authorType: "agent" }),
  )
}

beforeAll(async () => {
  await seedOrg(ORG_NAMED, USER_NAMED, "seedparity-named")
  await seedOrg(ORG_ARCHIVED, USER_ARCHIVED, "seedparity-archived")
})

afterAll(async () => {
  for (const orgId of [ORG_NAMED, ORG_ARCHIVED]) {
    await sql`DELETE FROM kernel.agents WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
  }
})

describe("the e2e seed helper picks the agent the runtime would pick", () => {
  it("an org whose system agent is not called @base", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name)
      VALUES (${ORG_NAMED}, 'system', '@ops', 'Ops')
      RETURNING id`
    const expected = row.id

    expect(await runtimeAnswer(ORG_NAMED, USER_NAMED)).toBe(expected)
    expect(await speakingAgentIdFor(ORG_NAMED, USER_NAMED)).toBe(expected)

    // And the helper invented nothing on the way: still one agent in the org.
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.agents WHERE org_id = ${ORG_NAMED}`
    expect(count.n).toBe(1)
  })

  it("an org whose @base is archived and whose live system agent is another row", async () => {
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, archived_at)
      VALUES (${ORG_ARCHIVED}, 'system', '@base', 'Base', now())`
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name)
      VALUES (${ORG_ARCHIVED}, 'system', '@base-2', 'Base 2')
      RETURNING id`
    const expected = row.id

    expect(await runtimeAnswer(ORG_ARCHIVED, USER_ARCHIVED)).toBe(expected)
    expect(await speakingAgentIdFor(ORG_ARCHIVED, USER_ARCHIVED)).toBe(expected)
  })
})

// The same parity, one column over: the TAG a seeded agent reply carries has to
// be the tag the reply path would have written. The helper briefly defaulted to
// the speaking agent's scope_ceiling, which is what an ABNORMALLY ended turn
// once widened to (it is now only the fallback of a turn whose record was lost):
// every fixture reply was then tagged as a failed scoped turn and hidden from
// the room, and four scenarios that relied on a visible reply broke.
describe("the e2e seed helper tags an agent reply the way the reply path would", () => {
  it("matches turnEndRequiredScopes for a clean turn that made no tool call", () => {
    const runtime = turnEndRequiredScopes({
      accumulator: createTurnScopeAccumulator(),
      requesterScopes: ["tickets:read", "mail:read"],
    })
    expect(defaultAgentReplyRequiredScopes()).toEqual(runtime)
  })

  it("is the empty set, the positive assertion that the turn touched nothing scoped", () => {
    expect(defaultAgentReplyRequiredScopes()).toEqual([])
  })

  it("is NOT the ceiling a turn whose record was lost carries, which is what the ceiling default was", () => {
    const fallback = turnEndRequiredScopes({
      accumulator: undefined,
      fullEffectiveScope: ["tickets:read", "mail:read"],
      requesterScopes: ["tickets:read", "mail:read"],
    })
    expect(fallback.length).toBeGreaterThan(0)
    expect(defaultAgentReplyRequiredScopes()).not.toEqual(fallback)
  })
})
