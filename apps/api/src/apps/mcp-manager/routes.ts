// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Manager-app HTTP routes for MCP connections + tool policies + audit reads.
// Mounted at `/apps/mcp-manager` by `app.ts` (Task 33 wiring).
//
// Scope gating uses `requireScope` middleware (kernel-level). All writes happen
// inside `withRlsContext(actor, ...)` so the cross-tenant attack surface is
// defended-in-depth (route-layer scope + RLS predicate).
//
// `orgId` is ALWAYS derived from the actor's session — body fields named
// `orgId` are stripped before insert.

import { zValidator } from "@hono/zod-validator"
import { and, eq, inArray, max, sql } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { advisoryXactLock } from "~/db/advisory-lock"
import { withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  mcpConnectionHealth,
  mcpConnections,
  mcpOAuthState,
  mcpToolPolicy,
} from "~/db/schema/app_mcp_manager"
import { auditLog } from "~/db/schema/kernel/audit-log"
import { UnsafeOutboundUrlError, validateOutboundUrlNoDns } from "~/lib/outbound-fetch"
import { describeDbError } from "~/lib/transient-db-error"
import { requireScope } from "~/middleware/require-scope"
import { toolRegistry } from "~/modules/apps/app-registries"
import { getHealthGate } from "~/modules/mcp-client/health-gate"
import {
  ensureOrgToolLists,
  getMcpPool,
  getMcpProjector,
  invalidateMcpConnection,
  regateMcpConnection,
  retireMcpConnection,
  testMcpConnection,
} from "~/modules/mcp-client/index"
import {
  applyHeaderPatch,
  customHeaderNames,
  customHeadersProblem,
  decryptSecretsBlob,
  decryptSecretsBlobForWrite,
  encryptSecretsBlob,
  type McpSecretsBlob,
  metadataOf,
  readSecretsBlob,
  SECRETS_UNREADABLE_MESSAGE,
  SecretsUnreadableError,
} from "~/modules/mcp-client/secrets"
import { mcpAllowsPrivateTargets } from "~/modules/mcp-client/transports/safe-fetch"
import { PermissionDeniedError } from "~/modules/permissions/errors"
import { hasScope } from "~/modules/permissions/permissions"
import { defaultDecisionsFor, effectiveToolDecision, isAnnotatedReadOnly } from "./default-policy"
import { CONNECTION_WIDE_TOOL_NAME } from "./repo"
import { getConnectionAccess, McpAccessError, setConnectionAccess } from "./service/access"
import {
  canWriteConnection,
  grantOwnerToolNamespace,
  ORG_CONNECTION_WRITE_SCOPE,
  PERSONAL_CONNECTION_WRITE_SCOPE,
  revokeOwnerToolNamespace,
} from "./service/connections"
import type { McpToolAnnotations } from "./types"

// ───────────────────────────── Validation schemas ─────────────────────────────

const connectionCreateSchema = z.object({
  // Spec §3.6: slug is the user-facing connection handle; matches the DB
  // CHECK constraint exactly so a 400 surfaces here (not a 500 from PG).
  slug: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric + hyphens, 1-32 chars"),
  displayName: z.string().min(1).max(200),
  // Remote servers only: Liaison never runs an MCP server as a local command.
  transport: z.enum(["http", "sse"]),
  ownershipScope: z.enum(["org", "personal"]).default("org"),
  httpUrl: z.string().url().optional(),
  authFlavor: z.enum(["none", "bearer", "oauth_dcr", "oauth_static"]).default("none"),
  bearerToken: z.string().optional(),
  oauthClientId: z.string().optional(),
  oauthClientSecret: z.string().optional(),
  // S28: name → value, sent on every request (bearer / no-auth connections).
  // Values are stored encrypted and never returned.
  customHeaders: z.record(z.string(), z.string()).optional(),
  // `oauth_static` issuers have no discovery — admin supplies endpoints upfront.
  // Persisted into `oauth_metadata.authorizationEndpoint`/`.tokenEndpoint` so
  // `/oauth/start` can construct the auth URL without a discovery hop
  // (review I13).
  oauthAuthorizationEndpoint: z.string().url().optional(),
  oauthTokenEndpoint: z.string().url().optional(),
  oauthScopes: z.array(z.string()).max(100).optional(),
  agentVisibility: z.enum(["discoverable", "hidden"]).default("discoverable"),
  exposeViaGateway: z.boolean().default(true),
  connectionDefaultPolicy: z.enum(["auto", "gate_writes", "gate_all"]).default("gate_writes"),
  rateCapPerMinute: z.number().int().positive().nullable().optional(),
})

const connectionPatchSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    httpUrl: z.string().url().optional(),
    bearerToken: z.string().optional(),
    oauthClientId: z.string().optional(),
    oauthClientSecret: z.string().optional(),
    // A value sets the header, null removes it; headers left out are kept.
    customHeaders: z.record(z.string(), z.string().nullable()).optional(),
    agentVisibility: z.enum(["discoverable", "hidden"]).optional(),
    exposeViaGateway: z.boolean().optional(),
    connectionDefaultPolicy: z.enum(["auto", "gate_writes", "gate_all"]).optional(),
    // Accept `null` to explicitly UNSET the cap (return to unlimited). Positive-int
    // validation still applies to any non-null value.
    rateCapPerMinute: z.number().int().positive().nullable().optional(),
    // The add flow's tools review was completed: stamps `toolsReviewedAt`.
    toolsReviewed: z.literal(true).optional(),
  })
  .strict()

