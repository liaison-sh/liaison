// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomBytes } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { deviceFlowRequests } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { requestPublicBaseUrl } from "~/lib/org-public-url"
import { redis } from "~/lib/redis"
import { getClientIp } from "~/lib/request-context"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import {
  agentBindingKey,
  MCP_DEVICE_CLIENT_PREFIX,
  normalizeDeviceLabel,
} from "~/modules/auth/device-flow-request"
import {
  createMcpConnection,
  loadBindableAgent,
  mintAccessToken,
} from "~/modules/mcp/connection-service"
import { deviceClientDecision } from "~/modules/mcp/device-client-policy"

const DEVICE_CODE_EXPIRY_SECONDS = 900 // 15 minutes (matches auth device flow)
// How long a client waits between polls. STATED, not guessed: the poll route
// refuses more than one poll per second per device code, and a client that has
// to invent a number either hammers into 429s or polls so slowly that a human
// who has already approved keeps staring at the code.
const DEVICE_POLL_INTERVAL_SECONDS = 5
const PLACEHOLDER_ORG_ID = "00000000-0000-0000-0000-000000000000"
// Headless device-grant (success criterion 2) is OPT-IN: it works only once
// `DEVICE_FLOW_CLIENTS` is configured (comma-separated client ids, or `*`).
// Empty by default → the route 403s with an ACTIONABLE message so a
// dogfooding deployment doesn't silently lose the headless-connect path.
const ALLOWED_CLIENTS = new Set(env.DEVICE_FLOW_CLIENTS)

// The `mcp:` client-id prefix scopes a deviceFlowRequests row to the MCP poll
// path; the login device-flow poll never matches these. Shared with the
// approval routes (auth/device-flow-request.ts), never re-typed as a literal.
export { agentBindingKey, MCP_DEVICE_CLIENT_PREFIX }

export const mcpDeviceGrant = new Hono<AppEnv>()

const initiateSchema = z.object({
  clientId: z.string(),
  /**
   * Bind the resulting connection to an agent, the device-grant half of the
   * same capability the authorization-code flow offers. It cannot be validated
   * here: a device grant is initiated by a HEADLESS client with no session, so
   * the org is only known once a human approves it. The request is therefore
   * PARKED against the device code (which is the client's own secret) and
   * validated at consume time against the approving user's org.
   */
  agentId: z.string().uuid().optional(),
  // Platform / device name shown to the approver. Self-declared, so unverified.
  deviceLabel: z.string().max(500).optional(),
})

// A requested agent binding is parked in redis against the device code
// (agentBindingKey): the device_flow_requests row has no column for it, and it
// is short-lived request state with the grant's own lifetime.

// Public: MCP client initiates the device grant (sibling of auth device flow,
// but the stored clientId is prefixed so the MCP poll owns these rows).
mcpDeviceGrant.post("/initiate", zValidator("json", initiateSchema), async (c) => {
  const { clientId, agentId, deviceLabel } = c.req.valid("json")
  // The desktop app is admitted whenever the flow is on at all
  // (`device-client-policy.ts`).
  const decision = deviceClientDecision(ALLOWED_CLIENTS, clientId)
  if (decision === "flow-disabled") {
    throw new HTTPException(403, {
      message:
        "MCP device-flow is not enabled on this instance — set DEVICE_FLOW_CLIENTS (comma-separated client ids, or '*') to allow headless connections",
    })
  }
  if (decision === "unregistered") {
    throw new HTTPException(403, { message: "Unregistered device client" })
  }

  const deviceCode = randomBytes(32).toString("hex")
  const SAFE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
  const codeBytes = randomBytes(8)
  const userCode = Array.from(codeBytes)
    .map((b) => SAFE_ALPHABET[b % SAFE_ALPHABET.length])
    .join("")
  const expiresAt = new Date(Date.now() + DEVICE_CODE_EXPIRY_SECONDS * 1000)
  const storedClientId = `${MCP_DEVICE_CLIENT_PREFIX}${clientId}`

  // Parked BEFORE the row exists, so the approval page never sees the request
  // without the binding it carries.
  if (agentId) {
    await redis.set(agentBindingKey(deviceCode), agentId, "EX", DEVICE_CODE_EXPIRY_SECONDS)
  }

  await withSystemDb("mcp-device-initiate", (db) =>
    db.insert(deviceFlowRequests).values({
      deviceCode,
      userCode,
      clientId: storedClientId,
      state: "pending",
      expiresAt,
      orgId: PLACEHOLDER_ORG_ID,
      deviceLabel: normalizeDeviceLabel(deviceLabel),
      requestIp: getClientIp(c),
    }),
  )

  return success(c, {
    deviceCode,
    userCode,
    verificationUri: `${requestPublicBaseUrl(c)}/auth/device?code=${userCode}`,
    expiresIn: DEVICE_CODE_EXPIRY_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  })
})

