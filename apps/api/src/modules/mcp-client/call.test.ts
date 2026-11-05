// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import type { ConnectionRow, McpRepo, PolicyResolution } from "~/apps/mcp-manager/types"
import type { UserContext } from "~/db/rls"
import { _setEdition } from "~/lib/edition"
import { type AuditEvent, type LiveConnection, makeOrchestrator } from "./call"
import type { HealthTracker } from "./health"
import { McpAuthChallengeError } from "./transports/types"

const CONN_ID = "11111111-1111-1111-1111-111111111111"
const ORG_ID = "22222222-2222-2222-2222-222222222222"
const USER_ID = "33333333-3333-3333-3333-333333333333"

const ACTOR: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: [],
  dimensionGrants: {},
}

function makeConn(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: CONN_ID,
    orgId: ORG_ID,
    slug: "linear",
    displayName: "Linear",
    transport: "http",
    ownershipScope: "org",
    ownerUserId: null,
    httpUrl: "https://mcp.linear.app",
    authFlavor: "none",
    secretsEncrypted: null,
    oauthMetadata: null,
    agentVisibility: "discoverable",
    exposeViaGateway: true,
    connectionDefaultPolicy: "auto",
    managedBy: "ui",
    disabled: false,
    rateCapPerMinute: 120,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: USER_ID,
    ...overrides,
  } as ConnectionRow
}

function stubRepo(
  opts: { conn?: ConnectionRow | null; policy?: PolicyResolution } = {},
): Pick<McpRepo, "getConnectionForCall" | "getPolicyForCall"> {
  const conn = opts.conn === undefined ? makeConn() : opts.conn
  const policy: PolicyResolution = opts.policy ?? {
    decision: "auto",
    policyPath: "connection_default",
  }
  return {
    getConnectionForCall: mock(async () => conn),
    getPolicyForCall: mock(async () => policy),
  }
}

function stubHealth(): Pick<
  HealthTracker,
  "markConnected" | "markDialFailed" | "markFailed" | "markNeedsReauth"
> {
  return {
    markConnected: mock(async () => {}),
    markDialFailed: mock(async () => {}),
    markFailed: mock(async () => {}),
    markNeedsReauth: mock(async () => {}),
  }
}

function stubLive(callTool?: LiveConnection["client"]["callTool"]): LiveConnection {
  return {
    client: { callTool: callTool ?? (async () => ({ ok: true })) },
    close: async () => {},
  }
}