/** Several per-tool decisions at once (the tools review's bulk choices). */
const toolPolicyBulkSchema = z
  .object({
    decisions: z
      .array(
        z.object({
          toolName: z
            .string()
            .min(1)
            .refine((n) => n !== CONNECTION_WIDE_TOOL_NAME),
          overrideDecision: z.enum(["auto", "gate", "deny"]).nullable(),
        }),
      )
      .min(1)
      .max(500),
  })
  .strict()

const toolPolicyUpsertSchema = z.object({
  toolName: z.string().min(1),
  overrideDecision: z.enum(["auto", "gate", "deny"]).nullable().optional(),
  roleOverrides: z
    .array(
      z.object({
        roleId: z.string().uuid(),
        decision: z.enum(["auto", "gate", "deny"]),
      }),
    )
    .max(1000)
    .optional(),
})

// ───────────────────────────── Helpers ─────────────────────────────

/**
 * Validate an http/sse connection target before it is persisted. A connection
 * URL is attacker-influenced (any holder of `mcp_manager:connection:write`) and
 * is later dialed with the connection's decrypted bearer/OAuth token attached —
 * so a private/loopback/link-local target is an SSRF + token-exfil vector.
 * Requires HTTPS and blocks private/loopback/link-local literals. DNS is NOT
 * resolved here (the hostname may be intermittently unreachable at config time
 * and we must not couple persistence to a live lookup) — the dial path runs the
 * full DNS-resolving validation + pinning before any connection is made.
 */
function assertSafeConnectionUrl(_c: Context<AppEnv>, httpUrl: string): void {
  try {
    // The e2e server opts into loopback targets (its in-process mock MCP runs on
    // http://127.0.0.1:<port>) via LIAISON_E2E_ALLOW_PRIVATE_MCP — see
    // mcpAllowsPrivateTargets. Inert in production (the allowance only applies
    // when NODE_ENV === "test") and unset under unit tests, whose SSRF
    // assertions (routes.test.ts) must keep rejecting loopback/non-HTTPS.
    validateOutboundUrlNoDns(httpUrl, {
      requireHttps: true,
      allowPrivateHostsInTest: mcpAllowsPrivateTargets(),
    })
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      throw new HTTPException(400, { message: `Invalid connection URL: ${err.message}` })
    }
    throw err
  }
}

/**
 * Connection writes are open to two scopes (P3-T1): `mcp_manager:connection:write`
 * for any connection, `mcp_manager:personal_connection:write` (every member) for
 * the caller's OWN personal connections. This route-level gate admits either;
 * each handler then checks the ownership of the row it creates or loads
 * (`assertCanWrite`), and RLS enforces the same split underneath.
 */
const requireConnectionWriter = createMiddleware<AppEnv>(async (c, next) => {
  const scopes = (c.get("scopes") as string[] | undefined) ?? []
  if (
    !hasScope(ORG_CONNECTION_WRITE_SCOPE, scopes) &&
    !hasScope(PERSONAL_CONNECTION_WRITE_SCOPE, scopes)
  ) {
    throw new PermissionDeniedError({ missingScope: PERSONAL_CONNECTION_WRITE_SCOPE })
  }
  await next()
})

function assertCanWrite(actor: UserContext, ownershipScope: "org" | "personal"): void {
  if (!canWriteConnection(ownershipScope, actor.scopes)) {
    throw new PermissionDeniedError({ missingScope: ORG_CONNECTION_WRITE_SCOPE })
  }
}

/** Load a connection the caller may write (RLS hides other users' personal rows). */
async function loadWritableConnection(actor: UserContext, id: string) {
  const rows = await withRlsContext(actor, (db) =>
    db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
  )
  const row = rows[0]
  if (!row) throw new HTTPException(404, { message: "Connection not found" })
  assertCanWrite(actor, row.ownershipScope)
  return row
}

/**
 * An OAuth connection that holds no access token yet (its sign-in was never
 * finished, or was abandoned in the popup). Its list status is `oauth_pending`,
 * which is what offers "Sign in" again in both connection lists.
 */
function awaitsOAuthSignIn(row: { authFlavor: string; secretsEncrypted: string | null }): boolean {
  if (row.authFlavor !== "oauth_dcr" && row.authFlavor !== "oauth_static") return false
  // An unreadable blob holds no usable token either (its reason is surfaced as
  // the row's lastError; sign-in refuses until the key is restored).
  const token = decryptSecretsBlob(row.secretsEncrypted).accessToken
  return typeof token !== "string" || token.length === 0
}

/** True when the row holds a secrets blob this server cannot decrypt. */
function secretsUnreadable(row: { secretsEncrypted: string | null }): boolean {
  return !readSecretsBlob(row.secretsEncrypted).ok
}

/**
 * Liaison adds these per server capability; they are not the server's own.
 * The wizard preview and the server page list the UPSTREAM tools only.
 */
const SYNTHETIC_TOOL_NAMES = new Set([
  "resource_list",
  "resource_read",
  "resource_subscribe",
  "resource_unsubscribe",
  "prompt_list",
  "prompt_get",
])

/**
 * The server's tools as the last dial projected them into the in-process
 * registry (no new round trip): empty until the connection has been reached
 * on this node.
 */