// Public: the client that initiated a grant GIVES UP on it (P6d-FX7, SK-7).
//
// The desktop's device dialog had a Cancel that set a signal to null: nothing
// aborted the in-flight grant and nothing told the server, so the pending code
// stayed approvable for its whole fifteen minutes. A user who cancelled and
// then followed the link they had already copied (or anyone holding the code)
// completed a flow the window had forgotten it started, and the connection and
// token minted by it belonged to nobody watching.
//
// Authenticated by the DEVICE CODE itself, which is the initiating client's own
// secret, plus the client id it was registered under: a headless client has no
// session to authenticate with, which is the whole reason this flow exists. The
// row is deleted rather than marked denied, because there is nothing left to
// poll for and a row nobody will read is a row nobody has to expire.
mcpDeviceGrant.delete("/:deviceCode", async (c) => {
  const deviceCode = c.req.param("deviceCode")
  const [request] = await withSystemDb("mcp-device-cancel-read", (db) =>
    db.select().from(deviceFlowRequests).where(eq(deviceFlowRequests.deviceCode, deviceCode)),
  )
  // A grant that is already gone is a grant nobody can approve, which is what
  // the caller asked for: answered the same way, so a retry is safe.
  if (!request || !request.clientId.startsWith(MCP_DEVICE_CLIENT_PREFIX)) {
    return success(c, { cancelled: true })
  }
  const clientId = c.req.query("client_id")
  if (!clientId || `${MCP_DEVICE_CLIENT_PREFIX}${clientId}` !== request.clientId) {
    throw new HTTPException(403, { message: "Client mismatch" })
  }
  await withSystemDb("mcp-device-cancel", (db) =>
    db.delete(deviceFlowRequests).where(eq(deviceFlowRequests.id, request.id)),
  )
  // And the parked agent binding with it: a key nobody will redeem.
  await redis.del(agentBindingKey(deviceCode))
  return success(c, { cancelled: true })
})

// Public: MCP client polls — on approved, mint an mcp_connections row + token
// (NOT a login session). Atomic single-consume via DELETE WHERE state='approved'.
// `agent_id` (query) re-states the binding requested at /initiate; it is
// REQUIRED exactly when one was requested, and refused when one was not.
mcpDeviceGrant.get("/poll/:deviceCode", async (c) => {
  const deviceCode = c.req.param("deviceCode")

  const rateLimitKey = `mcp-device-poll:${deviceCode}`
  const isAllowed = await redis.set(rateLimitKey, "1", "EX", 1, "NX")
  if (!isAllowed) {
    c.header("Retry-After", "1")
    throw new HTTPException(429, { message: "slow_down" })
  }

  const [request] = await withSystemDb("mcp-device-poll", (db) =>
    db.select().from(deviceFlowRequests).where(eq(deviceFlowRequests.deviceCode, deviceCode)),
  )
  if (!request) throw new HTTPException(404, { message: "Device flow request not found" })

  // Only the MCP poll owns mcp:-prefixed rows.
  if (!request.clientId.startsWith(MCP_DEVICE_CLIENT_PREFIX)) {
    throw new HTTPException(404, { message: "Device flow request not found" })
  }

  const clientId = c.req.query("client_id")
  if (!clientId || `${MCP_DEVICE_CLIENT_PREFIX}${clientId}` !== request.clientId) {
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
    const [consumed] = await withSystemDb("mcp-device-consume", (db) =>
      db
        .delete(deviceFlowRequests)
        .where(and(eq(deviceFlowRequests.id, request.id), eq(deviceFlowRequests.state, "approved")))
        .returning(),
    )
    if (!consumed) return success(c, { status: "authorization_pending" })

    // The requested agent binding, redeemed once, and validated against the
    // org the APPROVER belongs to: a client that named an agent of another org
    // (or an archived one) is refused outright rather than quietly downgraded
    // to a legacy connection carrying the grantor's full scopes.
    const requestedAgentId = await redis.getdel(agentBindingKey(deviceCode))
    // THE CLIENT RE-STATES ITS BINDING AT POLL, and the two must agree exactly.
    // The parked value is request state in redis, so it can be gone (eviction,
    // a flush, an expiry at the edge of the window). A missing key used to read
    // as "no agent was requested" and mint a LEGACY connection carrying the
    // grantor's full scopes: a silent widening, on a path whose whole purpose
    // is narrowing. So all four cases are decided here and three of them
    // refuse: named-but-unparked and named-but-different (the binding cannot be
    // honoured), and unnamed-but-parked (this poll is not the client that
    // initiated the grant, or it has forgotten what it asked for). Only both
    // absent is a legacy grant, and only both present and equal binds. The
    // approved row is already consumed at this point, which is deliberate: a
    // grant whose binding is in doubt must not stay pollable.
    const presentedAgentId = c.req.query("agent_id") ?? null
    if (presentedAgentId !== (requestedAgentId ?? null)) {
      throw new HTTPException(400, {
        message:
          "agent binding mismatch: the poll must re-state the agentId given at initiate. Re-initiate the device grant with the agent you intend to bind.",
      })
    }
    if (
      requestedAgentId &&
      !(await loadBindableAgent(consumed.orgId, consumed.userId!, requestedAgentId))
    ) {
      throw new HTTPException(400, { message: "unknown or foreign org agent" })
    }

    const { connection, refreshToken } = await createMcpConnection({
      orgId: consumed.orgId,
      userId: consumed.userId!,
      clientId: consumed.clientId,
      label: consumed.clientId.slice(MCP_DEVICE_CLIENT_PREFIX.length) || "MCP client",
      ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
    })
    const { token } = await mintAccessToken(connection.id)
    return success(c, { status: "approved", accessToken: token, refreshToken })
  }

  return success(c, { status: request.state })
})
