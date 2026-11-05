// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Device registration for the wrapped mobile app.
//
//   POST   /api/push/tokens  -> { data: { id } }   (body may say `multiServer`)
//   DELETE /api/push/tokens  -> 204
//
// The POST is an UPSERT, not an insert. A Capacitor client calls
// `PushNotifications.register()` on every cold start and posts whatever token
// the platform hands back, which is usually the same one: an insert would grow
// a row per launch and the fanout would then send one notification per row to
// the same handset.
//
// The body may name the APNs environment the build was signed for (S11): an
// Xcode build posts `sandbox`, a TestFlight or App Store build `production`.
// A client from before that field posts none and is recorded as `production`.
// A re-register rewrites it, since the same device can move from an Xcode
// install to a TestFlight one.
//
// The row's owner is the authenticated caller, never a user id in the body.
// The body names the device; who it belongs to is the session's business, and
// accepting a userId here would let any member point a colleague's
// notifications at their own phone.
//
// A registration first takes the token from any other user's row on this
// server (`claimPushToken`, privileged: those rows are not the caller's): the
// phone holds one session per server, so such a row is a session that ended
// on this handset without its sign-out reaching us.
//
// Both writes run on the caller's OWN request RLS handle. kernel.push_tokens
// carries full row level security on (org_id, user_id) granted to liaison_rls,
// and these two routes touch nothing but the caller's own rows, so the
// database enforces the ownership rule the route states above instead of the
// route being trusted to state it correctly. The fan-out consumer and the
// badge count are the privileged half of this module: they resolve ANOTHER
// user's tokens off the outbox with no actor to borrow a context from.
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withRlsContext } from "~/db/rls"
import { pushTokens } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import {
  claimPushToken,
  issueDeviceCredential,
  revokeDeviceCredentials,
} from "~/modules/notifications/devices"

export const pushRoutes = new Hono<AppEnv>()

const log = rootLogger.child({ module: "push-routes" })

/** Said once per process: an iOS client too old to report its environment. */
let missingEnvironmentNoticed = false

const tokenSchema = z.object({
  platform: z.enum(["ios", "android"]),
  // APNs tokens are 64 hex characters, FCM tokens are long opaque strings, and
  // both change shape between platform versions, so the bound is a sanity
  // ceiling rather than a format claim.
  token: z.string().min(1).max(4096),
})

const registerSchema = tokenSchema.extend({
  environment: z.enum(["sandbox", "production"]).optional(),
  // The app knows several servers: its pushes name their organisation. Sent
  // on every registration and again when a server is added or removed; a
  // client from before the field sends none and is single server.
  multiServer: z.boolean().optional(),
})

function callerContext(c: {
  get: (key: "orgId" | "userId" | "scopes" | "dimensionGrants") => unknown
}) {
  return {
    actorType: "user" as const,
    orgId: c.get("orgId") as string,
    userId: c.get("userId") as string,
    scopes: (c.get("scopes") as string[]) ?? [],
    dimensionGrants: (c.get("dimensionGrants") as Record<string, string[]>) ?? {},
  }
}

pushRoutes.post("/tokens", zValidator("json", registerSchema), async (c) => {
  // A push address receives the user's notifications at their stored grants,
  // beyond a restricted (device-flow) session's ceiling: refused.
  assertUnrestrictedSession(c, "register a push device")
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const { platform, token } = c.req.valid("json")
  const reported = c.req.valid("json").environment
  if (reported === undefined && platform === "ios" && !missingEnvironmentNoticed) {
    missingEnvironmentNoticed = true
    log.info("An iOS client registered a push token without an environment; recorded as production")
  }
  const environment = reported ?? "production"
  const multiServer = c.req.valid("json").multiServer === true
  // The handset is this caller's now: a previous user's row for the same token
  // is a session that ended on it, and goes (notifications/devices.ts).
  await claimPushToken({ orgId, userId, platform, token })
  const id = await withRlsContext(callerContext(c), async (tx) => {
    const [row] = await tx
      .insert(pushTokens)
      .values({ orgId, userId, platform, token, environment, multiServer })
      .onConflictDoUpdate({
        target: [pushTokens.userId, pushTokens.platform, pushTokens.token],
        set: { environment, multiServer, lastSeenAt: new Date(), updatedAt: new Date() },
      })
      .returning({ id: pushTokens.id })
    return row.id
  })
  // The device's receipt-only credential (A7): the token row id is its device
  // id. Every registration rotates it, so the previous one stops working.
  const receiptCredential = await issueDeviceCredential({
    orgId,
    userId,
    deviceId: id,
    surface: platform,
  })
  return success(c, { id, receiptCredential }, undefined, 201)
})

// Sign-out, and the "this device no longer wants notifications" toggle. Scoped
// to the caller's own rows: naming a token never deletes another user's row.
pushRoutes.delete("/tokens", zValidator("json", tokenSchema), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const { platform, token } = c.req.valid("json")
  const deleted = await withRlsContext(callerContext(c), (tx) =>
    tx
      .delete(pushTokens)
      .where(
        and(
          eq(pushTokens.orgId, orgId),
          eq(pushTokens.userId, userId),
          eq(pushTokens.platform, platform),
          eq(pushTokens.token, token),
        ),
      )
      .returning({ id: pushTokens.id }),
  )
  // A deleted device's receipt credential dies with it (A7).
  for (const row of deleted) await revokeDeviceCredentials({ orgId, userId, deviceId: row.id })
  return c.body(null, 204)
})