function upstreamToolsOf(conn: { orgId: string; slug: string }): Array<{
  name: string
  description?: string
  readOnly: boolean
  defaultDecisions: ReturnType<typeof defaultDecisionsFor>
  annotations: McpToolAnnotations | undefined
}> {
  const projector = getMcpProjector()
  if (!projector) return []
  return projector
    .listProjectedToolsForSlug(conn.orgId, conn.slug)
    .map((t) => {
      const colon = t.name.lastIndexOf(":")
      const name = colon >= 0 ? t.name.slice(colon + 1) : t.name
      // What the server's tools/list says (the hints the projection gated on): read-only
      // and not destructive. The UI badges it; `gate_writes` runs it without approval.
      const readOnly = isAnnotatedReadOnly(t.annotations)
      // What each connection default gives this tool, from default-policy.ts (the rule the
      // per-call decision applies): the tools review shows a tool's decision under the
      // default being chosen, before it is saved.
      const defaultDecisions = defaultDecisionsFor(t.annotations)
      return {
        name,
        description: t.description,
        readOnly,
        defaultDecisions,
        annotations: t.annotations,
      }
    })
    .filter((t) => !SYNTHETIC_TOOL_NAMES.has(t.name))
}

/**
 * The server's tools Liaison could not register (an input schema it cannot convert, so
 * arguments it could not validate), as rows the tools page shows "Unavailable" with the
 * reason. They are never in the agent's catalogue and carry no decision.
 */
function unavailableToolsOf(conn: { orgId: string; slug: string }): Array<{
  name: string
  description?: string
  readOnly: false
  unavailableReason: string
}> {
  const projector = getMcpProjector()
  if (!projector) return []
  return projector.listUnavailableToolsForSlug(conn.orgId, conn.slug).map((t) => ({
    name: t.name,
    description: t.description,
    readOnly: false as const,
    unavailableReason: t.reason,
  }))
}

/** The tools as the API sends them (the annotations stay server-side). */
function publicTool(t: ReturnType<typeof upstreamToolsOf>[number]) {
  const { annotations: _annotations, ...rest } = t
  return rest
}

function actorFromCtx(c: Context<AppEnv>): UserContext {
  return {
    actorType: "user",
    userId: c.get("userId"),
    orgId: c.get("orgId"),
    scopes: c.get("scopes") ?? [],
    dimensionGrants: c.get("dimensionGrants") ?? {},
  }
}

/** Custom headers apply to bearer and no-auth connections (S28). */
function acceptsCustomHeaders(authFlavor: string): boolean {
  return authFlavor === "bearer" || authFlavor === "none"
}

/** 400 unless `headers` is a header set this connection may carry. */
function assertCustomHeaders(
  headers: Record<string, string | null> | undefined,
  authFlavor: string,
): void {
  if (headers === undefined || Object.keys(headers).length === 0) return
  if (!acceptsCustomHeaders(authFlavor)) {
    throw new HTTPException(400, {
      message: "Custom headers apply to bearer and no-auth connections only",
    })
  }
  const problem = customHeadersProblem(headers, { authFlavor })
  if (problem) throw new HTTPException(400, { message: `Invalid custom header: ${problem}` })
}

/**
 * The secrets a create stores, or a PATCH merges into the existing blob:
 * only the fields the input names, so a token rotation keeps the headers and
 * a header edit keeps the tokens.
 */
