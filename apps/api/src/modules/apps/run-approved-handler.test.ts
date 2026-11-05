// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { UserContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import {
  approvalExecutionActor,
  delegateDeciderAuthority,
  handlerErrorMessage,
  RequesterLostScopeError,
  runApprovedToolHandler,
} from "~/modules/apps/run-approved-handler"

function user(scopes: string[], dimensionGrants: Record<string, string[]> = {}): UserContext {
  return { actorType: "user", userId: "u1", orgId: "o1", scopes, dimensionGrants }
}

describe("approvalExecutionActor — the actor an approved gated handler executes under", () => {
  it("aliases a granular shopify requester so the app's internal install_metadata is readable", () => {
    // Regression for the approval-execution gap: a gated shopify write approved by a non-admin ran
    // under the requester's bare scopes, so the app-internal install_metadata row (rlsScope:internal)
    // was invisible and the handler failed closed with "install_metadata row not found". The
    // execution actor must carry the same app alias the DIRECT tool path applies.
    const actor = approvalExecutionActor(
      user(["shopify:inventory:write"]),
      "shopify:inventory_set_on_hand",
    )
    expect(actor.scopes).toContain("shopify:inventory:write") // original retained
    expect(actor.scopes).toContain("shopify:internal:read") // app infra now readable
    expect(actor.scopes).not.toContain("shopify:internal:write") // writes stay gated
  })

  it("parses the app name from the canonical app:tool form", () => {
    // tickets read aliases the messages sub-resource — proves the appName is taken from the tool's
    // prefix (not the tool short name) when applying the per-app alias.
    const actor = approvalExecutionActor(user(["tickets:tickets:read"]), "tickets:reply")
    expect(actor.scopes).toContain("tickets:messages:read")
  })

  it("does not grant the internal alias to a requester with no shopify scope", () => {
    const actor = approvalExecutionActor(user(["tickets:tickets:read"]), "shopify:orders_get")
    expect(actor.scopes).not.toContain("shopify:internal:read")
  })

  it("mirrors bare dimension grants under the target app namespace", () => {
    const actor = approvalExecutionActor(
      user(["shopify:orders:read"], { team: ["*"] }),
      "shopify:orders_get",
    )
    if (actor.actorType !== "user") throw new Error("expected a user actor")
    expect(actor.dimensionGrants["shopify:team"]).toEqual(["*"])
  })
})

describe("delegateDeciderAuthority: approving lends the decider's authority, never their identity", () => {
  const admin: UserContext = {
    actorType: "user",
    userId: "admin",
    orgId: "o1",
    scopes: ["*"],
    dimensionGrants: { "*": ["*"], team: ["ops"] },
  }

  it("unions scopes and dimension grants while the acting user stays the requester", () => {
    const merged = delegateDeciderAuthority(
      user(["knowledge:documents:update"], { sensitivity: ["internal"], team: ["support"] }),
      admin,
    )
    expect(merged.userId).toBe("u1")
    expect(merged.scopes).toEqual(expect.arrayContaining(["knowledge:documents:update", "*"]))
    expect(merged.dimensionGrants).toEqual({
      sensitivity: ["internal"],
      team: ["support", "ops"],
      "*": ["*"],
    })
  })

  it("the execution actor carries the delegated grants under the target app namespace too", () => {
    const actor = approvalExecutionActor(
      user(["knowledge:documents:update"], { sensitivity: ["internal"] }),
      "knowledge:update",
      { ...admin, dimensionGrants: { sensitivity: ["confidential"] } },
    )
    if (actor.actorType !== "user") throw new Error("expected a user actor")
    expect(actor.dimensionGrants.sensitivity).toEqual(["internal", "confidential"])
    expect(actor.dimensionGrants["knowledge:sensitivity"]).toEqual(["internal", "confidential"])
  })

  it("is a no-op without a decider, for a self-approval, and across orgs", () => {
    const requester = user(["a:b:c"], { team: ["support"] })
    expect(delegateDeciderAuthority(requester, undefined)).toBe(requester)
    expect(delegateDeciderAuthority(requester, { ...admin, userId: "u1" })).toBe(requester)
    expect(delegateDeciderAuthority(requester, { ...admin, orgId: "other" })).toBe(requester)
  })
})

