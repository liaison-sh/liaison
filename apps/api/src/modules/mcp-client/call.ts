// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Per-call orchestrator for MCP tool invocations.
 *
 * One call into `executeMcpCall(args)` does the spec's full per-call lifecycle:
 *   1. resolve the connection (orgId + disabled check) — short-circuit on missing/disabled
 *   2. resolve the policy decision (`auto` | `gate` | `deny`) via repo
 *   3. enforce managed-edition rate cap (skipped on self-hosted)
 *   4. refresh the OAuth token first when it expires within 60 s (S27)
 *   5. fetch a live transport from the pool (dial if absent, single-flighted);
 *      a 401 at dial refreshes once and redials
 *   6. invoke `client.callTool(serverToolName, args)` with one OAuth-401
 *      refresh-retry (the transport reads the refreshed token per request);
 *      a 403 insufficient_scope records the scope for the next sign-in
 *   7. cap the response size (no payload leak in audit on overflow)
 *   8. write the audit row with the full policy_path + outcome + byte counts
 *   9. update health (markConnected on success, markFailed/markNeedsReauth on errors)
 *
 * Only a refused refresh (invalid_grant, 400/401 from the token endpoint) or a
 * scope step-up means "sign in again"; a token endpoint that is down is a
 * transport error, retried on the next call.
 *
 * Concurrent disable mid-flight is INTENTIONALLY tolerated — the orchestrator
 * does NOT re-check `connection.disabled` between dial and response. The first
 * check at call entry is the single gate; if the connection is disabled while
 * the call is in flight, the call completes (or errors with transport_error if
 * the transport is torn down by `pool.drop`). Spec §7.
 */

import type { McpRepo, PolicyResolution } from "~/apps/mcp-manager/types"
import type { UserContext } from "~/db/rls"
import { rootLogger } from "~/lib/logger"
import type { HealthTracker } from "./health"
import { checkAndIncrement } from "./rate-cap"
import { McpAuthChallengeError } from "./transports/types"

const log = rootLogger.child({ module: "mcp-client/call" })

export interface LiveConnection {
  // Matches the MCP SDK `Client.callTool` signature shape — accepts a single
  // params object `{ name, arguments }` (per the JSON-RPC `tools/call` request).
  // The orchestrator wraps each call here, so the rest of the module continues
  // to deal in `(serverToolName, args)` pairs.
  client: {
    callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>
  }
  close: () => Promise<void>
}

export interface OrchestratorPool {
  get(connectionId: string): Promise<LiveConnection>
  drop(connectionId: string): Promise<void>
}

/**
 * Why a refresh failed. `invalid_grant` (a refused refresh token, or a 400/401
 * from the token endpoint), `config` (nothing to refresh with) and `not_oauth`
 * (a bearer connection was refused) mean "sign in again"; `transient` (network,
 * 5xx) does not.
 */
export type RefreshFailureKind = "invalid_grant" | "transient" | "config" | "not_oauth"

export type OAuthRefreshResult =
  | { ok: true }
  | { ok: false; kind: RefreshFailureKind; reason: string }

export interface AuditEventData {
  connection_id: string
  slug: string
  tool_name: string
  decision: PolicyResolution["decision"]
  policy_path: PolicyResolution["policyPath"]
  policy_role_id?: string
  outcome:
    | "ok"
    | "denied"
    | "rate_limited"
    | "transport_error"
    | "response_too_large"
    | "needs_reauth"
  reason?: string
  latency_ms: number
  request_bytes: number
  response_bytes?: number
}

export interface AuditEvent {
  app: "mcp"
  entity: "call"
  action: "execute"
  orgId: string
  actorId: string
  actorType: "user" | "agent"
  data: AuditEventData
}

export interface OrchestratorDeps {
  pool: OrchestratorPool
  repo: Pick<McpRepo, "getConnectionForCall" | "getPolicyForCall">
  health: Pick<HealthTracker, "markConnected" | "markDialFailed" | "markFailed" | "markNeedsReauth">
  audit: (event: AuditEvent) => Promise<void>
  /**
   * Refresh after a 401. `seenTokenFingerprint` names the refused token: when
   * the stored one already differs, another caller refreshed and it is adopted.
   */
  oauthRefresh: (
    connectionId: string,
    opts?: { seenTokenFingerprint?: string | null },
  ) => Promise<OAuthRefreshResult>
  /** Refresh BEFORE the call when the token expires within 60 s. */
  ensureFresh?: (connectionId: string) => Promise<OAuthRefreshResult>
  /** A 403 insufficient_scope: remember the scope the next sign-in must ask for. */
  recordScopeChallenge?: (connectionId: string, scope: string) => Promise<void>
}

