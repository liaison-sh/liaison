// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Kernel mount + boot ordering for the inbound MCP client.
//
// `initMcpClient` is called once at API boot (after Phase 10) and:
//   1. Resolves the `mcp-manager` app's repo via dynamic import — if the app
//      isn't installed, logs WARN and returns (MCP client disabled).
//   2. Runs env-bootstrap (LIAISON_MCP_<SLUG>_* env vars → DB rows).
//   3. Builds the engine: HealthTracker, credential store, token refresher,
//      ConnectionPool, orchestrator, projector.
//   4. Hydrates the slug-index from every persisted connection and projects
//      each enabled connection's tools from the last tools/list a dial stored
//      (mcp_connection_health.tool_list), without dialing. A connection never
//      listed gets only the synthetic tools of its cached capabilities until
//      its first dial.
//   5. Starts the pool's idle-reap timer.
//
// A pooled transport reads its credentials from the engine's store on every
// request, so a token refreshed after the dial (proactively, or after a 401) is
// what the next request carries.
//
// Subscribers (resource:updated) are registered separately in
// `event-subscribers.ts` (Task 33 wiring step).

import { eq } from "drizzle-orm"
import type { ConnectionRow, McpRepo } from "~/apps/mcp-manager/types"
import { withSystemDb } from "~/db/privileged"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { _publishEventInternal } from "~/infra/events/event-bus"
import { registerSingleton } from "~/infra/leadership"
import { rootLogger } from "~/lib/logger"
import { captureActingAgentId } from "~/modules/agent/runtime/run-context"
import { type AuditEvent, makeOrchestrator, type OAuthRefreshResult } from "./call"
import { CredentialStore, needsProactiveRefresh } from "./credentials"
import { runEnvBootstrap } from "./env-bootstrapper"
import { type HealthStatus, HealthTracker } from "./health"
import { _resetHealthGate, getHealthGate } from "./health-gate"
import { makeTokenRefresher } from "./oauth-tokens"
import { ConnectionPool } from "./pool"
import { type ProjectedToolInput, ToolProjector } from "./projector"
import { metadataOf } from "./secrets"
import { slugIndex } from "./slug-index"
import { SyntheticToolRegistrar } from "./synthetic-tools"
import { dialHttp } from "./transports/http"
import { dialSse } from "./transports/sse"
import {
  type DialCredentials,
  type LiveConnection,
  McpAuthChallengeError,
  UnauthorizedError,
} from "./transports/types"

const log = rootLogger.child({ module: "mcp-client/init" })

/**
 * Shape persisted on `mcp_connections.oauth_metadata.serverCapabilities`. The
 * MCP SDK's capability object is open-ended; we only care about presence of
 * `resources` / `prompts` / `tools` for boot-time synthetic registration.
 */
type PersistedCapabilities = {
  resources?: unknown
  prompts?: unknown
  tools?: unknown
}

interface InitOptions {
  envOverrides?: NodeJS.ProcessEnv
  /** Skips the env-bootstrap step — used by tests that pre-seed connections. */
  skipEnvBootstrap?: boolean
  /** Skips the pool reap timer (test seam — Bun's timers leak into other tests). */
  skipReapTimer?: boolean
}

/** A live transport in the pool, keyed by connection id. */
type PoolEntry = LiveConnection & { id: string }

/** Everything one process needs to call MCP servers. */
interface McpClientEngine {
  pool: ConnectionPool<PoolEntry>
  credentials: CredentialStore
  orchestrator: ReturnType<typeof makeOrchestrator>
  /** Refresh first when the token expires within 60 s. */
  ensureFresh(connectionId: string): Promise<OAuthRefreshResult>
  refresh(connectionId: string, seenTokenFingerprint?: string | null): Promise<OAuthRefreshResult>
}

let _state: {
  engine?: McpClientEngine
  health?: HealthTracker
  projector?: ToolProjector
  repo?: McpRepo
} = {}

/**
 * A 403 insufficient_scope: the next sign-in asks for the scopes already held
 * plus the ones the server asked for (the union, per the spec's step-up).
 */
