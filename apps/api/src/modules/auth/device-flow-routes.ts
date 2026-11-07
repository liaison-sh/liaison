// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomBytes } from "node:crypto"
import { and, eq, gt, or } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { deviceFlowRequests } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { assertHostAllowsOrg } from "~/lib/org-host"
import { requestPublicBaseUrl } from "~/lib/org-public-url"
import { redis } from "~/lib/redis"
import { getClientIp } from "~/lib/request-context"
import { setRefreshTokenCookie, success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { checkBruteForce, recordFailedAttempt } from "~/middleware/brute-force"
import { createSession } from "~/modules/auth/auth"
import {
  describeDeviceRequest,
  MCP_DEVICE_CLIENT_PREFIX,
  normalizeDeviceLabel,
} from "~/modules/auth/device-flow-request"
import { generateDeviceUserCode } from "~/modules/auth/device-user-code"
import {
  assertUnrestrictedSession,
  DECLARED_SCOPE_PATTERN,
  MAX_DECLARED_SCOPES,
  unknownDeclaredScopes,
} from "~/modules/auth/session-ceiling"
import { assertFullAccessStepUp, readFullAccessProof } from "~/modules/mcp/full-access-step-up"

const DEVICE_CODE_EXPIRY_SECONDS = 900 // 15 minutes (spec requirement)
const PLACEHOLDER_ORG_ID = "00000000-0000-0000-0000-000000000000" // resolved on approval

const ALLOWED_CLIENTS = new Set(env.DEVICE_FLOW_CLIENTS)

// A device-flow client is public: anyone can start a request under any
// registered client id, and the approver is a signed-in member who is persuaded
// to press Approve. So the approver is shown everything the request says about
// itself (client, device label, scopes or agent binding, source IP) before
// approving, an unscoped login request is refused by default, and any request
// that would hand over the approver's whole access needs an explicit
// confirmation of exactly that (device-flow-request.ts).
export { normalizeDeviceLabel }

// `scopes`: what the client needs, as scope ids. The approved session is capped
// to them (its stored ceiling, re-applied at every refresh) and mints no further
// credential (session-ceiling.ts). Shape is checked here; that each one exists
// in the org's catalog is checked at approval, where the org is known. Omitted
// is refused unless DEVICE_FLOW_ALLOW_UNSCOPED is on.
const initiateSchema = z.object({
  clientId: z.string(),
  scopes: z
    .array(z.string().regex(DECLARED_SCOPE_PATTERN, "not a scope id"))
    .min(1)
    .max(MAX_DECLARED_SCOPES)
    .optional(),
  // Platform / device name for the approver ("Ada's laptop, macOS"). Self-declared.
  deviceLabel: z.string().max(500).optional(),
})

export const deviceFlow = new Hono<AppEnv>()

// Public: Client initiates device flow
deviceFlow.post("/initiate", zValidator("json", initiateSchema), async (c) => {
  const { clientId, scopes, deviceLabel } = c.req.valid("json")

  // Default-deny: empty list rejects all clients; "*" wildcard allows all (test/dev use)
  if (ALLOWED_CLIENTS.size === 0 || (!ALLOWED_CLIENTS.has("*") && !ALLOWED_CLIENTS.has(clientId))) {
    throw new HTTPException(403, { message: "Unregistered device client" })
  }
  // The MCP device grant stores its rows under this prefix; a login request may
  // not look like one (the approval page and the two polls tell them apart by it).
  if (clientId.startsWith(MCP_DEVICE_CLIENT_PREFIX)) {
    throw new HTTPException(400, { message: "This client id is reserved" })
  }

  // Safe default: no declared scopes would mean a session with the approver's
  // full rights and a 30-day refresh, granted on the strength of a code. The
  // client must say what it needs. DEVICE_FLOW_ALLOW_UNSCOPED=true restores
  // unscoped requests for a first-party client that really needs everything; the
  // approver then has to confirm "full access" explicitly.
  if (!scopes && !env.DEVICE_FLOW_ALLOW_UNSCOPED) {
    throw new HTTPException(400, {
      message: "scopes are required: declare the scopes this client needs",
    })
  }
  const label = normalizeDeviceLabel(deviceLabel)
  const requestIp = getClientIp(c)

  const expiresAt = new Date(Date.now() + DEVICE_CODE_EXPIRY_SECONDS * 1000)

  // user_code is unique among PENDING requests (partial UNIQUE index). A
  // collision yields a 23505; regenerate and retry rather than handing the
  // client a code already bound to another pending request — which would let
  // an approver grant a session to the wrong device (cross-account risk).
  const MAX_ATTEMPTS = 5
  let userCode = ""
  let inserted = false
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const deviceCode = randomBytes(32).toString("hex")
    userCode = generateDeviceUserCode()
    try {
      await withSystemDb("device-flow-initiate", (db) =>
        db.insert(deviceFlowRequests).values({
          deviceCode,
          userCode,
          clientId,
          state: "pending",
          expiresAt,
          orgId: PLACEHOLDER_ORG_ID,
          ...(scopes ? { scopes: [...new Set(scopes)].join(" ") } : {}),
          deviceLabel: label,
          requestIp,
        }),
      )
      inserted = true
      return success(c, {
        deviceCode,
        userCode,
        verificationUri: `${requestPublicBaseUrl(c)}/auth/device?code=${userCode}`,
        expiresIn: DEVICE_CODE_EXPIRY_SECONDS,
      })
    } catch (err) {
      // 23505 = unique_violation. The device_code is 32 random bytes so a
      // collision there is astronomically unlikely; in practice this is the
      // pending user_code index. Retry with a fresh code.
      if ((err as { code?: string }).code === "23505") continue
      throw err
    }
  }

  if (!inserted) {
    throw new HTTPException(503, {
      message: "Could not allocate a unique device code, please retry",
    })
  }
})

