// SPDX-License-Identifier: FSL-1.1-ALv2
// Shared test fixtures for the Phase 12 MCP suite.
//
// The plan's original sketch assumed a `tickets:create` manifest tool; the real
// codebase's mutating manifest fixture is the built-in `test` app (registered
// via registerApps from app.manifest.json + handler-bundle.ts — see
// test-app-sandbox.test.ts). We reuse that exact, proven pattern: `test:createItem`
// is a non-gated manifest tool that emits `items:created` through the RPC bridge
// (so its audit row carries the bridge actorType), and `test:gatedEcho` is a
// gated manifest tool whose decided execution also runs through the bridge.

import { sql } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { decideApproval } from "~/modules/approvals/decide"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { createMcpConnection } from "~/modules/mcp/connection-service"
import testManifest from "../../../test-support/apps/test/app.manifest.json"

/** The kernel schema as a quoted identifier, under the test namespace's prefix. */
const K = () => sql(schemaRef("kernel"))

const TEST_APP_BUNDLE = new URL(
  "../../../test-support/apps/test/handler-bundle.ts",
  import.meta.url,
).pathname

export function manifestWithBundle() {
  return {
    ...testManifest,
    _format: "manifest",
    _bundlePath: TEST_APP_BUNDLE,
  } as any
}

let seedCounter = 0
function nextOrgId(): string {
  // Deterministic-but-unique per seed call so parallel tests don't collide.
  seedCounter += 1
  const hex = seedCounter.toString(16).padStart(4, "0")
  return `00000000-0000-4000-9000-0000000c${hex}`
}
function userIdFor(orgId: string): string {
  return orgId.replace(/c[0-9a-f]{4}$/, (m) => `d${m.slice(1)}`)
}
function threadIdFor(orgId: string): string {
  return orgId.replace(/c[0-9a-f]{4}$/, (m) => `e${m.slice(1)}`)
}

// Scopes a `test`-app user needs to drive createItem (non-gated) + gatedEcho (gated).
const TEST_SCOPES = ["test:items:read", "test:items:write", "test:gated:write", "test:approve"]

export interface SeededOrg {
  orgId: string
  ownerId: string
  threadId: string
  scopes: string[]
}

/**
 * Seeds an org + owner with the built-in `test` manifest app registered. The
 * returned `scopes` cover the mutating non-gated tool (`test:createItem`) and
 * the gated tool (`test:gatedEcho`).
 */
export async function seedOrgWithTicketsApp(): Promise<SeededOrg> {
  const orgId = nextOrgId()
  const ownerId = userIdFor(orgId)
  const threadId = threadIdFor(orgId)

  await sql`INSERT INTO ${K()}.organizations (id, name, slug)
    VALUES (${orgId}, 'MCP Test Org', ${`mcp-test-${orgId.slice(-8)}`}) ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO ${K()}.users (id, org_id, email, password_hash, name, status)
    VALUES (${ownerId}, ${orgId}, ${`mcp-${orgId.slice(-8)}@test.com`}, 'hash', 'MCP Owner', 'active')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO ${K()}.threads (id, org_id, handle, type, created_by)
    VALUES (${threadId}, ${orgId}, ${`mcp-thr-${orgId.slice(-8)}`}, 'agent_chat', ${ownerId})
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO ${K()}.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${threadId}, ${ownerId}, ${orgId}, 'admin') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO ${K()}.user_thread_state (user_id, thread_id, org_id)
    VALUES (${ownerId}, ${threadId}, ${orgId}) ON CONFLICT DO NOTHING`
  for (const scope of TEST_SCOPES) {
    await sql`INSERT INTO ${K()}.user_scope_grants (user_id, org_id, scope)
      VALUES (${ownerId}, ${orgId}, ${scope}) ON CONFLICT DO NOTHING`
  }
  // The test app's `items` RLS insert policy is dimension-gated on test:team +
  // test:sensitivity. The decided gated path rebuilds the requester context
  // from DB perms (loadEffectivePermissions) — NOT the in-memory
  // userContextFor — so the grants must exist in user_dimension_grants for the
  // gated mutation to insert (mirrors userContextFor's "*" wildcard).
  for (const dim of ["test:team", "test:sensitivity"]) {
    await sql`INSERT INTO ${K()}.user_dimension_grants (user_id, org_id, dimension_key, dimension_values)
      VALUES (${ownerId}, ${orgId}, ${dim}, ${JSON.stringify(["*"])}::jsonb)
      ON CONFLICT DO NOTHING`
  }

  await registerApps([manifestWithBundle()], orgId)

  return { orgId, ownerId, threadId, scopes: [...TEST_SCOPES] }
}

/**
 * Like seedOrgWithTicketsApp but the owner CANNOT self-approve (no
 * `test:approve` scope). A separate approver user holds `test:approve`, so a
 * gated call auto-creates a thread distinct from the connection
 * thread — the non-self-approve path (spec C7 / review B2).
 */