async function recordScopeChallenge(connectionId: string, scope: string): Promise<void> {
  await withSystemDb("mcp-oauth-step-up", async (db) => {
    const [row] = await db
      .select({ oauthMetadata: mcpConnections.oauthMetadata })
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId))
    if (!row) return
    const meta = metadataOf(row.oauthMetadata)
    const union = [
      ...new Set(
        [meta.scope, meta.requiredScope, scope]
          .flatMap((v) => (v ?? "").split(/\s+/))
          .filter(Boolean),
      ),
    ].join(" ")
    await db
      .update(mcpConnections)
      .set({ oauthMetadata: { ...meta, requiredScope: union }, updatedAt: new Date() })
      .where(eq(mcpConnections.id, connectionId))
  })
}

function buildEngine(deps: {
  repo: McpRepo
  health: HealthTracker
  projector: () => ToolProjector | null
}): McpClientEngine {
  const { repo, health } = deps
  const credentials = new CredentialStore((id) => repo.getConnectionForCallPrivileged(id))
  const refresher = makeTokenRefresher({ onRefreshed: (row) => credentials.setFromRow(row) })

  const pool = new ConnectionPool<PoolEntry>({
    dial: async (connectionId): Promise<PoolEntry> => {
      const conn = await repo.getConnectionForCallPrivileged(connectionId)
      if (!conn) throw new Error(`connection ${connectionId} not found`)
      credentials.setFromRow(conn)
      const supplier = async (): Promise<DialCredentials> => {
        const c = await credentials.get(connectionId)
        return { authorization: c.authorization, headers: c.headers }
      }

      let live: LiveConnection
      if (conn.transport === "http") {
        if (!conn.httpUrl) throw new Error(`connection ${connectionId} missing httpUrl`)
        live = await dialHttp({ url: conn.httpUrl, bearerToken: null, credentials: supplier })
      } else if (conn.transport === "sse") {
        if (!conn.httpUrl) throw new Error(`connection ${connectionId} missing httpUrl`)
        live = await dialSse({ url: conn.httpUrl, bearerToken: null, credentials: supplier })
      } else {
        throw new Error(`unknown transport ${conn.transport} for connection ${connectionId}`)
      }

      // Post-handshake: list tools + register synthetics in a single projector
      // call so the synthetic + projected sets coexist without retire-on-rewrite
      // wiping either side (see synthetic-tools concat semantics).
      const projector = deps.projector()
      if (projector) {
        try {
          await projectAndRegisterTools(live, conn, repo, projector)
        } catch (err) {
          log.warn({ err, connectionId }, "post-handshake tool projection failed")
        }
      }

      return Object.assign(live, { id: connectionId })
    },
    idleMs: 5 * 60_000,
    clock: Date.now,
    // A refused credential is fixed by a refresh, not by dialing again.
    retryable: (err) => !(err instanceof UnauthorizedError),
  })

  const refresh = (connectionId: string, seen?: string | null) =>
    refresher.refresh(connectionId, { seenTokenFingerprint: seen })
  const ensureFresh = async (connectionId: string): Promise<OAuthRefreshResult> => {
    let creds: Awaited<ReturnType<CredentialStore["get"]>>
    try {
      creds = await credentials.get(connectionId)
    } catch {
      // The dial reports a missing connection; nothing to refresh here.
      return { ok: true }
    }
    if (!needsProactiveRefresh(creds)) return { ok: true }
    return refresh(connectionId, creds.tokenFingerprint)
  }

  const orchestrator = makeOrchestrator({
    pool,
    repo,
    health,
    audit: emitAuditEvent,
    oauthRefresh: (connectionId, o) => refresh(connectionId, o?.seenTokenFingerprint),
    ensureFresh,
    recordScopeChallenge,
  })
  return { pool, credentials, orchestrator, ensureFresh, refresh }
}

/**
 * Accessor for the live connection pool — exposed so the manager-app `test`
 * endpoint can reuse the same dial/projection machinery as production calls
 * instead of duplicating transport selection (review I23). Returns `null` when
 * the MCP client has not yet booted (manager app missing, or pre-init).
 */