/** A URL's origin, or null when there is none (no URL, or not parseable). */
function urlOrigin(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function secretsPatch(input: {
  authFlavor: string
  bearerToken?: string
  oauthClientId?: string
  oauthClientSecret?: string
}): McpSecretsBlob {
  const patch: McpSecretsBlob = {}
  if (input.authFlavor === "bearer" && input.bearerToken) patch.bearerToken = input.bearerToken
  if (input.authFlavor === "oauth_static" || input.authFlavor === "oauth_dcr") {
    if (input.oauthClientId) patch.oauthClientId = input.oauthClientId
    if (input.oauthClientSecret) patch.oauthClientSecret = input.oauthClientSecret
  }
  return patch
}

/**
 * A row as the API returns it: no secrets, and the custom header NAMES only
 * (their values are secrets too).
 */
function stripSecretsForResponse<T extends { secretsEncrypted?: string | null }>(
  row: T,
): Omit<T, "secretsEncrypted"> & { customHeaderNames: string[] } {
  const { secretsEncrypted, ...rest } = row
  return { ...rest, customHeaderNames: customHeaderNames(decryptSecretsBlob(secretsEncrypted)) }
}

/** Who may set an org server's access: the MCP manager admin (org admins hold `*`). */
const CONNECTION_ADMIN_SCOPE = "mcp_manager:connection:admin"

const connectionAccessSchema = z
  .object({
    mode: z.enum(["everyone", "restricted"]),
    roleIds: z.array(z.string().uuid()).max(500).optional(),
    userIds: z.array(z.string().uuid()).max(5000).optional(),
  })
  .strict()

function accessHttpError(err: unknown): unknown {
  if (err instanceof McpAccessError) {
    return new HTTPException(err.status, { message: err.message })
  }
  return err
}

// ───────────────────────────── Routes ─────────────────────────────

export const mcpManagerRoutes = new Hono<AppEnv>()
  .get("/connections", requireScope("mcp_manager:connection:read"), async (c) => {
    const actor = actorFromCtx(c)
    const rows = await withRlsContext(actor, (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.orgId, actor.orgId)),
    )
    // Enrich with health status — read privileged because connection_health
    // is RLS-restricted to system writes (UI just needs the latest dial
    // outcome to render the status dot).
    const ids = rows.map((r) => r.id)
    const healthByConnId = new Map<
      string,
      { status: string; updatedAt: Date | null; lastError: string | null }
    >()
    if (ids.length > 0) {
      await withSystemDb("mcp-list-health", async (db) => {
        const healthRows = await db
          .select({
            connectionId: mcpConnectionHealth.connectionId,
            status: mcpConnectionHealth.status,
            updatedAt: mcpConnectionHealth.updatedAt,
            lastError: mcpConnectionHealth.lastError,
          })
          .from(mcpConnectionHealth)
          .where(inArray(mcpConnectionHealth.connectionId, ids))
        for (const h of healthRows) {
          healthByConnId.set(h.connectionId, {
            status: h.status,
            updatedAt: h.updatedAt,
            lastError: h.lastError,
          })
        }
      })
    }
    // Compute toolCount per connection from the in-process tool registry
    // (review I14). The registry key is [orgId, "mcp", "<slug>:<tool>"] so we
    // count entries matching each slug prefix.
    const toolCountBySlug = new Map<string, number>()
    for (const [key] of toolRegistry.entriesOf(actor.orgId)) {
      if (key[0] !== actor.orgId || key[1] !== "mcp") continue
      const sepIdx = key[2].indexOf(":")
      if (sepIdx <= 0) continue
      const slug = key[2].slice(0, sepIdx)
      toolCountBySlug.set(slug, (toolCountBySlug.get(slug) ?? 0) + 1)
    }

    // Compute lastCallAgo from kernel.audit_log — group by connection_id in
    // `changes->>'connection_id'` and take MAX(timestamp). Computed in one
    // query under withSystemDb (audit_log writes are kernel-privileged; the
    // read is shown to org admins only — already gated by requireScope above).
    const lastCallByConnId = new Map<string, Date>()
    if (ids.length > 0) {
      await withSystemDb("mcp-list-lastcall", async (db) => {
        const rows = await db
          .select({
            connectionId: sql<string>`(${auditLog.changes}->>'connection_id')`,
            lastAt: max(auditLog.timestamp),
          })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.orgId, actor.orgId),
              eq(auditLog.app, "mcp"),
              eq(auditLog.action, "execute"),
              inArray(sql<string>`(${auditLog.changes}->>'connection_id')`, ids),
            ),
          )
          .groupBy(sql`(${auditLog.changes}->>'connection_id')`)
        for (const r of rows) {
          if (r.connectionId && r.lastAt) lastCallByConnId.set(r.connectionId, r.lastAt)
        }
      })
    }

    const now = Date.now()
    const enriched = rows.map((r) => {
      const stripped = stripSecretsForResponse(r)
      const health = healthByConnId.get(r.id)
      // UI status: disabled overrides everything; otherwise use health.status
      // (default "idle" when no row exists yet).
      const status = r.disabled
        ? "disabled"
        : awaitsOAuthSignIn(r)
          ? "oauth_pending"
          : (health?.status ?? "idle")
      const toolCount = toolCountBySlug.get(r.slug) ?? 0
      const lastCallAt = lastCallByConnId.get(r.id)
      const lastCallAgo = lastCallAt ? Math.max(0, now - lastCallAt.getTime()) : null
      // The last dial (a Test click or a real call) and its error: the member's
      // "My connections" row shows when it was last checked and why it failed.
      const lastCheckedAt = health?.updatedAt ? health.updatedAt.toISOString() : null
      const unreadable = secretsUnreadable(r)
      const lastError = unreadable
        ? SECRETS_UNREADABLE_MESSAGE
        : health?.status === "failed" || health?.status === "needs_reauth"
          ? (health.lastError ?? null)
          : null
      // The flag, beside the message, so a client tells "can't read the saved
      // credentials" (sign-in is refused) from "not signed in" without parsing.
      return {
        ...stripped,
        status,
        toolCount,
        lastCallAgo,
        lastCheckedAt,
        lastError,
        secretsUnreadable: unreadable,
      }
    })
    return c.json({ data: enriched })
  })
  .get("/connections/:id", requireScope("mcp_manager:connection:read"), async (c) => {
    const id = c.req.param("id")
    const actor = actorFromCtx(c)
    const rows = await withRlsContext(actor, (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
    )
    if (rows.length === 0) throw new HTTPException(404, { message: "Connection not found" })
    return c.json({ data: stripSecretsForResponse(rows[0]) })
  })
  // The tools Liaison holds for a connection the caller can read (the server
  // page's Tools section), from the last dial: no dial here.
  .get("/connections/:id/tools", requireScope("mcp_manager:connection:read"), async (c) => {
    const id = c.req.param("id")
    const actor = actorFromCtx(c)
    const { rows, overrides } = await withRlsContext(actor, async (db) => ({
      rows: await db
        .select({
          orgId: mcpConnections.orgId,
          slug: mcpConnections.slug,
          policy: mcpConnections.connectionDefaultPolicy,
        })
        .from(mcpConnections)
        .where(eq(mcpConnections.id, id)),
      overrides: await db
        .select({ toolName: mcpToolPolicy.toolName, decision: mcpToolPolicy.overrideDecision })
        .from(mcpToolPolicy)
        .where(eq(mcpToolPolicy.connectionId, id)),
    }))
    if (rows.length === 0) throw new HTTPException(404, { message: "Connection not found" })
    const conn = rows[0]
    // A connection not listed since its list was stored gets its one dial first (bounded).
    await ensureOrgToolLists(conn.orgId)
    const overrideOf = new Map(overrides.map((o) => [o.toolName, o.decision]))
    // Each tool's EFFECTIVE decision (for a caller no role override matches): its per-tool
    // override, else what the connection default gives it (default-policy.ts, the rule the
    // per-call decision applies), with which of the two it is.
    return c.json({
      data: [
        ...upstreamToolsOf(conn).map((t) => ({
          ...publicTool(t),
          ...effectiveToolDecision(conn.policy, t.annotations, overrideOf.get(t.name) ?? null),
        })),
        ...unavailableToolsOf(conn),
      ],
    })
  })
  .post(
    "/connections",
    requireConnectionWriter,
    zValidator("json", connectionCreateSchema),
    async (c) => {
      const body = c.req.valid("json")
      const actor = actorFromCtx(c)
      assertCanWrite(actor, body.ownershipScope)
      if (body.agentVisibility === "hidden" && body.exposeViaGateway === false) {
        return c.json(
          {
            error: {
              message:
                "configuration error: connection is unreachable (hidden + not exposed via gateway)",
              code: "dead_row",
            },
          },
          400,
        )
      }
      if (!body.httpUrl) {
        return c.json(
          { error: { message: "httpUrl is required for http/sse transport", code: "missing_url" } },
          400,
        )
      }
      // SSRF guard: reject private/loopback/non-HTTPS connection targets at
      // persist time (re-validated again at dial time).
      assertSafeConnectionUrl(c, body.httpUrl)
      assertCustomHeaders(body.customHeaders, body.authFlavor)

      const blob: McpSecretsBlob = {
        ...secretsPatch(body),
        ...(body.customHeaders && Object.keys(body.customHeaders).length > 0
          ? { customHeaders: body.customHeaders }
          : {}),
      }
      const secretsEncrypted = Object.keys(blob).length > 0 ? encryptSecretsBlob(blob) : null
      // Build oauth_metadata for oauth_static so /oauth/start has the issuer
      // endpoints and a public client id without a discovery hop (review I13).
      // oauth_dcr discovers at /oauth/start time, so we don't seed metadata here.
      // The client SECRET is never persisted in oauth_metadata (it is plaintext
      // JSONB); it lives only in the encrypted secrets blob via buildSecretsBlob
      // and is decrypted at token-exchange / refresh time.
      let oauthMetadata: Record<string, unknown> | null = null
      if (body.authFlavor === "oauth_static") {
        oauthMetadata = {}
        if (body.oauthClientId) oauthMetadata.clientId = body.oauthClientId
        if (body.oauthAuthorizationEndpoint)
          oauthMetadata.authorizationEndpoint = body.oauthAuthorizationEndpoint
        if (body.oauthTokenEndpoint) oauthMetadata.tokenEndpoint = body.oauthTokenEndpoint
        if (body.oauthScopes) oauthMetadata.scopes = body.oauthScopes
      }

      try {
        const inserted = await withRlsContext(actor, async (db) => {
          const [row] = await db
            .insert(mcpConnections)
            .values({
              orgId: actor.orgId, // derived from session — body.orgId is ignored
              slug: body.slug,
              displayName: body.displayName,
              transport: body.transport,
              ownershipScope: body.ownershipScope,
              ownerUserId: body.ownershipScope === "personal" ? actor.userId : null,
              httpUrl: body.httpUrl,
              authFlavor: body.authFlavor,
              secretsEncrypted,
              oauthMetadata,
              agentVisibility: body.agentVisibility,
              exposeViaGateway: body.exposeViaGateway,
              connectionDefaultPolicy: body.connectionDefaultPolicy,
              managedBy: "ui",
              disabled: false,
              rateCapPerMinute: body.rateCapPerMinute ?? null,
              createdBy: actor.userId,
            })
            .returning({ id: mcpConnections.id })

          if (body.ownershipScope === "personal") {
            await grantOwnerToolNamespace(db, {
              orgId: actor.orgId,
              userId: actor.userId,
              slug: body.slug,
            })
          }

          await db.queueEvent({
            app: "mcp_manager",
            entity: "connection",
            action: "created",
            entityId: row.id,
            orgId: actor.orgId,
            actorId: actor.userId,
            actorType: "user",
            data: {
              slug: body.slug,
              transport: body.transport,
              ownershipScope: body.ownershipScope,
            },
          })
          return row
        })
        return c.json({ id: inserted.id })
      } catch (err) {
        // unique-violation on (org_id, slug); the driver's error is the query error's cause
        if (describeDbError(err).code === "23505") {
          return c.json(
            {
              error: {
                message: `A connection with slug "${body.slug}" already exists in this org`,
                code: "slug_conflict",
              },
            },
            409,
          )
        }
        throw err
      }
    },
  )
  .patch(
    "/connections/:id",
    requireConnectionWriter,
    zValidator("json", connectionPatchSchema),
    async (c) => {
      const id = c.req.param("id")
      const body = c.req.valid("json")
      const actor = actorFromCtx(c)
      const existing = await loadWritableConnection(actor, id)
      if (existing.managedBy === "env") {
        return c.json(
          {
            error: {
              message: "Connection is managed by env vars; edit MCP_* in your deployment instead",
              code: "env_managed",
            },
          },
          409,
        )
      }

      // SSRF guard on URL change — validate before persisting the new target.
      if (body.httpUrl !== undefined) {
        assertSafeConnectionUrl(c, body.httpUrl)
      }

      const patch: Record<string, unknown> = {}
      if (body.displayName !== undefined) patch.displayName = body.displayName
      if (body.httpUrl !== undefined) patch.httpUrl = body.httpUrl
      if (body.agentVisibility !== undefined) patch.agentVisibility = body.agentVisibility
      if (body.exposeViaGateway !== undefined) patch.exposeViaGateway = body.exposeViaGateway
      if (body.connectionDefaultPolicy !== undefined)
        patch.connectionDefaultPolicy = body.connectionDefaultPolicy
      // `null` explicitly clears the cap (writes NULL → unlimited); a positive int
      // sets it; `undefined` (key absent) leaves the column untouched.
      if (body.rateCapPerMinute !== undefined) {
        patch.rateCapPerMinute = body.rateCapPerMinute === null ? null : body.rateCapPerMinute
      }
      if (body.toolsReviewed === true) patch.toolsReviewedAt = new Date()

      assertCustomHeaders(body.customHeaders, existing.authFlavor)
      // Merge into the stored blob: fields the PATCH does not name are kept, so
      // editing a header or a client secret never drops the tokens.
      const secrets = secretsPatch({ authFlavor: existing.authFlavor, ...body })
      // Credentials belong to the server they were entered for: a new origin
      // drops every stored token, header and OAuth client, unless this PATCH
      // brings new ones (the api-connector's credential-target rule).
      const originChanged =
        body.httpUrl !== undefined && urlOrigin(body.httpUrl) !== urlOrigin(existing.httpUrl)
      const credentialsChanged =
        originChanged || Object.keys(secrets).length > 0 || body.customHeaders !== undefined

      patch.updatedAt = new Date()

      await withRlsContext(actor, async (db) => {
        if (credentialsChanged) {
          // A token refresh holds this lock across its token request and writes
          // the blob it read before it: the edit waits for it, then merges onto
          // the row it wrote, so neither the edit nor a rotated token is lost.
          await db.execute(advisoryXactLock(`mcp-oauth-refresh:${id}`))
          const [current] = await db
            .select({
              secretsEncrypted: mcpConnections.secretsEncrypted,
              oauthMetadata: mcpConnections.oauthMetadata,
            })
            .from(mcpConnections)
            .where(eq(mcpConnections.id, id))
          let stored: McpSecretsBlob
          try {
            // Nothing of the old server's credentials is kept, readable or not.
            stored = originChanged
              ? {}
              : decryptSecretsBlobForWrite(current?.secretsEncrypted ?? null)
          } catch (err) {
            // Re-encrypting over an unreadable blob would destroy secrets that
            // restoring the key recovers.
            if (err instanceof SecretsUnreadableError) {
              throw new HTTPException(409, { message: err.message })
            }
            throw err
          }
          const merged: McpSecretsBlob = { ...stored, ...secrets }
          if (body.customHeaders !== undefined) {
            const headers = applyHeaderPatch(stored.customHeaders, body.customHeaders)
            if (Object.keys(headers).length > 0) merged.customHeaders = headers
            else delete merged.customHeaders
          }
          patch.secretsEncrypted = encryptSecretsBlob(merged)
          // The old server's discovery, client and token state go with it.
          if (originChanged) patch.oauthMetadata = {}
          // The client id also sits in plaintext metadata, where sign-in reads it.
          if (secrets.oauthClientId) {
            patch.oauthMetadata = {
              ...(originChanged ? {} : metadataOf(current?.oauthMetadata ?? null)),
              clientId: secrets.oauthClientId,
              clientIdSource: "preregistered",
            }
          }
        }
        await db.update(mcpConnections).set(patch).where(eq(mcpConnections.id, id))
        // A sign-in started against the old server must not finish onto the new one.
        if (originChanged) {
          await db.delete(mcpOAuthState).where(eq(mcpOAuthState.connectionId, id))
        }
        await db.queueEvent({
          app: "mcp_manager",
          entity: "connection",
          action: "updated",
          entityId: id,
          orgId: actor.orgId,
          actorId: actor.userId,
          actorType: "user",
          data: {
            slug: existing.slug,
            fields: [
              ...Object.keys(patch).filter((k) => k !== "secretsEncrypted"),
              ...(credentialsChanged ? ["credentials"] : []),
            ],
            // Every process re-gates the projected tools from this (applyMcpConnectionEvent).
            ...(body.connectionDefaultPolicy !== undefined
              ? { connectionDefaultPolicy: body.connectionDefaultPolicy }
              : {}),
          },
        })
      })

      if (credentialsChanged) {
        // New credentials answer "Sign in again" for a bearer connection; an
        // OAuth one still needs its sign-in.
        let reset = false
        // Re-pointed without new credentials: the connection needs its sign-in
        // (or a token) again before it dials anything.
        const needsReauth =
          originChanged &&
          existing.authFlavor !== "none" &&
          !(existing.authFlavor === "bearer" && secrets.bearerToken)
        if (needsReauth) {
          const now = new Date()
          const health = {
            status: "needs_reauth" as const,
            lastError: "The server address changed: sign in again.",
            lastErrorAt: now,
            updatedAt: now,
          }
          await withSystemDb("mcp-patch-origin-reauth", (db) =>
            db
              .insert(mcpConnectionHealth)
              .values({ connectionId: id, ...health })
              .onConflictDoUpdate({ target: mcpConnectionHealth.connectionId, set: health }),
          )
        } else if (existing.authFlavor === "bearer" || existing.authFlavor === "none") {
          const cleared = await withSystemDb("mcp-patch-clear-reauth", (db) =>
            db
              .update(mcpConnectionHealth)
              .set({ status: "idle", lastError: null, updatedAt: new Date() })
              .where(
                and(
                  eq(mcpConnectionHealth.connectionId, id),
                  eq(mcpConnectionHealth.status, "needs_reauth"),
                ),
              )
              .returning({ id: mcpConnectionHealth.connectionId }),
          )
          reset = cleared.length > 0
        }
        // The live transport and cached credentials hold the old values.
        await invalidateMcpConnection(
          id,
          needsReauth ? { healthStatus: "needs_reauth" } : reset ? { healthStatus: "idle" } : {},
        )
      }
      // The projected tools' static `gated` flag follows the default policy: here
      // at once, and on peer processes from the queued `connection:updated` event.
      if (
        body.connectionDefaultPolicy !== undefined &&
        body.connectionDefaultPolicy !== existing.connectionDefaultPolicy
      ) {
        regateMcpConnection({
          orgId: existing.orgId,
          slug: existing.slug,
          connectionDefaultPolicy: body.connectionDefaultPolicy,
        })
      }

      return c.json({ ok: true })
    },
  )
  .delete("/connections/:id", requireConnectionWriter, async (c) => {
    const id = c.req.param("id")
    const actor = actorFromCtx(c)
    const existing = await loadWritableConnection(actor, id)
    if (existing.managedBy === "env") {
      return c.json(
        {
          error: {
            message: "Connection is managed by env vars; remove MCP_* from your deployment instead",
            code: "env_managed",
          },
        },
        409,
      )
    }
    await withRlsContext(actor, async (db) => {
      await db.delete(mcpConnections).where(eq(mcpConnections.id, id))
      const owner = existing.ownerUserId
      if (existing.ownershipScope === "personal" && owner) {
        await revokeOwnerToolNamespace(db, {
          orgId: actor.orgId,
          userId: owner,
          slug: existing.slug,
        })
      }
      await db.queueEvent({
        app: "mcp_manager",
        entity: "connection",
        action: "deleted",
        entityId: id,
        orgId: actor.orgId,
        actorId: actor.userId,
        actorType: "user",
        data: { slug: existing.slug, ownershipScope: existing.ownershipScope },
      })
    })
    // Take the connection out of service in this process now: retire every
    // projected tool (the agent's tool_search must stop offering them), forget
    // the slug, health and disabled state, and close the pooled client. Peer
    // processes do the same from the queued `connection:deleted` event.
    await retireMcpConnection({ orgId: actor.orgId, connectionId: id, slug: existing.slug })
    return c.json({ ok: true })
  })
  // ──── Test connection (Task 19 — dial + tools/list dry run) ────
  // Verifies the persisted connection by routing through the kernel mcp-client
  // pool — the same machinery that serves real agent tool calls — so the test
  // path exercises single-flight, backoff, tool projection, and health updates
  // exactly once (review I23). The pool's `dial` already decrypts secrets,
  // selects the transport, runs the handshake, projects tools into the
  // registry, and caches the live connection; we just retrieve it and call
  // `tools/list` to surface the names back to the wizard.
  .post("/connections/:id/test", requireConnectionWriter, async (c) => {
    const id = c.req.param("id")
    const actor = actorFromCtx(c)
    const conn = await loadWritableConnection(actor, id)
    const started = Date.now()

    const pool = getMcpPool()
    if (!pool) {
      // MCP client not initialised (manager app missing / pre-boot). Without a
      // pool we cannot honour the contract that test + real call share one
      // dial path, so surface a clear 503 rather than silently re-implementing
      // the transport selection.
      return c.json(
        {
          ok: false,
          durationMs: 0,
          error: { message: "MCP client not initialised", code: "mcp_client_unavailable" },
        },
        503,
      )
    }

    // A fresh dial with the connection's current credentials, through the same
    // refresh path a call takes; it records health (a refused refresh is
    // needs_reauth, kept until a new sign-in).
    const result = await testMcpConnection(id)
    if (!result.ok) {
      return c.json({
        ok: false,
        durationMs: Date.now() - started,
        error: {
          message: result.message,
          code: result.needsReauth ? "needs_reauth" : "dial_failed",
        },
      })
    }
    // The dial's post-handshake projection step already called `tools/list`
    // and registered every tool in the in-process registry. Read those back
    // instead of issuing a second RTT to the upstream — filter out the
    // local-only synthetic resource_* / prompt_* tools (Liaison adds those
    // based on server capabilities; the wizard preview is about UPSTREAM
    // tools the operator discovered by configuring this server).
    const tools = upstreamToolsOf(conn).map(publicTool)
    return c.json({
      ok: true,
      durationMs: Date.now() - started,
      toolCount: tools.length,
      tools: [...tools, ...unavailableToolsOf(conn)],
    })
  })
  .post("/connections/:id/disable", requireConnectionWriter, async (c) => {
    const id = c.req.param("id")
    const actor = actorFromCtx(c)
    await loadWritableConnection(actor, id)
    const updated = await withRlsContext(actor, async (db) => {
      const rows = await db
        .update(mcpConnections)
        .set({ disabled: true, updatedAt: new Date() })
        .where(eq(mcpConnections.id, id))
        .returning({ id: mcpConnections.id })
      if (rows.length === 0) return null
      await db.queueEvent({
        app: "mcp_manager",
        entity: "connection",
        action: "disabled",
        entityId: id,
        orgId: actor.orgId,
        actorId: actor.userId,
        actorType: "user",
        data: {},
      })
      return rows[0]
    })
    if (!updated) throw new HTTPException(404, { message: "Connection not found" })
    // Mirror the disabled flag into the health gate so the agent's deferred
    // tool list reflects it immediately, without waiting for a process restart
    // (review B7).
    getHealthGate().setDisabled(id, true)
    return c.json({ ok: true })
  })
  .post("/connections/:id/enable", requireConnectionWriter, async (c) => {
    const id = c.req.param("id")
    const actor = actorFromCtx(c)
    await loadWritableConnection(actor, id)
    const updated = await withRlsContext(actor, async (db) => {
      const rows = await db
        .update(mcpConnections)
        .set({ disabled: false, updatedAt: new Date() })
        .where(eq(mcpConnections.id, id))
        .returning({ id: mcpConnections.id })
      if (rows.length === 0) return null
      await db.queueEvent({
        app: "mcp_manager",
        entity: "connection",
        action: "enabled",
        entityId: id,
        orgId: actor.orgId,
        actorId: actor.userId,
        actorType: "user",
        data: {},
      })
      return rows[0]
    })
    if (!updated) throw new HTTPException(404, { message: "Connection not found" })
    // Mirror the re-enabled flag into the health gate (review B7).
    getHealthGate().setDisabled(id, false)
    return c.json({ ok: true })
  })
  // ──── Who can use it (org servers; migration 0198) ────
  // Admin only. Everyone (every active member) or restricted to the listed roles
  // and people; the permission loader turns it into `mcp:<slug>` at token issue.
  .get("/connections/:id/access", requireScope(CONNECTION_ADMIN_SCOPE), async (c) => {
    try {
      return c.json({ data: await getConnectionAccess(actorFromCtx(c), c.req.param("id")) })
    } catch (err) {
      throw accessHttpError(err)
    }
  })
  .put(
    "/connections/:id/access",
    requireScope(CONNECTION_ADMIN_SCOPE),
    zValidator("json", connectionAccessSchema),
    async (c) => {
      const body = c.req.valid("json")
      try {
        const data = await setConnectionAccess(actorFromCtx(c), c.req.param("id"), {
          mode: body.mode,
          roleIds: body.roleIds ?? [],
          userIds: body.userIds ?? [],
        })
        return c.json({ data })
      } catch (err) {
        throw accessHttpError(err)
      }
    },
  )
  // ──── Tool policy (Task 20) ────
  .put(
    "/connections/:id/policy",
    requireScope("mcp_manager:policy:write"),
    zValidator("json", toolPolicyUpsertSchema),
    async (c) => {
      const connectionId = c.req.param("id")
      const body = c.req.valid("json")
      const actor = actorFromCtx(c)

      // Ensure the connection is visible under the actor's RLS context — guards
      // against PUT-ing policy onto cross-org connections.
      const exists = await withRlsContext(actor, (db) =>
        db
          .select({ id: mcpConnections.id })
          .from(mcpConnections)
          .where(eq(mcpConnections.id, connectionId)),
      )
      if (exists.length === 0) throw new HTTPException(404, { message: "Connection not found" })

      await withRlsContext(actor, async (db) => {
        // Upsert (connection_id, tool_name) on the UNIQUE index.
        await db
          .insert(mcpToolPolicy)
          .values({
            connectionId,
            toolName: body.toolName,
            overrideDecision: body.overrideDecision ?? null,
            roleOverrides: body.roleOverrides ?? null,
          })
          .onConflictDoUpdate({
            target: [mcpToolPolicy.connectionId, mcpToolPolicy.toolName],
            set: {
              overrideDecision: body.overrideDecision ?? null,
              roleOverrides: body.roleOverrides ?? null,
              updatedAt: new Date(),
            },
          })
        await db.queueEvent({
          app: "mcp_manager",
          entity: "policy",
          action: "updated",
          entityId: connectionId,
          orgId: actor.orgId,
          actorId: actor.userId,
          actorType: "user",
          data: { toolName: body.toolName, decision: body.overrideDecision },
        })
      })
      return c.json({ ok: true })
    },
  )
  // Several per-tool decisions in ONE transaction (the tools review's "Allow all
  // reads", "Approve all", "Reset to default"). Only `overrideDecision` changes: a
  // tool's role overrides are kept. `null` returns the tool to the default.
  .put(
    "/connections/:id/policy/bulk",
    requireScope("mcp_manager:policy:write"),
    zValidator("json", toolPolicyBulkSchema),
    async (c) => {
      const connectionId = c.req.param("id")
      const { decisions } = c.req.valid("json")
      const actor = actorFromCtx(c)
      await withRlsContext(actor, async (db) => {
        const exists = await db
          .select({ id: mcpConnections.id })
          .from(mcpConnections)
          .where(eq(mcpConnections.id, connectionId))
        if (exists.length === 0) throw new HTTPException(404, { message: "Connection not found" })
        const now = new Date()
        for (const d of decisions) {
          await db
            .insert(mcpToolPolicy)
            .values({ connectionId, toolName: d.toolName, overrideDecision: d.overrideDecision })
            .onConflictDoUpdate({
              target: [mcpToolPolicy.connectionId, mcpToolPolicy.toolName],
              set: { overrideDecision: d.overrideDecision, updatedAt: now },
            })
        }
        await db.queueEvent({
          app: "mcp_manager",
          entity: "policy",
          action: "updated",
          entityId: connectionId,
          orgId: actor.orgId,
          actorId: actor.userId,
          actorType: "user",
          data: { bulk: decisions.length },
        })
      })
      return c.json({ ok: true, count: decisions.length })
    },
  )
  .get("/connections/:id/policy", requireScope("mcp_manager:policy:read"), async (c) => {
    const connectionId = c.req.param("id")
    const actor = actorFromCtx(c)
    const rows = await withRlsContext(actor, (db) =>
      db.select().from(mcpToolPolicy).where(eq(mcpToolPolicy.connectionId, connectionId)),
    )
    return c.json({ data: rows })
  })