export interface ExecuteMcpCallArgs {
  connectionId: string
  serverToolName: string
  args: unknown
  /** Optional — orchestrator falls back to a system actor when omitted. */
  actor?: UserContext
  /**
   * The call is the re-entry of an approval a human decided (executeTool's
   * static gate parked it). A `gate` decision then means "approved": it runs.
   * A `deny` decision still refuses it.
   */
  approved?: boolean
}

/** Structured error payload returned to callers when outcome is not `ok`. */
export type ExecuteMcpCallResult =
  | { ok: true; data: unknown }
  | {
      ok: false
      error: {
        code: "denied" | "rate_limited" | "transport_error" | "response_too_large" | "needs_reauth"
        reason?: string
        retryAfterMs?: number
        receivedBytes?: number
        limitBytes?: number
      }
    }

function byteLengthJson(v: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? "", "utf8")
  } catch {
    return 0
  }
}

function is401(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  if (err instanceof McpAuthChallengeError) return err.httpStatus === 401
  const e = err as {
    cause?: { httpStatus?: number }
    status?: number
    httpStatus?: number
    code?: unknown
    message?: string
  }
  if (e.cause?.httpStatus === 401) return true
  // The SDK's StreamableHTTPError carries the HTTP status as `code`.
  if (e.code === 401) return true
  if (e.status === 401) return true
  if (e.httpStatus === 401) return true
  // Tightened from `/\b401\b/` to avoid matching tool error messages like
  // "got 401 rows" / "limit 401" (review I18). We trust the structured fields
  // first; the message-scrape is the last resort and now requires an HTTP /
  // Unauthorized fingerprint adjacent to the 401.
  if (
    typeof e.message === "string" &&
    /\b(?:HTTP\s*)?401(?:\s+Unauthorized)?\b/i.test(e.message) &&
    /unauthor|HTTP\s*401|status\s*401/i.test(e.message)
  ) {
    return true
  }
  return false
}

function seenFingerprint(err: unknown): string | null | undefined {
  return err instanceof McpAuthChallengeError ? err.tokenFingerprint : undefined
}

/** The scope a 403 insufficient_scope asks for, or null for any other error. */
function stepUpScope(err: unknown): string | null {
  if (
    err instanceof McpAuthChallengeError &&
    err.httpStatus === 403 &&
    err.challenge.error === "insufficient_scope"
  ) {
    return err.challenge.scope ?? ""
  }
  return null
}

type RefreshFailure = Extract<OAuthRefreshResult, { ok: false }>

type CallOutcome =
  | { response: unknown; retried: boolean }
  | { refreshFailed: RefreshFailure }
  | { stepUp: string }