export function getMcpPool(): ConnectionPool<PoolEntry> | null {
  return _state.engine?.pool ?? null
}

/**
 * Accessor for the live tool projector — exposed so the manager-app `test`
 * endpoint can read already-projected tool names from the in-process registry
 * instead of re-issuing `tools/list` against the upstream (which has already
 * been called during the dial's post-handshake projection step). Eliminates a
 * second JSON-RPC round-trip on every test click.
 */
export function getMcpProjector(): ToolProjector | null {
  return _state.projector ?? null
}

/**
 * A connection's credentials changed outside the call path (a sign-in, a
 * secret edit): drop the live transport and the cached credentials so the next
 * call dials with the new ones, and mirror the health status into the gate.
 */
export async function invalidateMcpConnection(
  connectionId: string,
  opts: { healthStatus?: HealthStatus } = {},
): Promise<void> {
  _state.engine?.credentials.invalidate(connectionId)
  await _state.engine?.pool.drop(connectionId)
  if (opts.healthStatus) {
    _state.health?.forget(connectionId)
    getHealthGate().setHealthStatus(connectionId, opts.healthStatus)
  }
}

/**
 * The admin changed a connection's default policy: re-apply it to the tools this
 * process holds for it, so the static `gated` flag agrees with the per-call
 * decision at once. Other processes pick it up at their next dial of the server.
 */
export function regateMcpConnection(opts: {
  orgId: string
  slug: string
  connectionDefaultPolicy: "auto" | "gate_writes" | "gate_all"
}): void {
  _state.projector?.regateSlug(opts.orgId, opts.slug, opts.connectionDefaultPolicy)
}

/**
 * A connection was deleted: take everything this process holds for it out of
 * service, so the agent stops being offered its tools at once (not at the next
 * restart). Retires every projected and synthetic tool registered under the
 * slug, forgets the slug mapping, the health and disabled state, the cached
 * credentials, and closes the pooled client session.
 *
 * Idempotent, and safe on a process that never dialed the connection. Runs in
 * the process that served the DELETE and, through the
 * `mcp_manager:connection:deleted` event, in every peer process. When the slug
 * already maps to ANOTHER connection (the slug was reused and the new one
 * dialed here before this event arrived), the slug's tools belong to that new
 * connection and are left alone.
 */
export async function retireMcpConnection(opts: {
  orgId: string
  connectionId: string
  slug: string
}): Promise<void> {
  const mapped = slugIndex.get(opts.orgId, opts.slug)
  if (mapped === undefined || mapped === opts.connectionId) {
    _state.projector?.retireSlug(opts.orgId, opts.slug)
    slugIndex.delete(opts.orgId, opts.slug)
  }
  getHealthGate().setDisabled(opts.connectionId, false)
  _state.health?.forget(opts.connectionId)
  _state.engine?.credentials.invalidate(opts.connectionId)
  await _state.engine?.pool.drop(opts.connectionId)
}

/**
 * Peer-process side of the manager routes: every process holds its own tool
 * registry, slug index, health gate and pool, so a connection event must be
 * applied by each of them, not only by the one that served the request.
 * Wired as a global event handler (event-subscribers.ts); events from this
 * process re-apply idempotently.
 */
