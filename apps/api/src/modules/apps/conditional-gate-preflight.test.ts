// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A GATED CALL MUST NOT BE STAGED WHEN THE DATA IT NEEDS IS MISSING — and
// "gated" includes handler-CONDITIONAL gating. A `conditionalGate` tool is not
// `tool.gated`: it decides inside its handler whether to park an approval (an
// org-scoped knowledge doc does, a personal note does not). The stage-time
// preflight hook used to require `tool.gated`, and `conditionalGate` was not
// even carried into the tool registry, so NO conditionally-gated tool could
// ever be preflighted: every one of them validated only after the approver had
// clicked approve.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { ActorContext, UserContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000c6001"
const USER = "00000000-0000-4000-8000-0000000c6002"
const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["cg_test:write"],
  dimensionGrants: {},
}

let preflightRan = 0
let handlerRan = 0

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'CondGate Org', 'condgate-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, 'condgate@test.com', 'Staffer', 'active', 'hash') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
    VALUES (${USER}, ${ORG}, 'cg_test:write') ON CONFLICT DO NOTHING`

  // A knowledge:create-shaped tool: gating decided in the handler, with a
  // preflight that rejects params the handler could never execute.
  toolRegistry.set([ORG, "cg_test", "publish"], {
    appName: "cg_test",
    name: "publish",
    description: "publish a document; org scope parks an approval",
    requiredScopes: ["cg_test:write"],
    conditionalGate: true,
    preflight: async (p: any) => {
      preflightRan += 1
      if (!p.collectionId) {
        return { error: { code: "collection_required", message: "pass collectionId" } }
      }
      return { ok: true }
    },
    handler: async () => {
      handlerRan += 1
      return { id: "doc-1" }
    },
  } as never)
}, 60_000)

afterAll(async () => {
  toolRegistry.deleteByPrefix([ORG])
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
}, 60_000)

describe("stage-time preflight on a conditionally-gated tool", () => {
  it("runs the preflight and refuses the call before the handler (or an approval) is reached", async () => {
    preflightRan = 0
    handlerRan = 0
    // executeTool surfaces a tool error by throwing an Error carrying the code.
    const err = await executeTool({
      toolName: "cg_test:publish",
      orgId: ORG,
      actor,
      origin: "in-app-agent",
      params: { title: "T" },
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe("collection_required")
    expect(preflightRan).toBe(1)
    expect(handlerRan).toBe(0)
  })

  it("lets a complete call through to the handler", async () => {
    preflightRan = 0
    handlerRan = 0
    const res = await executeTool({
      toolName: "cg_test:publish",
      orgId: ORG,
      actor,
      origin: "in-app-agent",
      params: { title: "T", collectionId: "c1" },
    })
    expect(preflightRan).toBe(1)
    expect(handlerRan).toBe(1)
    expect((res as { data?: { id?: string } }).data?.id ?? (res as { id?: string }).id).toBe(
      "doc-1",
    )
  })
})