export function makeOrchestrator(deps: OrchestratorDeps) {
  async function callWith401Refresh(
    live: LiveConnection,
    serverToolName: string,
    args: unknown,
    connectionId: string,
  ): Promise<CallOutcome> {
    const invoke = () =>
      live.client.callTool({
        name: serverToolName,
        arguments: args as Record<string, unknown> | undefined,
      })
    try {
      return { response: await invoke(), retried: false }
    } catch (err) {
      const scope = stepUpScope(err)
      if (scope !== null) return { stepUp: scope }
      if (!is401(err)) throw err
      const refresh = await deps.oauthRefresh(connectionId, {
        seenTokenFingerprint: seenFingerprint(err),
      })
      if (!refresh.ok) return { refreshFailed: refresh }
      // Retry exactly once: the transport reads the refreshed token per request.
      try {
        return { response: await invoke(), retried: true }
      } catch (retryErr) {
        const retryScope = stepUpScope(retryErr)
        if (retryScope !== null) return { stepUp: retryScope }
        if (is401(retryErr)) {
          return {
            refreshFailed: {
              ok: false,
              kind: "invalid_grant",
              reason: "the refreshed token was refused too",
            },
          }
        }
        throw retryErr
      }
    }
  }

  return {
    async executeMcpCall(input: ExecuteMcpCallArgs): Promise<ExecuteMcpCallResult> {
      const start = Date.now()
      const reqBytes = byteLengthJson(input.args)
      // System fallback when the projected tool's handler is invoked without
      // an actor (boot-time tool registration; future agent dispatch will
      // decorate `params` with `__actor`).
      const actor: UserContext =
        input.actor ??
        ({
          actorType: "user",
          userId: "00000000-0000-0000-0000-000000000000",
          orgId: "00000000-0000-0000-0000-000000000000",
          scopes: [],
          dimensionGrants: {},
        } as const)

      const writeAudit = async (
        data: Omit<AuditEventData, "latency_ms" | "request_bytes"> &
          Partial<Pick<AuditEventData, "latency_ms" | "request_bytes">>,
        orgId: string,
      ): Promise<void> => {
        try {
          await deps.audit({
            app: "mcp",
            entity: "call",
            action: "execute",
            orgId,
            actorId: actor.userId,
            actorType: "user",
            data: {
              latency_ms: Date.now() - start,
              request_bytes: reqBytes,
              ...data,
            } as AuditEventData,
          })
        } catch (err) {
          log.error({ err, connectionId: input.connectionId }, "audit write failed")
        }
      }

      const conn = await deps.repo.getConnectionForCall(input.connectionId, actor)
      if (!conn) {
        await writeAudit(
          {
            connection_id: input.connectionId,
            slug: "unknown",
            tool_name: input.serverToolName,
            decision: "deny",
            policy_path: "connection_default",
            outcome: "denied",
            reason: "connection_not_found",
          },
          actor.orgId,
        )
        return { ok: false, error: { code: "denied", reason: "connection_not_found" } }
      }

      const fqToolName = `${conn.slug}:${input.serverToolName}`

      if (conn.disabled) {
        await writeAudit(
          {
            connection_id: conn.id,
            slug: conn.slug,
            tool_name: fqToolName,
            decision: "deny",
            policy_path: "connection_default",
            outcome: "denied",
            reason: "connection_disabled",
          },
          conn.orgId,
        )
        return { ok: false, error: { code: "denied", reason: "connection_disabled" } }
      }

      const policy = await deps.repo.getPolicyForCall(
        input.connectionId,
        input.serverToolName,
        actor,
      )

      if (policy.decision === "deny") {
        await writeAudit(
          {
            connection_id: conn.id,
            slug: conn.slug,
            tool_name: fqToolName,
            decision: "deny",
            policy_path: policy.policyPath,
            policy_role_id: policy.policyRoleId,
            outcome: "denied",
            reason: "policy_deny",
          },
          conn.orgId,
        )
        return { ok: false, error: { code: "denied", reason: "policy_deny" } }
      }

      // policy.decision === "gate" returns a structured "needs approval" payload
      // — the actual approval-envelope wrapping happens at the executeTool
      // boundary (Task 23/25). For audit purposes we record "denied/gate_pending"
      // so the dashboard can distinguish "blocked by policy" from "blocked by gate".
      // Caller (executeTool) interprets `code: "denied", reason: "gate_required"` and
      // converts to the standard `BlockedEnvelope` shape.
      if (policy.decision === "gate" && input.approved !== true) {
        await writeAudit(
          {
            connection_id: conn.id,
            slug: conn.slug,
            tool_name: fqToolName,
            decision: "gate",
            policy_path: policy.policyPath,
            policy_role_id: policy.policyRoleId,
            outcome: "denied",
            reason: "gate_required",
          },
          conn.orgId,
        )
        return { ok: false, error: { code: "denied", reason: "gate_required" } }
      }

      const cap =
        conn.rateCapPerMinute ?? Number(process.env.MCP_RATE_CAP_PER_MINUTE_DEFAULT ?? 120)
      const ratecap = await checkAndIncrement(input.connectionId, cap)
      if (!ratecap.allowed) {
        await writeAudit(
          {
            connection_id: conn.id,
            slug: conn.slug,
            tool_name: fqToolName,
            decision: policy.decision,
            policy_path: policy.policyPath,
            policy_role_id: policy.policyRoleId,
            outcome: "rate_limited",
          },
          conn.orgId,
        )
        return { ok: false, error: { code: "rate_limited", retryAfterMs: ratecap.retryAfterMs } }
      }

      const policyFields = {
        connection_id: conn.id,
        slug: conn.slug,
        tool_name: fqToolName,
        decision: policy.decision,
        policy_path: policy.policyPath,
        policy_role_id: policy.policyRoleId,
      }

      /** "Sign in again": a refused refresh, or a scope the token lacks. */
      const needsReauth = async (
        healthReason: string,
        auditReason = "needs_reauth",
      ): Promise<ExecuteMcpCallResult> => {
        await deps.health.markNeedsReauth(input.connectionId, healthReason)
        await writeAudit({ ...policyFields, outcome: "denied", reason: auditReason }, conn.orgId)
        return { ok: false, error: { code: "denied", reason: "needs_reauth" } }
      }
      const refreshUnavailable = async (failure: RefreshFailure): Promise<ExecuteMcpCallResult> => {
        const reason = `token refresh unavailable: ${failure.reason}`
        await writeAudit({ ...policyFields, outcome: "transport_error", reason }, conn.orgId)
        return { ok: false, error: { code: "transport_error", reason } }
      }
      const onRefreshFailure = (failure: RefreshFailure) =>
        failure.kind === "transient" ? refreshUnavailable(failure) : needsReauth(failure.reason)
      const onStepUp = async (scope: string) => {
        if (scope) await deps.recordScopeChallenge?.(input.connectionId, scope)
        return needsReauth("insufficient_scope", "insufficient_scope")
      }

      // S27: a token that expires within 60 s is refreshed before the call. A
      // token endpoint that is down does not stop the call: the current token
      // may still be good, and a 401 retries the refresh.
      if (deps.ensureFresh) {
        const fresh = await deps.ensureFresh(input.connectionId)
        if (!fresh.ok && fresh.kind !== "transient") return needsReauth(fresh.reason)
      }

      const dialFailed = async (err: unknown): Promise<ExecuteMcpCallResult> => {
        await deps.health.markDialFailed(input.connectionId, err as Error)
        await writeAudit(
          { ...policyFields, outcome: "transport_error", reason: (err as Error).message },
          conn.orgId,
        )
        return { ok: false, error: { code: "transport_error", reason: (err as Error).message } }
      }

      let live: LiveConnection
      try {
        live = await deps.pool.get(input.connectionId)
      } catch (err) {
        const scope = stepUpScope(err)
        if (scope !== null) return onStepUp(scope)
        if (!is401(err)) return dialFailed(err)
        // The handshake was refused: refresh once and dial again.
        const refresh = await deps.oauthRefresh(input.connectionId, {
          seenTokenFingerprint: seenFingerprint(err),
        })
        if (!refresh.ok) return onRefreshFailure(refresh)
        try {
          live = await deps.pool.get(input.connectionId)
        } catch (redialErr) {
          if (is401(redialErr)) return needsReauth("the refreshed token was refused too")
          return dialFailed(redialErr)
        }
      }

      let callResult: CallOutcome
      try {
        callResult = await callWith401Refresh(
          live,
          input.serverToolName,
          input.args,
          input.connectionId,
        )
      } catch (err) {
        await deps.pool.drop(input.connectionId)
        await deps.health.markFailed(input.connectionId, err as Error)
        await writeAudit(
          {
            connection_id: conn.id,
            slug: conn.slug,
            tool_name: fqToolName,
            decision: policy.decision,
            policy_path: policy.policyPath,
            policy_role_id: policy.policyRoleId,
            outcome: "transport_error",
            reason: (err as Error).message,
          },
          conn.orgId,
        )
        return { ok: false, error: { code: "transport_error", reason: (err as Error).message } }
      }

      if ("stepUp" in callResult) return onStepUp(callResult.stepUp)
      if ("refreshFailed" in callResult) return onRefreshFailure(callResult.refreshFailed)

      const resBytes = byteLengthJson(callResult.response)
      const limit = Number(process.env.MCP_MAX_RESPONSE_BYTES ?? 4_194_304)
      if (resBytes > limit) {
        await writeAudit(
          {
            connection_id: conn.id,
            slug: conn.slug,
            tool_name: fqToolName,
            decision: policy.decision,
            policy_path: policy.policyPath,
            policy_role_id: policy.policyRoleId,
            outcome: "response_too_large",
            // Do NOT include the response payload in the audit row — defeats the
            // memory-protection purpose of the cap.
            response_bytes: resBytes,
          },
          conn.orgId,
        )
        return {
          ok: false,
          error: { code: "response_too_large", receivedBytes: resBytes, limitBytes: limit },
        }
      }

      await deps.health.markConnected(input.connectionId)
      await writeAudit(
        {
          connection_id: conn.id,
          slug: conn.slug,
          tool_name: fqToolName,
          decision: policy.decision,
          policy_path: policy.policyPath,
          policy_role_id: policy.policyRoleId,
          outcome: "ok",
          response_bytes: resBytes,
        },
        conn.orgId,
      )
      return { ok: true, data: callResult.response }
    },
  }
}