export async function seedOrgWithSeparateApprover(): Promise<SeededOrg & { approverId: string }> {
  const orgId = nextOrgId()
  const ownerId = userIdFor(orgId)
  const threadId = threadIdFor(orgId)
  const approverId = orgId.replace(/c[0-9a-f]{4}$/, (m) => `b${m.slice(1)}`)

  await sql`INSERT INTO ${K()}.organizations (id, name, slug)
    VALUES (${orgId}, 'MCP Test Org', ${`mcp-test-${orgId.slice(-8)}`}) ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO ${K()}.users (id, org_id, email, password_hash, name, status)
    VALUES (${ownerId}, ${orgId}, ${`mcp-${orgId.slice(-8)}@test.com`}, 'hash', 'MCP Owner', 'active')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO ${K()}.users (id, org_id, email, password_hash, name, status)
    VALUES (${approverId}, ${orgId}, ${`mcp-appr-${orgId.slice(-8)}@test.com`}, 'hash', 'MCP Approver', 'active')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO ${K()}.threads (id, org_id, handle, type, created_by)
    VALUES (${threadId}, ${orgId}, ${`mcp-thr-${orgId.slice(-8)}`}, 'agent_chat', ${ownerId})
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO ${K()}.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${threadId}, ${ownerId}, ${orgId}, 'admin') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO ${K()}.user_thread_state (user_id, thread_id, org_id)
    VALUES (${ownerId}, ${threadId}, ${orgId}) ON CONFLICT DO NOTHING`
  // Owner: gated write but NOT approve. Approver: approve scope.
  const ownerScopes = ["test:items:read", "test:items:write", "test:gated:write"]
  for (const scope of ownerScopes) {
    await sql`INSERT INTO ${K()}.user_scope_grants (user_id, org_id, scope)
      VALUES (${ownerId}, ${orgId}, ${scope}) ON CONFLICT DO NOTHING`
  }
  await sql`INSERT INTO ${K()}.user_scope_grants (user_id, org_id, scope)
    VALUES (${approverId}, ${orgId}, 'test:approve') ON CONFLICT DO NOTHING`

  await registerApps([manifestWithBundle()], orgId)

  return { orgId, ownerId, threadId, scopes: [...ownerScopes], approverId }
}

/**
 * Lightweight org + user seed (no app registration). `scopes` is empty — the
 * connection service derives scopes via loadEffectivePermissions at mint time.
 */
export async function seedOrgWithUser(): Promise<{
  orgId: string
  userId: string
  scopes: string[]
}> {
  const orgId = nextOrgId()
  const userId = userIdFor(orgId)
  await sql`INSERT INTO ${K()}.organizations (id, name, slug)
    VALUES (${orgId}, 'MCP Conn Org', ${`mcp-conn-${orgId.slice(-8)}`}) ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO ${K()}.users (id, org_id, email, password_hash, name, status)
    VALUES (${userId}, ${orgId}, ${`mcp-conn-${orgId.slice(-8)}@test.com`}, 'hash', 'Conn User', 'active')
    ON CONFLICT (id) DO NOTHING`
  return { orgId, userId, scopes: [] }
}

/**
 * Creates an MCP connection and returns only the connection row (the common
 * test need). Tests that need the raw refresh secret call createMcpConnection
 * directly.
 */
export async function seedMcpConnection(input: {
  orgId: string
  userId: string
  clientId: string
  label: string
  /** Bind the connection to an agent (connection-service's own option). */
  agentId?: string
}): Promise<typeof import("~/db/schema/kernel").mcpConnections.$inferSelect> {
  const { connection } = await createMcpConnection(input)
  return connection
}

/** Owner-as-user UserContext, identical shape to the in-app agent's actor. */
export function userContextFor(orgId: string, userId: string, scopes: string[]): UserContext {
  return {
    actorType: "user",
    userId,
    orgId,
    scopes,
    // The test app's `items` RLS insert policy is dimension-gated on
    // test:team + test:sensitivity. Grant "*" so createItem inserts succeed
    // (the wiring under test is attribution, not dimension filtering).
    dimensionGrants: {
      "test:team": ["*"],
      "test:sensitivity": ["*"],
    },
  }
}

// The non-gated mutating tool: emits `items:created` through the RPC bridge.
export const mutatingTicketTool = {
  canonical: "test:createItem",
  sdkPrefix: "test__createItem",
  validParams: { title: "MCP item", team: "alpha" } as Record<string, unknown>,
}

// The gated tool used to exercise the gated executeToolCore path under origin.
export const gatedTicketTool = {
  canonical: "test:gatedEcho",
  validParams: { message: "mcp gated" } as Record<string, unknown>,
}

