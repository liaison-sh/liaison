// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Devices and receipts API (S1, S3, A7, F1), under /api/notifications.
 *
 * Session-authenticated (the caller's own devices only):
 *   POST   /desktop-devices                 register a desktop install -> credential
 *   DELETE /desktop-devices/:deviceId       forget it, revoke its credential
 *   POST   /browser-subscriptions           register a browser (+ Web Push) -> credential
 *   DELETE /browser-subscriptions/:deviceId forget it, revoke its credential
 *   POST   /devices/:deviceId/credential    rotate a registered device's credential
 *   GET    /devices                         every device, last delivery + last receipt
 *   GET    /web-push/config                 the VAPID public key a browser subscribes with
 *   GET    /receipt-status?ids=a,b          the caller's receipts for those notifications
 *
 * Credential-authenticated (no session; `Authorization: Bearer lnr_...`):
 *   POST   /receipts                        one receipt for the credential's device
 *
 * iOS registers through POST /api/push/tokens, which answers its credential.
 */
import { and, eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import {
  browserPushSubscriptions,
  CREDENTIAL_SURFACES,
  DESKTOP_PERMISSIONS,
  desktopDevices,
  notificationReceipts,
} from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { validateOutboundUrlNoDns } from "~/lib/outbound-fetch"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import {
  issueDeviceCredential,
  listDevices,
  ownsDevice,
  recordReceipt,
  registerBrowserDevice,
  revokeDeviceCredentials,
  verifyDeviceCredential,
} from "./devices"
import { sendTestNotification } from "./test-send"

/** The one path of this API that is not behind the session middleware. */
export const NOTIFICATION_RECEIPTS_PATH = "/api/notifications/receipts"

/**
 * A browser push endpoint is a push service's URL (FCM, Mozilla, Apple, ...),
 * and the server POSTs to it. Refuse anything that is not public https at
 * registration; the send path re-checks and pins DNS (modules/push/web-push.ts).
 */
function isPublicHttpsEndpoint(value: string): boolean {
  try {
    validateOutboundUrlNoDns(value, { requireHttps: true })
    return true
  } catch {
    return false
  }
}

const deviceIdSchema = z.string().trim().min(1).max(128)

const desktopSchema = z.object({
  deviceId: deviceIdSchema,
  os: z.string().max(64).optional(),
  appVersion: z.string().max(64).optional(),
  notificationPermission: z.enum(DESKTOP_PERMISSIONS).optional(),
})

const browserSchema = z.object({
  deviceId: deviceIdSchema,
  subscription: z
    .object({
      endpoint: z
        .string()
        .url()
        .max(2048)
        .refine(isPublicHttpsEndpoint, "Push endpoint must be a public https URL"),
      keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
    })
    .nullable()
    .optional(),
  userAgent: z.string().max(512).optional(),
})

const credentialSchema = z.object({ surface: z.enum(CREDENTIAL_SURFACES) })

const receiptSchema = z.object({
  notificationId: z.string().uuid(),
  deviceId: deviceIdSchema.optional(),
  surface: z.enum(["ios", "android", "desktop", "browser_tab", "browser_push"]).optional(),
  appState: z.string().max(32).optional(),
  outcome: z.enum(["received", "shown", "suppressed"]),
  reason: z.string().max(64).optional(),
})

export const notificationDeviceRoutes = new Hono<AppEnv>()

notificationDeviceRoutes.post("/desktop-devices", zValidator("json", desktopSchema), async (c) => {
  assertUnrestrictedSession(c, "register a notification device")
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const body = c.req.valid("json")
  await withRequestRls(c, (tx) =>
    tx
      .insert(desktopDevices)
      .values({
        orgId,
        userId,
        deviceId: body.deviceId,
        os: body.os ?? null,
        appVersion: body.appVersion ?? null,
        reportedPermission: body.notificationPermission ?? null,
      })
      .onConflictDoUpdate({
        target: [desktopDevices.userId, desktopDevices.deviceId],
        set: {
          ...(body.os !== undefined ? { os: body.os } : {}),
          ...(body.appVersion !== undefined ? { appVersion: body.appVersion } : {}),
          ...(body.notificationPermission !== undefined
            ? { reportedPermission: body.notificationPermission }
            : {}),
          lastSeenAt: new Date(),
        },
      }),
  )
  const receiptCredential = await issueDeviceCredential({
    orgId,
    userId,
    deviceId: body.deviceId,
    surface: "desktop",
  })
  return success(c, { deviceId: body.deviceId, receiptCredential }, undefined, 201)
})

notificationDeviceRoutes.delete("/desktop-devices/:deviceId", async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const deviceId = c.req.param("deviceId")
  await withRequestRls(c, (tx) =>
    tx
      .delete(desktopDevices)
      .where(and(eq(desktopDevices.userId, userId), eq(desktopDevices.deviceId, deviceId))),
  )
  await revokeDeviceCredentials({ orgId, userId, deviceId })
  return c.body(null, 204)
})

notificationDeviceRoutes.post(
  "/browser-subscriptions",
  zValidator("json", browserSchema),
  async (c) => {
    assertUnrestrictedSession(c, "register a notification device")
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const body = c.req.valid("json")
    // A push endpoint has one owner: registering it takes it from any other
    // row, revoking that row's credential (fix2-F1, devices.ts).
    await registerBrowserDevice({
      orgId,
      userId,
      deviceId: body.deviceId,
      push:
        body.subscription === undefined
          ? undefined
          : body.subscription === null
            ? null
            : {
                endpoint: body.subscription.endpoint,
                p256dh: body.subscription.keys.p256dh,
                auth: body.subscription.keys.auth,
              },
      userAgent: body.userAgent,
    })
    const receiptCredential = await issueDeviceCredential({
      orgId,
      userId,
      deviceId: body.deviceId,
      surface: "browser",
    })
    return success(c, { deviceId: body.deviceId, receiptCredential }, undefined, 201)
  },
)

notificationDeviceRoutes.delete("/browser-subscriptions/:deviceId", async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const deviceId = c.req.param("deviceId")
  await withRequestRls(c, (tx) =>
    tx
      .delete(browserPushSubscriptions)
      .where(
        and(
          eq(browserPushSubscriptions.userId, userId),
          eq(browserPushSubscriptions.deviceId, deviceId),
        ),
      ),
  )
  await revokeDeviceCredentials({ orgId, userId, deviceId })
  return c.body(null, 204)
})