describe("runApprovedToolHandler authorizes on the tool's resolved scope set", () => {
  // A manifest tool may declare only `requiredScopes`. The check read the legacy
  // single `scope`, which such a tool does not have, so every approval of it was
  // refused ("neither the requester nor the approver holds scope undefined"),
  // whoever approved: every Boxtal shipment stopped at its approval.
  const ORG = crypto.randomUUID()
  const APP = `rq${ORG.slice(0, 6)}`
  const TOOL = "ship_it"
  const REQUESTER = crypto.randomUUID()

  function ctx(userId: string, scopes: string[]): UserContext {
    return { actorType: "user", userId, orgId: ORG, scopes, dimensionGrants: {} }
  }

  function run(requesterScopes: string[], deciderScopes?: string[]) {
    return runApprovedToolHandler({
      orgId: ORG,
      requesterContext: ctx(REQUESTER, requesterScopes),
      deciderId: REQUESTER,
      ...(deciderScopes ? { deciderContext: ctx(crypto.randomUUID(), deciderScopes) } : {}),
      toolName: `${APP}:${TOOL}`,
      payload: {},
      approvalRequestId: crypto.randomUUID(),
      threadId: crypto.randomUUID(),
    })
  }

  beforeAll(() => {
    toolRegistry.set([ORG, APP, TOOL], {
      appName: APP,
      name: TOOL,
      description: "test",
      requiredScopes: [`${APP}:shipments:write`, `${APP}:quotes:read`],
      handler: async () => ({ ok: true }),
    } as never)
  })
  afterAll(() => toolRegistry.deleteByPrefix([ORG]))

  it("lets a requester holding every required scope past the authority check", async () => {
    const err = await run([`${APP}:shipments:write`, `${APP}:quotes:read`]).catch((e) => e)
    expect(err).not.toBeInstanceOf(RequesterLostScopeError)
  })

  it("lets a decider lend the scopes the requester lacks", async () => {
    const err = await run([], [`${APP}:*`]).catch((e) => e)
    expect(err).not.toBeInstanceOf(RequesterLostScopeError)
  })

  it("refuses when a required scope is held by neither, and names it", async () => {
    const err = (await run([`${APP}:shipments:write`]).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(RequesterLostScopeError)
    expect(String(err.message)).toContain(`${APP}:quotes:read`)
    expect(String(err.message)).not.toContain("undefined")
  })
})

describe("handlerErrorMessage -> the approval card text for a handler that threw", () => {
  it("drops the SQL and bound params of a DB error, keeps the server's reason", () => {
    const err = new Error(
      'Failed query: update "kernel"."agents" set "scope_ceiling" = $1\nparams: ["calendar:events:read","tickets:approve"],9ab229d3,personal',
    ) as Error & { cause?: unknown }
    err.cause = Object.assign(new Error("agents_personal_owner_rename_only"), { code: "P0001" })
    const msg = handlerErrorMessage(err)
    expect(msg).not.toContain("Failed query")
    expect(msg).not.toContain("params")
    expect(msg).not.toContain("calendar:events:read")
    expect(msg).toContain("agents_personal_owner_rename_only")
  })

  it("names a wrong-format value (22P02) as a caller error, not a generic database error", () => {
    const err = new Error(
      'findMany failed - pg: invalid input syntax for type uuid: "CARRIER-123" (22P02)',
    )
    const msg = handlerErrorMessage(err)
    expect(msg).not.toContain("failed on a database error")
    expect(msg).toContain("wrong format")
    expect(msg).toContain("CARRIER-123")
  })

  it("keeps a plain handler error as is", () => {
    expect(handlerErrorMessage(new Error("collection not found"))).toBe("collection not found")
  })
})
