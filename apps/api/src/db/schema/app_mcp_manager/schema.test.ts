// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  mcpAgentVisibilityEnum,
  mcpAuthFlavorEnum,
  mcpDefaultPolicyEnum,
  mcpManagedByEnum,
  mcpOwnershipScopeEnum,
  mcpTransportEnum,
} from "~/db/schema/app_mcp_manager"

describe("app_mcp_manager schema", () => {
  // Note: the column-shape coverage (constraints, defaults, FKs) is asserted at
  // Task 2's migration-apply level, where DB constraints actually fire. Here we
  // assert only runtime-observable invariants that the type system cannot prove.
  it("transport enum exposes exactly the spec'd values in spec'd order", () => {
    expect(mcpTransportEnum.enumValues).toEqual(["http", "sse"])
  })
  it("default-policy enum exposes exactly the spec'd values", () => {
    expect(mcpDefaultPolicyEnum.enumValues).toEqual(["auto", "gate_writes", "gate_all"])
  })
  it("auth-flavor enum exposes exactly the spec'd values", () => {
    expect(mcpAuthFlavorEnum.enumValues).toEqual(["none", "bearer", "oauth_dcr", "oauth_static"])
  })
  it("managed-by enum exposes exactly the spec'd values", () => {
    expect(mcpManagedByEnum.enumValues).toEqual(["env", "ui"])
  })
  it("ownership-scope enum exposes exactly the spec'd values", () => {
    expect(mcpOwnershipScopeEnum.enumValues).toEqual(["org", "personal"])
  })
  it("agent-visibility enum exposes exactly the spec'd values", () => {
    expect(mcpAgentVisibilityEnum.enumValues).toEqual(["discoverable", "hidden"])
  })
})