export async function applyMcpConnectionEvent(event: {
  app: string
  entity: string
  action: string
  entityId?: string | null
  orgId?: string | null
  data?: unknown
}): Promise<void> {
  if (event.app !== "mcp_manager" || event.entity !== "connection") return
  const connectionId = event.entityId
  if (!connectionId) return
  // The leader's env bootstrap wrote an env-managed connection: an org this
  // process already projected projects again from its rows (idempotent); one it
  // has not touched yet projects at its first touch anyway.
  if ((event.data as { envSynced?: unknown } | undefined)?.envSynced === true) {
    if (event.orgId && projectedMcpOrgs.has(event.orgId)) await ensureMcpOrg(event.orgId)
    return
  }
  if (event.action === "deleted") {
    const slug = (event.data as { slug?: unknown } | undefined)?.slug
    if (!event.orgId || typeof slug !== "string") return
    await retireMcpConnection({ orgId: event.orgId, connectionId, slug })
  } else if (event.action === "updated") {
    // A default policy change re-gates the slug's projected tools in every
    // process, not only the one that served the PATCH.
    const data = (event.data ?? {}) as { slug?: unknown; connectionDefaultPolicy?: unknown }
    const policy = data.connectionDefaultPolicy
    if (
      event.orgId &&
      typeof data.slug === "string" &&
      (policy === "auto" || policy === "gate_writes" || policy === "gate_all")
    ) {
      // A slug that maps to another connection (reused after a delete) is not this one's.
      const mapped = slugIndex.get(event.orgId, data.slug)
      if (mapped === undefined || mapped === connectionId) {
        regateMcpConnection({
          orgId: event.orgId,
          slug: data.slug,
          connectionDefaultPolicy: policy,
        })
      }
    }
  } else if (event.action === "disabled") {
    getHealthGate().setDisabled(connectionId, true)
  } else if (event.action === "enabled") {
    getHealthGate().setDisabled(connectionId, false)
  }
}

export type McpConnectionTestResult =
  | { ok: true }
  | { ok: false; needsReauth: boolean; message: string }

/**
 * The manager's "Test connection": a fresh dial with the current credentials,
 * through the same refresh path a call takes (proactive, then once on a 401),
 * recording health. A refused refresh is "Sign in again", not a failure.
 */
export async function testMcpConnection(connectionId: string): Promise<McpConnectionTestResult> {
  const engine = _state.engine
  const health = _state.health
  if (!engine || !health)
    return { ok: false, needsReauth: false, message: "MCP client not initialised" }
  await engine.pool.drop(connectionId)
  engine.credentials.invalidate(connectionId)

  const reauth = async (reason: string): Promise<McpConnectionTestResult> => {
    await health.markNeedsReauth(connectionId, reason)
    return { ok: false, needsReauth: true, message: reason }
  }
  const fresh = await engine.ensureFresh(connectionId)
  if (!fresh.ok && fresh.kind !== "transient") return reauth(fresh.reason)

  const dial = async () => {
    // Interactive: fail fast, no backoff ramp.
    await engine.pool.get(connectionId, { backoff: false })
    await health.markConnected(connectionId)
    return { ok: true } as const
  }
  try {
    return await dial()
  } catch (err) {
    if (err instanceof UnauthorizedError && err.httpStatus === 401) {
      const refreshed = await engine.refresh(
        connectionId,
        err instanceof McpAuthChallengeError ? err.tokenFingerprint : undefined,
      )
      if (!refreshed.ok) {
        if (refreshed.kind !== "transient") return reauth(refreshed.reason)
        await health.markFailed(connectionId, new Error(refreshed.reason))
        return { ok: false, needsReauth: false, message: refreshed.reason }
      }
      try {
        return await dial()
      } catch (again) {
        if (again instanceof UnauthorizedError && again.httpStatus === 401) {
          return reauth("the refreshed token was refused too")
        }
        await health.markFailed(connectionId, again as Error)
        return { ok: false, needsReauth: false, message: (again as Error).message }
      }
    }
    await engine.pool.drop(connectionId).catch(() => {})
    await health.markFailed(connectionId, err as Error)
    return { ok: false, needsReauth: false, message: (err as Error).message }
  }
}