// Public: Client polls for approval
deviceFlow.get("/poll/:deviceCode", async (c) => {
  const deviceCode = c.req.param("deviceCode")

  // Rate limit: max 1 poll per second per device code (RFC 8628 recommends 5s interval)
  const rateLimitKey = `device-poll:${deviceCode}`
  const isAllowed = await redis.set(rateLimitKey, "1", "EX", 1, "NX")
  if (!isAllowed) {
    c.header("Retry-After", "1")
    throw new HTTPException(429, { message: "slow_down" })
  }

  const [request] = await withSystemDb("device-flow-poll", (db) =>
    db.select().from(deviceFlowRequests).where(eq(deviceFlowRequests.deviceCode, deviceCode)),
  )

  // An MCP device grant (`mcp:` client id) is redeemed by the MCP poll, as an MCP
  // connection, and by nothing else: approving one never hands out a login
  // session, whatever client id the poller presents.
  if (!request || request.clientId.startsWith(MCP_DEVICE_CLIENT_PREFIX)) {
    throw new HTTPException(404, { message: "Device flow request not found" })
  }

  const clientId = c.req.query("client_id")
  if (!clientId || clientId !== request.clientId) {
    throw new HTTPException(403, { message: "Client mismatch" })
  }

  if (
    request.state === "expired" ||
    (request.state === "pending" && request.expiresAt < new Date())
  ) {
    return success(c, { status: "expired" })
  }

  if (request.state === "pending") {
    return success(c, { status: "authorization_pending" })
  }
  if (request.state === "denied") {
    return success(c, { status: "denied" })
  }
  if (request.state === "approved" && request.userId) {
    // Host binding (lib/org-host.ts): a grant approved for org A is redeemed on
    // A's host only (the approval itself ran on A's host, authMiddleware).
    await assertHostAllowsOrg(c, request.orgId)
    // Atomic consumption: DELETE WHERE state = 'approved' prevents double-spend
    const [consumed] = await withSystemDb("device-flow-consume", (db) =>
      db
        .delete(deviceFlowRequests)
        .where(and(eq(deviceFlowRequests.id, request.id), eq(deviceFlowRequests.state, "approved")))
        .returning(),
    )
    if (!consumed) return success(c, { status: "authorization_pending" })
    // Create a session scoped to the scopes declared on the device flow request.
    // Prevents the CLI client from receiving the approver's full permission set.
    // The declared set becomes the session's stored ceiling, so every refresh
    // re-applies it (createSession / refreshSession, migration 0114).
    const declaredScopes = consumed.scopes ? consumed.scopes.split(" ").filter(Boolean) : undefined
    const tokens = await createSession(consumed.userId!, consumed.orgId, declaredScopes)
    // THE COOKIE IS UNCONDITIONAL HERE, and deliberately so. The device flow's
    // client is a CLI or another headless program polling this route: it sends
    // no Origin, it is not one of the wrapped shells (neither shell has a
    // device-flow client at all), and the copy it actually reads is the body
    // one below, behind the same escape hatch it has always been behind. If a
    // shell ever grows one, this is the line that has to learn
    // refreshTokenDelivery, like the OAuth exchange did.
    setRefreshTokenCookie(c, tokens.refreshToken)
    const body: Record<string, string> = {
      status: "approved",
      accessToken: tokens.accessToken,
    }
    if (env.EXPOSE_REFRESH_TOKEN_IN_BODY) {
      body.refreshToken = tokens.refreshToken
    }
    return success(c, body)
  }

  return success(c, { status: request.state })
})