describe("mcp-client per-call orchestrator", () => {
  let envBackup: Record<string, string | undefined> = {}
  beforeEach(() => {
    envBackup = {
      MCP_MAX_RESPONSE_BYTES: process.env.MCP_MAX_RESPONSE_BYTES,
      MCP_RATE_CAP_PER_MINUTE_DEFAULT: process.env.MCP_RATE_CAP_PER_MINUTE_DEFAULT,
      LIAISON_EDITION: process.env.LIAISON_EDITION,
    }
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it("happy path: dial → tools/call → audit emitted with policy_path + outcome=ok", async () => {
    const audits: AuditEvent[] = []
    const live = stubLive()
    const orchestrator = makeOrchestrator({
      pool: { get: async () => live, drop: async () => {} },
      repo: stubRepo(),
      audit: async (e) => {
        audits.push(e)
      },
      health: stubHealth(),
      oauthRefresh: async () => ({ ok: true }),
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: { x: 1 },
      actor: ACTOR,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ ok: true })
    expect(audits).toHaveLength(1)
    expect(audits[0].data).toMatchObject({
      connection_id: CONN_ID,
      slug: "linear",
      tool_name: "linear:echo",
      decision: "auto",
      policy_path: "connection_default",
      outcome: "ok",
    })
    expect(audits[0].data.latency_ms).toBeGreaterThanOrEqual(0)
    expect(audits[0].data.request_bytes).toBeGreaterThan(0)
    expect((audits[0].data as any).response_bytes).toBeGreaterThan(0)
  })

  it("policy=deny short-circuits before transport call; audit outcome=denied", async () => {
    const audits: AuditEvent[] = []
    const callTool = mock(async () => ({ ok: true }))
    const orchestrator = makeOrchestrator({
      pool: { get: async () => stubLive(callTool), drop: async () => {} },
      repo: stubRepo({ policy: { decision: "deny", policyPath: "tool" } }),
      audit: async (e) => {
        audits.push(e)
      },
      health: stubHealth(),
      oauthRefresh: async () => ({ ok: true }),
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result.ok).toBe(false)
    expect(callTool.mock.calls).toHaveLength(0)
    expect(audits[0].data.outcome).toBe("denied")
    expect(audits[0].data.policy_path).toBe("tool")
  })

  it("policy=gate returns code=denied reason=gate_required (caller wraps into approval envelope)", async () => {
    const audits: AuditEvent[] = []
    const callTool = mock(async () => ({ ok: true }))
    const orchestrator = makeOrchestrator({
      pool: { get: async () => stubLive(callTool), drop: async () => {} },
      repo: stubRepo({ policy: { decision: "gate", policyPath: "role", policyRoleId: "role-x" } }),
      audit: async (e) => {
        audits.push(e)
      },
      health: stubHealth(),
      oauthRefresh: async () => ({ ok: true }),
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("denied")
      expect(result.error.reason).toBe("gate_required")
    }
    expect(callTool.mock.calls).toHaveLength(0)
    expect(audits[0].data.decision).toBe("gate")
    expect(audits[0].data.policy_role_id).toBe("role-x")
  })

  // The call a human APPROVED (executeTool's static gate parked it, the approval
  // re-entry runs it) must not be gated a second time here: it used to come back
  // gate_required, so no gated MCP tool ever ran after its approval.
  it("policy=gate on an approved re-entry runs the call; deny still refuses it", async () => {
    const audits: AuditEvent[] = []
    const callTool = mock(async () => ({ ok: true }))
    const orchestrator = makeOrchestrator({
      pool: { get: async () => stubLive(callTool), drop: async () => {} },
      repo: stubRepo({ policy: { decision: "gate", policyPath: "connection_default" } }),
      audit: async (e) => {
        audits.push(e)
      },
      health: stubHealth(),
      oauthRefresh: async () => ({ ok: true }),
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
      approved: true,
    })
    expect(result.ok).toBe(true)
    expect(callTool.mock.calls).toHaveLength(1)

    const denying = makeOrchestrator({
      pool: { get: async () => stubLive(callTool), drop: async () => {} },
      repo: stubRepo({ policy: { decision: "deny", policyPath: "tool" } }),
      audit: async () => {},
      health: stubHealth(),
      oauthRefresh: async () => ({ ok: true }),
    })
    const refused = await denying.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
      approved: true,
    })
    expect(refused.ok).toBe(false)
    expect(callTool.mock.calls).toHaveLength(1)
  })

  it("rate-cap exceeded → outcome=rate_limited with retry_after_ms; tools/call NOT issued", async () => {
    _setEdition("managed")
    const audits: AuditEvent[] = []
    const callTool = mock(async () => ({ ok: true }))
    // Override conn with a tiny rate cap so the very first call would exceed it
    // if we did many — instead use the in-process counter by burning 2 calls in
    // a single minute with cap=1.
    const uniqueId = crypto.randomUUID()
    const orchestrator = makeOrchestrator({
      pool: { get: async () => stubLive(callTool), drop: async () => {} },
      repo: stubRepo({ conn: makeConn({ id: uniqueId, rateCapPerMinute: 1 }) }),
      audit: async (e) => {
        audits.push(e)
      },
      health: stubHealth(),
      oauthRefresh: async () => ({ ok: true }),
    })
    const first = await orchestrator.executeMcpCall({
      connectionId: uniqueId,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(first.ok).toBe(true)
    const second = await orchestrator.executeMcpCall({
      connectionId: uniqueId,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.error.code).toBe("rate_limited")
      expect(second.error.retryAfterMs).toBeGreaterThan(0)
    }
    expect(audits[1].data.outcome).toBe("rate_limited")
    expect(callTool.mock.calls).toHaveLength(1) // not called on second
    _setEdition(null)
  })

  it("transport dial error → outcome=transport_error; health.markDialFailed called", async () => {
    const audits: AuditEvent[] = []
    const health = stubHealth()
    const orchestrator = makeOrchestrator({
      pool: {
        get: async () => {
          throw new Error("ECONNREFUSED")
        },
        drop: async () => {},
      },
      repo: stubRepo(),
      audit: async (e) => {
        audits.push(e)
      },
      health,
      oauthRefresh: async () => ({ ok: true }),
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("transport_error")
      expect(result.error.reason).toContain("ECONNREFUSED")
    }
    expect(audits[0].data.outcome).toBe("transport_error")
    expect((health.markDialFailed as any).mock.calls).toHaveLength(1)
  })

  it("transport error post-dial → outcome=transport_error; pool.drop + health.markFailed called", async () => {
    const audits: AuditEvent[] = []
    const health = stubHealth()
    const drop = mock(async () => {})
    const callTool = mock(async () => {
      throw new Error("stream-closed")
    })
    const orchestrator = makeOrchestrator({
      pool: { get: async () => stubLive(callTool), drop },
      repo: stubRepo(),
      audit: async (e) => {
        audits.push(e)
      },
      health,
      oauthRefresh: async () => ({ ok: true }),
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result.ok).toBe(false)
    expect(drop.mock.calls).toHaveLength(1)
    expect((health.markFailed as any).mock.calls).toHaveLength(1)
    expect(audits[0].data.outcome).toBe("transport_error")
  })

  it("OAuth 401 → refresh succeeds → retries once → ok with ONE audit row", async () => {
    const audits: AuditEvent[] = []
    const callTool = mock(async (_params: { name: string; arguments?: unknown }) => {
      if (callTool.mock.calls.length === 1) {
        throw Object.assign(new Error("Unauthorized"), { cause: { httpStatus: 401 } })
      }
      return { echoed: "hi" }
    })
    const oauthRefresh = mock(async () => ({ ok: true as const }))
    const orchestrator = makeOrchestrator({
      pool: { get: async () => stubLive(callTool), drop: async () => {} },
      repo: stubRepo(),
      audit: async (e) => {
        audits.push(e)
      },
      health: stubHealth(),
      oauthRefresh,
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: { x: 1 },
      actor: ACTOR,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ echoed: "hi" })
    expect(audits).toHaveLength(1)
    expect(audits[0].data.outcome).toBe("ok")
    expect(oauthRefresh.mock.calls).toHaveLength(1)
    expect(callTool.mock.calls).toHaveLength(2)
  })

  it("OAuth 401 → refresh fails → outcome=denied/needs_reauth + markNeedsReauth fired", async () => {
    const audits: AuditEvent[] = []
    const health = stubHealth()
    const callTool = mock(async () => {
      throw Object.assign(new Error("Unauthorized"), { cause: { httpStatus: 401 } })
    })
    const oauthRefresh = mock(async () => ({
      ok: false as const,
      kind: "invalid_grant" as const,
      reason: "refresh_token_revoked",
    }))
    const orchestrator = makeOrchestrator({
      pool: { get: async () => stubLive(callTool), drop: async () => {} },
      repo: stubRepo(),
      audit: async (e) => {
        audits.push(e)
      },
      health,
      oauthRefresh,
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("denied")
      expect(result.error.reason).toBe("needs_reauth")
    }
    expect(
      audits.some((a) => a.data.outcome === "denied" && a.data.reason === "needs_reauth"),
    ).toBe(true)
    expect((health.markNeedsReauth as any).mock.calls).toHaveLength(1)
    expect((health.markNeedsReauth as any).mock.calls[0][1]).toBe("refresh_token_revoked")
  })

  it("response > MCP_MAX_RESPONSE_BYTES → outcome=response_too_large; payload NOT leaked into audit", async () => {
    process.env.MCP_MAX_RESPONSE_BYTES = "100"
    const audits: AuditEvent[] = []
    const big = "x".repeat(500)
    const callTool = mock(async () => ({ data: big }))
    const orchestrator = makeOrchestrator({
      pool: { get: async () => stubLive(callTool), drop: async () => {} },
      repo: stubRepo(),
      audit: async (e) => {
        audits.push(e)
      },
      health: stubHealth(),
      oauthRefresh: async () => ({ ok: true }),
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("response_too_large")
      expect(result.error.receivedBytes).toBeGreaterThan(100)
      expect(result.error.limitBytes).toBe(100)
    }
    // crucial: payload must not be reflected into audit row
    const stringified = JSON.stringify(audits[0].data)
    expect(stringified).not.toContain("xxxxx")
    expect(audits[0].data).not.toHaveProperty("response")
  })

  it("connection disabled at call start → outcome=denied reason=connection_disabled (no dial)", async () => {
    const audits: AuditEvent[] = []
    const orchestrator = makeOrchestrator({
      pool: {
        get: async () => {
          throw new Error("should not dial")
        },
        drop: async () => {},
      },
      repo: stubRepo({ conn: makeConn({ disabled: true }) }),
      audit: async (e) => {
        audits.push(e)
      },
      health: stubHealth(),
      oauthRefresh: async () => ({ ok: true }),
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("denied")
      expect(result.error.reason).toBe("connection_disabled")
    }
    expect(audits[0].data.outcome).toBe("denied")
    expect(audits[0].data.reason).toBe("connection_disabled")
  })

  it("connection not found → outcome=denied reason=connection_not_found", async () => {
    const audits: AuditEvent[] = []
    const orchestrator = makeOrchestrator({
      pool: {
        get: async () => {
          throw new Error("nope")
        },
        drop: async () => {},
      },
      repo: stubRepo({ conn: null }),
      audit: async (e) => {
        audits.push(e)
      },
      health: stubHealth(),
      oauthRefresh: async () => ({ ok: true }),
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.reason).toBe("connection_not_found")
    }
  })

  it("concurrent disable DURING in-flight call: orchestrator does NOT re-check disabled mid-flight", async () => {
    let getConnCalls = 0
    const repo: Pick<McpRepo, "getConnectionForCall" | "getPolicyForCall"> = {
      getConnectionForCall: async () => {
        getConnCalls++
        return makeConn() // always not-disabled
      },
      getPolicyForCall: async () => ({
        decision: "auto",
        policyPath: "connection_default",
      }),
    }
    const callTool = mock(async () => ({ ok: true }))
    const orchestrator = makeOrchestrator({
      pool: { get: async () => stubLive(callTool), drop: async () => {} },
      repo,
      audit: async () => {},
      health: stubHealth(),
      oauthRefresh: async () => ({ ok: true }),
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result.ok).toBe(true)
    expect(getConnCalls).toBe(1) // single check at entry, no re-check after dispatch
  })

  // ── S27/A15: the token lifecycle at the call boundary ────────────────────
  it("refreshes proactively BEFORE dialing when the token is about to expire", async () => {
    const order: string[] = []
    const orchestrator = makeOrchestrator({
      pool: {
        get: async () => {
          order.push("dial")
          return stubLive()
        },
        drop: async () => {},
      },
      repo: stubRepo(),
      audit: async () => {},
      health: stubHealth(),
      oauthRefresh: async () => ({ ok: true }),
      ensureFresh: async () => {
        order.push("ensureFresh")
        return { ok: true }
      },
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result.ok).toBe(true)
    expect(order).toEqual(["ensureFresh", "dial"])
  })

  it("a proactive refresh refused with invalid_grant → needs_reauth, no dial", async () => {
    const health = stubHealth()
    const get = mock(async () => stubLive())
    const orchestrator = makeOrchestrator({
      pool: { get, drop: async () => {} },
      repo: stubRepo(),
      audit: async () => {},
      health,
      oauthRefresh: async () => ({ ok: true }),
      ensureFresh: async () => ({ ok: false, kind: "invalid_grant", reason: "invalid_grant" }),
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result).toMatchObject({ ok: false, error: { reason: "needs_reauth" } })
    expect(get.mock.calls).toHaveLength(0)
    expect((health.markNeedsReauth as any).mock.calls).toHaveLength(1)
  })

  it("a transient proactive-refresh failure still tries the call with the current token", async () => {
    const callTool = mock(async () => ({ ok: true }))
    const orchestrator = makeOrchestrator({
      pool: { get: async () => stubLive(callTool), drop: async () => {} },
      repo: stubRepo(),
      audit: async () => {},
      health: stubHealth(),
      oauthRefresh: async () => ({ ok: true }),
      ensureFresh: async () => ({ ok: false, kind: "transient", reason: "http_503" }),
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result.ok).toBe(true)
    expect(callTool.mock.calls).toHaveLength(1)
  })

  it("a 401 at dial → refresh with the failed token's fingerprint → redial → ok", async () => {
    let dials = 0
    const oauthRefresh = mock(
      async (_id: string, _o?: { seenTokenFingerprint?: string | null }) => ({
        ok: true as const,
      }),
    )
    const orchestrator = makeOrchestrator({
      pool: {
        get: async () => {
          dials++
          if (dials === 1) {
            throw new McpAuthChallengeError(401, {}, "fp-old")
          }
          return stubLive()
        },
        drop: async () => {},
      },
      repo: stubRepo(),
      audit: async () => {},
      health: stubHealth(),
      oauthRefresh,
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result.ok).toBe(true)
    expect(dials).toBe(2)
    expect(oauthRefresh.mock.calls[0][1]).toEqual({ seenTokenFingerprint: "fp-old" })
  })

  it("a real SDK 401 (StreamableHTTPError code 401) triggers the refresh", async () => {
    const callTool = mock(async (_p: { name: string; arguments?: unknown }) => {
      if (callTool.mock.calls.length === 1) {
        throw Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint: {}"), {
          code: 401,
        })
      }
      return { ok: true }
    })
    const oauthRefresh = mock(async () => ({ ok: true as const }))
    const orchestrator = makeOrchestrator({
      pool: { get: async () => stubLive(callTool), drop: async () => {} },
      repo: stubRepo(),
      audit: async () => {},
      health: stubHealth(),
      oauthRefresh,
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result.ok).toBe(true)
    expect(oauthRefresh.mock.calls).toHaveLength(1)
  })

  it("a transient refresh failure after a 401 is a transport error, not needs_reauth", async () => {
    const health = stubHealth()
    const orchestrator = makeOrchestrator({
      pool: {
        get: async () =>
          stubLive(async () => {
            throw new McpAuthChallengeError(401, {}, "fp")
          }),
        drop: async () => {},
      },
      repo: stubRepo(),
      audit: async () => {},
      health,
      oauthRefresh: async () => ({ ok: false, kind: "transient", reason: "http_503" }),
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "echo",
      args: {},
      actor: ACTOR,
    })
    expect(result).toMatchObject({ ok: false, error: { code: "transport_error" } })
    expect((health.markNeedsReauth as any).mock.calls).toHaveLength(0)
  })

  it("403 insufficient_scope → needs_reauth with the challenged scope recorded for step-up", async () => {
    const audits: AuditEvent[] = []
    const health = stubHealth()
    const recordScopeChallenge = mock(async (_id: string, _scope: string) => {})
    const orchestrator = makeOrchestrator({
      pool: {
        get: async () =>
          stubLive(async () => {
            throw new McpAuthChallengeError(
              403,
              { error: "insufficient_scope", scope: "mcp:tools mcp:admin" },
              "fp",
            )
          }),
        drop: async () => {},
      },
      repo: stubRepo(),
      audit: async (e) => {
        audits.push(e)
      },
      health,
      oauthRefresh: async () => ({ ok: true }),
      recordScopeChallenge,
    })
    const result = await orchestrator.executeMcpCall({
      connectionId: CONN_ID,
      serverToolName: "admin_report",
      args: {},
      actor: ACTOR,
    })
    expect(result).toMatchObject({ ok: false, error: { reason: "needs_reauth" } })
    expect(recordScopeChallenge.mock.calls[0][1]).toBe("mcp:tools mcp:admin")
    expect((health.markNeedsReauth as any).mock.calls[0][1]).toBe("insufficient_scope")
    expect(audits.at(-1)?.data).toMatchObject({ outcome: "denied", reason: "insufficient_scope" })
  })
})