export async function initMcpClient(opts: InitOptions = {}): Promise<void> {
  // 1. Try to load the manager-app repo. If the app isn't installed, disable.
  let repo: McpRepo
  try {
    const mod = await import("~/apps/mcp-manager/repo")
    repo = mod.makeMcpRepo()
  } catch (err) {
    log.warn({ err: (err as Error).message }, "mcp-manager app not installed — MCP client disabled")
    return
  }

  // 2. Env bootstrap: the leader's (M5), on lease acquire, never on the boot
  // path. `LIAISON_MCP_*` is application env every role carries; one leader at
  // a time converges the rows, each upsert race-safe on (org_id, slug). A
  // failure is an alert, not an exit: env-managed connections keep their rows.
  if (!opts.skipEnvBootstrap) registerMcpEnvBootstrapSingleton(opts.envOverrides)

  // 3. Construct the engine pieces. The projector is built after the engine
  // (its tool handlers call the orchestrator); the dial reads it lazily.
  const health = new HealthTracker(repo)
  let projectorRef: ToolProjector | null = null
  const engine = buildEngine({ repo, health, projector: () => projectorRef })
  const { orchestrator, pool } = engine
  const projector = new ToolProjector({
    executeMcpCall: async (args) => {
      const result = await orchestrator.executeMcpCall({
        connectionId: args.connectionId,
        serverToolName: args.serverToolName,
        args: args.args,
        actor:
          args.actor ??
          ({
            actorType: "user",
            userId: "00000000-0000-0000-0000-000000000000",
            orgId: "00000000-0000-0000-0000-000000000000",
            scopes: [],
            dimensionGrants: {},
          } as const),
        ...(args.approved === true ? { approved: true } : {}),
      })
      return result
    },
    // Persist MCP resource subscriptions on successful resource_subscribe/unsubscribe
    // so notifications/resources/updated events have recipients (otherwise dropped).
    repo,
  })
  projectorRef = projector

  // 4. No connection rows at boot: each org's connections are projected at its
  // first touch in this process (`ensureMcpOrg`, from the org's setup).
  unlistedByOrg.clear()
  backfillByOrg.clear()
  projectedMcpOrgs.clear()

  // 5. Pool reap timer (unref'd in the pool itself).
  if (!opts.skipReapTimer) pool.startReapTimer(60_000)

  _state = { engine, health, projector, repo }
  log.info("MCP client initialized")
}

let envBootstrapRegistered = false

function registerMcpEnvBootstrapSingleton(envOverrides: NodeJS.ProcessEnv | undefined): void {
  if (envBootstrapRegistered) return
  envBootstrapRegistered = true
  registerSingleton({
    name: "mcp-env-bootstrap",
    onAcquired: () => {
      void runEnvBootstrap(envOverrides ?? process.env).catch((err: unknown) =>
        log.error({ err, alert: "mcp_env_bootstrap_failed" }, "MCP env bootstrap failed"),
      )
    },
    onLost: () => {},
  })
}

/**
 * Project one org's MCP connections in this process (its first touch, from the
 * org's setup): hydrate the slug index and register each enabled connection's
 * tools from the last tools/list a dial persisted, without dialing anything. A
 * connection never listed falls back to the synthetic tools of its cached
 * capabilities and joins the org's lazy backfill (`ensureOrgToolLists`).
 * Re-projecting is idempotent (the projector retires on rewrite). A no-op while
 * the MCP client is not initialized.
 */
export async function ensureMcpOrg(orgId: string): Promise<void> {
  const { repo, projector } = _state
  if (!repo || !projector) return
  projectedMcpOrgs.add(orgId)
  const rows = await repo.listForOrgBootstrap(orgId)
  const toolLists = await repo.listToolLists(rows.map((r) => r.id))
  const unlisted: string[] = []
  for (const r of rows) {
    slugIndex.set(r.orgId, r.slug, r.id)
    const listed = toolLists.get(r.id)
    if (listed) {
      try {
        // The annotations were cached when the list was stored (`saveToolList`).
        await projector.registerTools({
          orgId: r.orgId,
          connectionId: r.id,
          slug: r.slug,
          displayName: r.displayName,
          ownerUserId: r.ownerUserId ?? null,
          exposeViaGateway: r.exposeViaGateway,
          connectionDefaultPolicy: r.connectionDefaultPolicy,
          tools: listed,
        })
      } catch (err) {
        // One bad stored list never stops the setup: that connection's tools wait for a dial.
        log.warn({ err, connectionId: r.id }, "projecting the stored tool list failed")
      }
      continue
    }
    // Never listed since the list was stored: its tools come from one dial, made
    // the first time the org needs its catalogue (`ensureOrgToolLists`).
    unlisted.push(r.id)
    const caps: PersistedCapabilities | undefined = metadataOf(r.oauthMetadata).serverCapabilities
    if (caps) {
      const synth = new SyntheticToolRegistrar({ projector, repo })
      await synth.registerForCapabilities({
        orgId: r.orgId,
        connectionId: r.id,
        slug: r.slug,
        capabilities: {
          resources: caps.resources !== undefined && caps.resources !== false,
          prompts: caps.prompts !== undefined && caps.prompts !== false,
          tools: caps.tools !== undefined && caps.tools !== false,
        },
      })
    }
  }
  if (unlisted.length > 0 && !backfillByOrg.has(orgId)) unlistedByOrg.set(orgId, unlisted)
}

