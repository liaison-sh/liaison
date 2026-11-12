// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A link picker's tool runs as the person who picks (their origin, their grants) and may only
// read: never with the webhook/job ("system") provenance.

import { describe, expect, it } from "bun:test"
import type { UserContext } from "~/db/rls"
import { pickToolCall } from "~/modules/dashboards/tables/link-search"

const viewer: UserContext = {
  actorType: "user",
  userId: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
  scopes: ["shop:read"],
  dimensionGrants: {},
}

describe("pick tool dispatch", () => {
  it("runs the pick tool as the person, read only", () => {
    const call = pickToolCall(
      viewer,
      "shop",
      { tool: "orders_search", queryParam: "query", idField: "id", labelField: "name" },
      "ACME",
      { origin: "human-ui" },
    )
    expect(call).toEqual({
      toolName: "shop:orders_search",
      orgId: viewer.orgId,
      actor: viewer,
      params: { query: "ACME" },
      origin: "human-ui",
      readOnlyRun: true,
    })
  })
})
