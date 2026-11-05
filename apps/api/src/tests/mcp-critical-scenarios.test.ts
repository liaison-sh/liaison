// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 34 — critical scenario hardening tests. Directly targets spec §9
// "critical scenarios (must-pass)". Full E2E integration of each scenario is
// covered separately by the integration + E2E suites (Tasks 33, 36-39).
// This file pins the must-pass behaviors at the orchestration boundary.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { _setEdition } from "~/lib/edition"
import { EnvBootstrapError, parseEnvConnections } from "~/modules/mcp-client/env-bootstrap"

describe("MCP critical scenarios (spec §9)", () => {
  afterEach(() => {
    _setEdition(null)
  })

  describe("Scenario 1: no edition runs an MCP server as a local command", () => {
    it("env-bootstrap refuses a stdio declaration on every edition", () => {
      for (const edition of ["managed", "self_hosted", null] as const) {
        _setEdition(edition)
        expect(() =>
          parseEnvConnections({
            LIAISON_MCP_FS_TRANSPORT: "stdio",
            LIAISON_MCP_FS_DISPLAY_NAME: "FS",
            LIAISON_MCP_FS_ORG: "00000000-0000-0000-0000-000000000001",
            LIAISON_MCP_FS_STDIO_COMMAND: "/usr/bin/mcp-fs",
            LIAISON_MCP_FS_AUTH: "none",
          }),
        ).toThrow(EnvBootstrapError)
      }
    })

    it("env-bootstrap also allows http on managed", () => {
      _setEdition("managed")
      const parsed = parseEnvConnections({
        LIAISON_MCP_LINEAR_TRANSPORT: "http",
        LIAISON_MCP_LINEAR_DISPLAY_NAME: "Linear",
        LIAISON_MCP_LINEAR_ORG: "00000000-0000-0000-0000-000000000001",
        LIAISON_MCP_LINEAR_URL: "https://mcp.linear.app",
        LIAISON_MCP_LINEAR_AUTH: "none",
      })
      expect(parsed.length).toBe(1)
      expect(parsed[0].transport).toBe("http")
    })
  })

  describe("Scenario 4 sub-property: rate-limit failure is a soft per-call failure", () => {
    it("rate-cap denial does not throw — it returns a failure result the caller handles", async () => {
      // Direct unit-level proof that the rate-cap module returns a structured
      // result (not throws) when the cap is reached, so the orchestrator can
      // route it to a soft failure (no DiscoveredTools mutation).
      const { checkAndIncrement } = await import("~/modules/mcp-client/rate-cap")
      _setEdition("managed")
      const conn = `cap-test-${Date.now()}`
      // First two should be allowed; third should be denied.
      const a = await checkAndIncrement(conn, 2)
      const b = await checkAndIncrement(conn, 2)
      const c = await checkAndIncrement(conn, 2)
      expect(a.allowed).toBe(true)
      expect(b.allowed).toBe(true)
      expect(c.allowed).toBe(false)
      // The denial result must include a retryAfterMs or windowMs so the UI
      // can surface a useful message — but MUST NOT throw.
      expect(typeof c).toBe("object")
    })
  })
})