/** Orgs whose connections this process projected (`ensureMcpOrg`). */
const projectedMcpOrgs = new Set<string>()

/** Enabled connections with no stored tools/list at the org's setup, not yet dialed for it. */
const unlistedByOrg = new Map<string, string[]>()
/** The one backfill run per org (dials its unlisted connections one at a time). */
const backfillByOrg = new Map<string, Promise<void>>()

/** How long a caller waits for an org's backfill before answering with what it has. */
const BACKFILL_WAIT_MS = Number(process.env.MCP_TOOL_LIST_BACKFILL_WAIT_MS ?? 4000)

/**
 * The first time an org needs its MCP tool catalogue in this process (tool_search, the
 * server page), dial each of its enabled connections that had no stored tools/list at boot,
 * one at a time, so their tools are projected and the list is stored for the next boot.
 * Lazy and per org rather than a boot sweep: a restart contacts no server, and only orgs in
 * use dial, one connection after another. The caller waits up to `waitMs` so the first
 * search can already find the tools; the dials continue in the background past that. A
 * failed dial records health as any dial does and blocks nothing; it is not retried here
 * (the next call or test of the connection dials it again).
 */
export async function ensureOrgToolLists(
  orgId: string,
  opts: { waitMs?: number } = {},
): Promise<void> {
  let run = backfillByOrg.get(orgId)
  if (!run) {
    const pending = unlistedByOrg.get(orgId)
    if (!pending || pending.length === 0) return
    unlistedByOrg.delete(orgId)
    run = backfillOrg(orgId, pending)
    backfillByOrg.set(orgId, run)
  }
  const waitMs = opts.waitMs ?? BACKFILL_WAIT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    run,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs)
    }),
  ])
  if (timer) clearTimeout(timer)
}

async function backfillOrg(orgId: string, connectionIds: string[]): Promise<void> {
  for (const connectionId of connectionIds) {
    try {
      const result = await testMcpConnection(connectionId)
      if (!result.ok) {
        log.warn(
          { orgId, connectionId, needsReauth: result.needsReauth, reason: result.message },
          "mcp tool list backfill: dial failed",
        )
      }
    } catch (err) {
      log.warn({ err, orgId, connectionId }, "mcp tool list backfill: dial threw")
    }
  }
}

export async function emitAuditEvent(event: AuditEvent): Promise<void> {
  // Bypass the outbox for now: audit events publish directly through the event
  // bus, where the kernel audit subscriber persists them into `kernel.audit_log`.
  // (Going through the outbox would require a privileged tx per call — defer to
  // Task 33's wiring which can batch.)
  try {
    await _publishEventInternal({
      app: event.app,
      entity: event.entity,
      action: event.action,
      entityId: event.data.connection_id,
      orgId: event.orgId,
      actorId: event.actorId,
      actorType: event.actorType,
      // S13: the in-sandbox and MCP-originated rows for one request must read
      // identically under a search by agent id. The call is executed inside the
      // turn's ALS frame (tool-bridge wraps every tool execution in it), so the
      // acting agent is readable right here and rides the envelope as every
      // other agent-turn event does. Outside a turn there is no agent, which is
      // the true answer for a boot-time or gateway call.
      agentId: captureActingAgentId(),
      data: event.data as unknown as Record<string, unknown>,
    })
  } catch (err) {
    log.error({ err }, "MCP audit publish failed")
  }
}

/**
 * Post-handshake: fetch the upstream tool list + cache server capabilities,
 * then concat synthetic + projected tools in a single registry write so the
 * projector's retire-on-rewrite semantic keeps both in sync (review B9).
 */
