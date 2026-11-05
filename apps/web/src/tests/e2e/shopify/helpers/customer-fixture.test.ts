// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 E2E harness H3 — paired-fixture invariants for the
// customer helpers. Both shapes must round-trip the same identity.
import { describe, expect, it } from "bun:test"
import {
  customerFixture,
  customerGraphqlNode,
  customersGraphqlResponse,
  customerWebhookBody,
} from "./customer-fixture"

describe("Shopify customer fixtures", () => {
  it("graphql + webhook share the same identity for a given fixture", () => {
    const f = customerFixture({
      numericId: "42",
      email: "marie@example.com",
      firstName: "Marie",
      lastName: "Curie",
    })
    const node = customerGraphqlNode(f)
    const webhook = customerWebhookBody(f)
    // Numeric id present on both sides.
    expect(node.id).toBe("gid://shopify/Customer/42")
    expect(webhook.id).toBe(42)
    // Email and name match.
    expect(node.email).toBe(webhook.email)
    expect(node.firstName).toBe(webhook.first_name)
    expect(node.lastName).toBe(webhook.last_name)
  })

  it("customersGraphqlResponse wraps N fixtures with pageInfo + throttleStatus", () => {
    const a = customerFixture({ numericId: "1", email: "a@x.com" })
    const b = customerFixture({ numericId: "2", email: "b@x.com" })
    const resp = customersGraphqlResponse([a, b]) as {
      data: {
        customers: {
          nodes: unknown[]
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
        }
      }
      extensions: { cost: { throttleStatus: { currentlyAvailable: number } } }
    }
    expect(resp.data.customers.nodes.length).toBe(2)
    expect(resp.data.customers.pageInfo.hasNextPage).toBe(false)
    expect(resp.extensions.cost.throttleStatus.currentlyAvailable).toBe(1999)
  })

  it("defaults firstName/lastName when not provided", () => {
    const f = customerFixture({ email: "c@x.com" })
    expect(f.firstName).toBe("Test")
    expect(f.lastName).toBe("User")
    expect(f.shopifyId).toBe("gid://shopify/Customer/1")
  })
})