// Failed-guess limiter for the authenticated code lookups (pending, approve,
// deny). Counted per approving user and per IP, not per code: a guesser tries
// different codes, so a per-code counter would never fill. Fail-closed.
function guessIdentifier(c: Context<AppEnv>): string {
  return `device-user:${c.get("userId")}`
}
async function guessLimit(c: Context<AppEnv>, ip: string): Promise<void> {
  try {
    const bruteCheck = await checkBruteForce(redis, guessIdentifier(c), ip)
    if (!bruteCheck.allowed) {
      throw new HTTPException(429, { message: "Too many attempts" })
    }
  } catch (err) {
    if (err instanceof HTTPException) throw err
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }
}
async function recordGuessFailure(c: Context<AppEnv>, ip: string): Promise<void> {
  try {
    await recordFailedAttempt(redis, guessIdentifier(c), ip)
  } catch {
    // The 404 below is the answer either way; the check above already fails closed.
  }
}

// Authenticated: what a user code is asking for, shown BEFORE Approve. Read only.
deviceFlow.get("/pending/:userCode", async (c) => {
  const userCode = c.req.param("userCode")
  const ip = getClientIp(c)
  await guessLimit(c, ip)
  const orgId = c.get("orgId")

  const [row] = await withPrivilegedDb(orgId, "device-flow-pending", async (db) =>
    db
      .select()
      .from(deviceFlowRequests)
      .where(
        and(
          eq(deviceFlowRequests.userCode, userCode),
          eq(deviceFlowRequests.state, "pending"),
          gt(deviceFlowRequests.expiresAt, new Date()),
          or(eq(deviceFlowRequests.orgId, PLACEHOLDER_ORG_ID), eq(deviceFlowRequests.orgId, orgId)),
        ),
      )
      .limit(1),
  )
  if (!row) {
    await recordGuessFailure(c, ip)
    throw new HTTPException(404, { message: "Pending device flow request not found" })
  }

  const access = await describeDeviceRequest(row, orgId, c.get("userId"))
  return success(c, {
    clientId: access.clientId,
    kind: access.kind,
    deviceLabel: row.deviceLabel,
    scopes: access.scopes,
    agent: access.agent,
    agentInvalid: access.agentInvalid,
    fullAccess: access.fullAccess,
    requestIp: row.requestIp,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  })
})