async function projectAndRegisterTools(
  live: { client: { listTools: () => Promise<unknown>; getServerCapabilities?: () => unknown } },
  conn: ConnectionRow,
  repo: McpRepo,
  projector: ToolProjector,
): Promise<void> {
  // 1. Fetch tools/list from the upstream.
  const toolsRes = (await live.client.listTools()) as {
    tools?: Array<{
      name: string
      description?: string
      inputSchema?: Record<string, unknown>
      outputSchema?: Record<string, unknown>
      annotations?: {
        readOnlyHint?: boolean
        destructiveHint?: boolean
        idempotentHint?: boolean
        openWorldHint?: boolean
      }
    }>
  }
  const upstreamTools: ProjectedToolInput[] = (toolsRes.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    outputSchema: t.outputSchema,
    annotations: t.annotations ?? {},
  }))

  // 2. Capabilities (for synthetic tool selection).
  const caps =
    (typeof live.client.getServerCapabilities === "function"
      ? (live.client.getServerCapabilities() as
          | { resources?: unknown; prompts?: unknown; tools?: unknown }
          | undefined)
      : undefined) ?? {}

  // 3. Compute synthetic tools matching the server's advertised capabilities.
  const { RESOURCE_TOOLS, PROMPT_TOOLS } = await import("./synthetic-tools")
  const synthetics: ProjectedToolInput[] = []
  if (caps.resources !== undefined && caps.resources !== false) synthetics.push(...RESOURCE_TOOLS)
  if (caps.prompts !== undefined && caps.prompts !== false) synthetics.push(...PROMPT_TOOLS)

  // 4. Persist the list and cache every tool's annotations FIRST, then project. The per-call
  // decision (`getPolicyForCall`) reads this cache and the projection's static `gated` flag
  // reads the same annotations (`connectionDefaultDecision`), so a tool never appears in the
  // registry before the cache agrees with it. Re-run on every tools/list, so changed hints
  // apply; an empty list is saved too, so the next boot does not bring back retired tools.
  const all = [...upstreamTools, ...synthetics]
  await repo.saveToolList(conn.id, all)

  // 5. Register the union in ONE call so retire-on-rewrite doesn't wipe either.
  await projector.registerTools({
    orgId: conn.orgId,
    connectionId: conn.id,
    slug: conn.slug,
    displayName: conn.displayName,
    ownerUserId: conn.ownerUserId ?? null,
    exposeViaGateway: conn.exposeViaGateway,
    connectionDefaultPolicy: conn.connectionDefaultPolicy,
    tools: all,
  })

  // 6. Update slug-index so buildToolSet can map the registry key back.
  slugIndex.set(conn.orgId, conn.slug, conn.id)
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const McpClientTestAccess = {
  /** Test seam — full reset (slug-index + health-gate + module state). */
  reset(): void {
    if (_state.engine) {
      void _state.engine.pool.stopReapTimer()
      void _state.engine.pool.drainAll()
    }
    _state = {}
    envBootstrapRegistered = false
    projectedMcpOrgs.clear()
    unlistedByOrg.clear()
    backfillByOrg.clear()
    slugIndex.clear()
    _resetHealthGate()
  },
  /** The booted engine's orchestrator (the call path tools use). */
  orchestrator(): McpClientEngine["orchestrator"] {
    if (!_state.engine) throw new Error("MCP client not initialised")
    return _state.engine.orchestrator
  },
  /**
   * A second, independent engine on the same database — another API
   * process, as far as credentials, pool and refresh single flight go.
   */
  async buildEngine(): Promise<{
    executeMcpCall: McpClientEngine["orchestrator"]["executeMcpCall"]
    close(): Promise<void>
  }> {
    const { makeMcpRepo } = await import("~/apps/mcp-manager/repo")
    const repo = makeMcpRepo()
    const engine = buildEngine({ repo, health: new HealthTracker(repo), projector: () => null })
    return {
      executeMcpCall: (input) => engine.orchestrator.executeMcpCall(input),
      close: () => engine.pool.drainAll(),
    }
  },
}