notificationDeviceRoutes.post(
  "/devices/:deviceId/credential",
  zValidator("json", credentialSchema),
  async (c) => {
    assertUnrestrictedSession(c, "register a notification device")
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const deviceId = c.req.param("deviceId")
    const { surface } = c.req.valid("json")
    const owned = await withRequestRls(c, (tx) => ownsDevice(tx, surface, deviceId))
    if (!owned) return c.json({ error: { message: "Device not found", code: "NOT_FOUND" } }, 404)
    const receiptCredential = await issueDeviceCredential({ orgId, userId, deviceId, surface })
    return success(c, { deviceId, receiptCredential }, undefined, 201)
  },
)

// S6, A4: one test notification to every device of the caller, each under its
// own notificationId, past the grid and quiet time.
notificationDeviceRoutes.post("/test", async (c) => {
  assertUnrestrictedSession(c, "send a test notification")
  const result = await sendTestNotification(extractRlsContext(c))
  return success(c, result)
})

// T4: the key a browser subscribes to Web Push with. Public by nature (it is
// in every subscription), served to a session only because only a signed-in
// browser registers. Null when the server has no VAPID keys (Web Push off).
notificationDeviceRoutes.get("/web-push/config", (c) => {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() || null
  return success(c, { publicKey })
})

const receiptStatusSchema = z.object({
  ids: z
    .string()
    .transform((v) => v.split(",").filter(Boolean))
    .pipe(z.array(z.string().uuid()).min(1).max(50)),
})

// S6 (T7w): what the "Send me a test" view polls. The caller's OWN receipts
// for the notificationIds the test route answered (an admin's RLS handle sees
// the org's rows, so the user filter is explicit).
notificationDeviceRoutes.get(
  "/receipt-status",
  zValidator("query", receiptStatusSchema),
  async (c) => {
    const userId = c.get("userId")
    const { ids } = c.req.valid("query")
    const rows = await withRequestRls(c, (tx) =>
      tx
        .select({
          notificationId: notificationReceipts.notificationId,
          deviceId: notificationReceipts.deviceId,
          surface: notificationReceipts.surface,
          outcome: notificationReceipts.outcome,
          reason: notificationReceipts.reason,
          at: notificationReceipts.updatedAt,
        })
        .from(notificationReceipts)
        .where(
          and(
            eq(notificationReceipts.userId, userId),
            inArray(notificationReceipts.notificationId, ids),
          ),
        ),
    )
    return success(
      c,
      rows.map((r) => ({ ...r, at: r.at.toISOString() })),
    )
  },
)

notificationDeviceRoutes.get("/devices", async (c) => {
  const userId = c.get("userId")
  const devices = await withRequestRls(c, (tx) => listDevices(tx, userId))
  return success(c, devices)
})

/** Mounted at /api/notifications ahead of the session middleware's reach (see app.ts). */
export const notificationReceiptRoutes = new Hono<AppEnv>()

notificationReceiptRoutes.post("/receipts", zValidator("json", receiptSchema), async (c) => {
  const header = c.req.header("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  const device = token ? await verifyDeviceCredential(token) : null
  if (!device) {
    return c.json({ error: { message: "Invalid device credential", code: "UNAUTHORIZED" } }, 401)
  }
  const body = c.req.valid("json")
  if (body.deviceId !== undefined && body.deviceId !== device.deviceId) {
    return c.json(
      { error: { message: "This credential is for another device", code: "FORBIDDEN" } },
      403,
    )
  }
  const result = await recordReceipt(device, {
    notificationId: body.notificationId,
    outcome: body.outcome,
    ...(body.surface ? { surface: body.surface } : {}),
    ...(body.appState ? { appState: body.appState } : {}),
    ...(body.reason ? { reason: body.reason } : {}),
  })
  if (!result.ok) {
    return c.json(
      { error: { message: "No delivery of this notification to this device", code: "NOT_FOUND" } },
      404,
    )
  }
  return success(c, { notificationId: body.notificationId, outcome: result.outcome })
})