// Authenticated: User approves device flow (atomic UPDATE ... WHERE state = 'pending')
deviceFlow.post("/approve/:userCode", async (c) => {
  const userCode = c.req.param("userCode")

  const ip = getClientIp(c)
  await guessLimit(c, ip)
  // Approving mints a new session: never from a restricted one.
  assertUnrestrictedSession(c, "approve a device sign-in")
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const body = (await c.req.json().catch(() => ({}))) as { confirmFullAccess?: unknown }
  const confirmedFullAccess = body?.confirmFullAccess === true

  // What is being approved, read and judged before the atomic state change.
  // client id, scopes and agent binding are fixed at initiate, so the update's
  // own `state = 'pending'` guard below is the only race that matters.
  const [pending] = await withPrivilegedDb(orgId, "device-flow-approve-read", (db) =>
    db
      .select({
        scopes: deviceFlowRequests.scopes,
        clientId: deviceFlowRequests.clientId,
        deviceCode: deviceFlowRequests.deviceCode,
      })
      .from(deviceFlowRequests)
      .where(
        and(
          eq(deviceFlowRequests.userCode, userCode),
          eq(deviceFlowRequests.state, "pending"),
          gt(deviceFlowRequests.expiresAt, new Date()),
          or(eq(deviceFlowRequests.orgId, PLACEHOLDER_ORG_ID), eq(deviceFlowRequests.orgId, orgId)),
        ),
      )
      .limit(1),
  )
  if (!pending) {
    await recordGuessFailure(c, ip)
    throw new HTTPException(404, { message: "Pending device flow request not found" })
  }
  const access = await describeDeviceRequest(pending, orgId, userId)
  // Approving a request that carries the approver's whole access (a login
  // session with no declared scopes, an MCP connection bound to no agent)
  // needs the explicit confirmation the approval page asks for. Never implied.
  if (access.fullAccess && !confirmedFullAccess) {
    throw new HTTPException(409, {
      message: "This request asks for full access to your account. Confirm it explicitly.",
    })
  }
  if (access.agentInvalid) {
    throw new HTTPException(400, {
      message: "This request names an agent that does not exist in your organization",
    })
  }
  // The declared scopes must all exist in this org's catalog before anyone is
  // signed in with them.
  const unknown = unknownDeclaredScopes(orgId, access.scopes)
  if (unknown.length > 0) {
    throw new HTTPException(400, { message: `Unknown scopes requested: ${unknown.join(", ")}` })
  }
  // An MCP connection bound to no agent is a standing credential carrying the
  // approver's whole access: approving one also takes a fresh step-up (an
  // emailed code, never the password), so a session alone cannot mint it. Checked
  // last, so a request refused for another reason never spends the code.
  if (access.kind === "mcp" && access.fullAccess) {
    await assertFullAccessStepUp(userId, readFullAccessProof(body))
  }

  const [request] = await withPrivilegedDb(orgId, "device-flow-approve", async (db) => {
    const [row] = await db
      .update(deviceFlowRequests)
      .set({ state: "approved", userId, orgId })
      .where(
        and(
          // The very request that was judged above, nothing else.
          eq(deviceFlowRequests.deviceCode, pending.deviceCode),
          eq(deviceFlowRequests.state, "pending"),
          gt(deviceFlowRequests.expiresAt, new Date()),
          // Only approve if the request is unscoped (placeholder) or matches the approver's org
          or(eq(deviceFlowRequests.orgId, PLACEHOLDER_ORG_ID), eq(deviceFlowRequests.orgId, orgId)),
        ),
      )
      .returning()

    if (row) {
      await db.queueEvent({
        app: "kernel",
        entity: "device_flow",
        action: "approve",
        orgId,
        actorId: userId,
        entityId: row.id,
      })
    }

    return [row]
  })

  if (!request) {
    await recordGuessFailure(c, ip)
    throw new HTTPException(404, { message: "Pending device flow request not found" })
  }

  return success(c, { approved: true, clientId: access.clientId })
})

// Authenticated: User denies device flow (atomic UPDATE ... WHERE state = 'pending')
deviceFlow.post("/deny/:userCode", async (c) => {
  const userCode = c.req.param("userCode")

  const ip = getClientIp(c)
  await guessLimit(c, ip)
  const userId = c.get("userId")
  const orgId = c.get("orgId")

  const [request] = await withPrivilegedDb(orgId, "device-flow-deny", async (db) => {
    const [row] = await db
      .update(deviceFlowRequests)
      .set({ state: "denied" })
      .where(
        and(
          eq(deviceFlowRequests.userCode, userCode),
          eq(deviceFlowRequests.state, "pending"),
          gt(deviceFlowRequests.expiresAt, new Date()),
          or(eq(deviceFlowRequests.orgId, PLACEHOLDER_ORG_ID), eq(deviceFlowRequests.orgId, orgId)),
        ),
      )
      .returning()

    if (row) {
      await db.queueEvent({
        app: "kernel",
        entity: "device_flow",
        action: "deny",
        orgId,
        actorId: userId,
        entityId: row.id,
      })
    }

    return [row]
  })

  if (!request) {
    await recordGuessFailure(c, ip)
    throw new HTTPException(404, { message: "Pending device flow request not found" })
  }

  return success(c, { denied: true })
})
