// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A connector that is not connected yet answers with the structured
// `{ error: { code: "<platform>_not_connected" } }` envelope. Turning that
// into HTTP 500 left the ads dashboard reading a fresh deployment as an
// outage ("One or more panels could not load") instead of "Nothing connected
// yet": the envelope is the tool's answer, and it comes back with a 200.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import {
  executeTool,
  executeToolCore,
  isNotConnectedToolErrorCode,
} from "~/modules/apps/execute-tool"

const ORG = "00000000-0000-0000-0000-0000000000c1"
const USER = "00000000-0000-0000-0000-0000000000c2"

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["test_nc:items:read"],
  dimensionGrants: {},
}

function tool(name: string, result: unknown) {
  return {
    appName: "test_nc",
    name,
    description: "A connector read",
    requiredScopes: ["test_nc:items:read"],
    gated: false,
    handler: async () => result,
  }
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Not Connected Org', 'not-connected-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'not-connected@test.com', 'NC') ON CONFLICT DO NOTHING`
  toolRegistry.set(
    [ORG, "test_nc", "account_info"],
    tool("account_info", {
      error: { code: "meta_not_connected", message: "no Meta connection" },
    }) as any,
  )
  toolRegistry.set(
    [ORG, "test_nc", "broken_read"],
    tool("broken_read", { error: { code: "upstream_unavailable", message: "boom" } }) as any,
  )
})

afterAll(async () => {
  toolRegistry.delete([ORG, "test_nc", "account_info"])
  toolRegistry.delete([ORG, "test_nc", "broken_read"])
  await sql`DELETE FROM kernel.users WHERE id = ${USER}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("a not-connected connector answers, it does not fail", () => {
  it("recognises the not-connected codes and nothing else", () => {
    expect(isNotConnectedToolErrorCode("meta_not_connected")).toBe(true)
    expect(isNotConnectedToolErrorCode("google_not_connected")).toBe(true)
    expect(isNotConnectedToolErrorCode("shopify_not_connected")).toBe(true)
    expect(isNotConnectedToolErrorCode("not_connected")).toBe(true)
    expect(isNotConnectedToolErrorCode("upstream_unavailable")).toBe(false)
    expect(isNotConnectedToolErrorCode("tool_error")).toBe(false)
  })

  it("returns account_info's not_connected envelope as data, never a throw", async () => {
    const result = await executeTool({
      toolName: "test_nc:account_info",
      orgId: ORG,
      actor,
      params: {},
      origin: "human-ui",
    })
    expect(result.blocked).toBeUndefined()
    expect(result.data).toEqual({
      error: { code: "meta_not_connected", message: "no Meta connection" },
    })
  })

  it("still fails a genuine tool error", async () => {
    let status: number | undefined
    let code: string | undefined
    try {
      await executeTool({
        toolName: "test_nc:broken_read",
        orgId: ORG,
        actor,
        params: {},
        origin: "human-ui",
      })
      throw new Error("expected a throw")
    } catch (err) {
      status = (err as { status?: number }).status
      code = (err as { code?: string }).code
    }
    expect(code).toBe("upstream_unavailable")
    expect(status).toBe(500)
  })

  it("leaves the agent-facing core envelope alone", async () => {
    const envelope = await executeToolCore({
      toolName: "test_nc:account_info",
      orgId: ORG,
      actor,
      params: {},
      origin: "in-app-agent",
      callChain: [],
    })
    expect("error" in envelope && envelope.error.code).toBe("meta_not_connected")
  })
})