// A GATED tool that performs a real mutation (emits items:created through the
// RPC bridge) on decided execution — so the decided mutation produces an
// auditable row whose actorType can be hard-asserted (spec C7 / B4).
export const gatedMutatingTool = {
  canonical: "test:gatedCreateItem",
  validParams: { title: "MCP gated item", team: "alpha" } as Record<string, unknown>,
}

export interface SeededGatedApproval {
  orgId: string
  ownerId: string
  threadId: string
  approvalRequestId: string
  decider: UserContext
  expectedResult: unknown
}

/**
 * Seeds an org + the gated `test:gatedEcho` tool and creates an approval
 * request via the real executeTool path. When opts.decide is true the approval
 * is decided+executed (so runApprovedToolHandler persists the result), else it
 * is left pending. `expectedResult` is the deterministic gatedEcho output.
 */
export async function seedApprovedGatedRequest(
  opts: { decide?: boolean } = {},
): Promise<SeededGatedApproval> {
  const { orgId, ownerId, threadId, scopes } = await seedOrgWithTicketsApp()
  const actor = userContextFor(orgId, ownerId, scopes)
  const message = "decided-result-fixture"

  // Pass origin: "mcp" so the executeTool gate is NOT bypassed by the
  // direct-human-call shortcut (origin=undefined + actor user + approve scope
  // auto-executes — see execute-tool.ts:isDirectHumanCall). The MCP test
  // surface explicitly exercises the approval round-trip.
  const blocked = await executeTool({
    toolName: gatedTicketTool.canonical,
    orgId,
    actor,
    params: { message },
    threadId,
    origin: "mcp",
  })
  const approvalRequestId = blocked.blocked!.approvalRequestId!

  if (opts.decide !== false) {
    await decideApproval({ orgId, requestId: approvalRequestId, actor, decision: "approve" })
  }

  return {
    orgId,
    ownerId,
    threadId,
    approvalRequestId,
    decider: actor,
    expectedResult: { echoed: message },
  }
}

let agentCounter = 0

/**
 * Seeds a `role` agent row for an org. Slice 3's agent-bound MCP connection
 * tests need a real kernel.agents row (the composite (agent_id, org_id)
 * foreign key refuses anything else); no shared helper existed, every agent
 * suite inlined its own INSERT.
 */
export async function seedAgentForOrg(
  orgId: string,
  opts: {
    scopeCeiling?: string[]
    toolAllowlist?: string[] | null
    toolDenylist?: string[] | null
    archived?: boolean
  } = {},
): Promise<{ agentId: string; handle: string }> {
  agentCounter += 1
  const handle = `@mcp-agent-${orgId.slice(-8)}-${agentCounter}`
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO ${K()}.agents
      (org_id, kind, handle, display_name, scope_ceiling, tool_allowlist, tool_denylist, archived_at)
    VALUES (${orgId}, 'role', ${handle}, 'MCP Test Agent',
            ${JSON.stringify(opts.scopeCeiling ?? [])}::jsonb,
            ${opts.toolAllowlist ?? null},
            ${opts.toolDenylist ?? null},
            ${opts.archived ? new Date() : null})
    RETURNING id`
  return { agentId: row!.id, handle }
}

/** Grants a scope to a seeded user (the grantor side of an agent-bound mint). */
export async function grantScope(orgId: string, userId: string, scope: string) {
  await sql`INSERT INTO ${K()}.user_scope_grants (user_id, org_id, scope)
    VALUES (${userId}, ${orgId}, ${scope}) ON CONFLICT DO NOTHING`
}

/** Removes a scope grant from a seeded user (mid-TTL revocation fixtures). */
export async function revokeScope(orgId: string, userId: string, scope: string) {
  await sql`DELETE FROM ${K()}.user_scope_grants
    WHERE user_id = ${userId} AND org_id = ${orgId} AND scope = ${scope}`
}

/** Replaces a seeded agent's scope ceiling (live ceiling-change fixtures). */
export async function sqlUpdateCeiling(agentId: string, ceiling: string[]) {
  await sql`UPDATE ${K()}.agents SET scope_ceiling = ${JSON.stringify(ceiling)}::jsonb
    WHERE id = ${agentId}`
}

/** Archives a seeded agent (the "archived behaves like missing" fixtures). */
export async function archiveAgent(agentId: string) {
  await sql`UPDATE ${K()}.agents SET archived_at = now() WHERE id = ${agentId}`
}

/** Tears down everything seeded for an org (call in afterEach/afterAll). */
export async function cleanupSeededOrg(orgId: string) {
  await sql`DELETE FROM ${K()}.credit_transactions WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.credit_balances WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.approved_handler_executions WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.audit_log WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.pending_events WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.approval_requests WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.messages WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.thread_references WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.user_thread_state WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.thread_participants WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.threads WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.user_scope_grants WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.user_dimension_grants WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.mcp_connections WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.agents WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.users WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.apps WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.organizations WHERE id = ${orgId}`
}
