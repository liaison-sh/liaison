// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Devices, receipt-only credentials and receipts (S1, S3, A3, A7, F1).
 *
 * A device is an iOS push token row (`push_tokens.id` is its device id), a
 * desktop app install (`desktop_devices`) or a browser profile
 * (`browser_push_subscriptions`). Each gets a receipt-only credential when it
 * registers: an opaque token stored hashed, bound to (user, org, device,
 * server origin), able to write receipts for its own device and nothing else.
 * One credential is live per device: issuing another (re-registration)
 * revokes the previous one, and so do logout and deleting the device.
 *
 * A receipt takes its user, org and device from the credential, never the
 * body; it is refused (404) unless a delivery row exists for that
 * (notificationId, device); and it upserts under the precedence
 * suppressed > shown > received (A3), so a late `received` never downgrades.
 */
import { createHash, randomBytes } from "node:crypto"
import { and, eq, isNull, ne, or, sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  browserPushSubscriptions,
  type CredentialSurface,
  desktopDevices,
  notificationDeviceCredentials,
  pushTokens,
  type ReceiptOutcome,
} from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"

const K = sql.raw(schemaRef("kernel"))

/** Prefix of a receipt credential: recognisable in a log, never a session token. */
const CREDENTIAL_PREFIX = "lnr_"

/** The origin this server is reached at; a credential is valid on it only (A7). */
export function currentServerOrigin(): string {
  try {
    return new URL(env.BASE_URL).origin
  } catch {
    return env.BASE_URL
  }
}

function hashCredential(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export interface DeviceIdentity {
  orgId: string
  userId: string
  deviceId: string
}

/**
 * Mint a credential for one device, revoking any earlier live one (rotation).
 * Returns the opaque token; only its hash is stored.
 */
export async function issueDeviceCredential(
  device: DeviceIdentity & { surface: CredentialSurface },
): Promise<string> {
  const token = `${CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`
  await withPrivilegedDb(device.orgId, "notifications:credential-issue", async (tx) => {
    await tx
      .update(notificationDeviceCredentials)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(notificationDeviceCredentials.orgId, device.orgId),
          eq(notificationDeviceCredentials.userId, device.userId),
          eq(notificationDeviceCredentials.deviceId, device.deviceId),
          isNull(notificationDeviceCredentials.revokedAt),
        ),
      )
    await tx.insert(notificationDeviceCredentials).values({
      orgId: device.orgId,
      userId: device.userId,
      deviceId: device.deviceId,
      surface: device.surface,
      tokenHash: hashCredential(token),
      serverOrigin: currentServerOrigin(),
    })
  })
  return token
}

/** Revoke every live credential of one device (logout, device deletion). */
export async function revokeDeviceCredentials(device: DeviceIdentity): Promise<void> {
  await withPrivilegedDb(device.orgId, "notifications:credential-revoke", (tx) =>
    tx
      .update(notificationDeviceCredentials)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(notificationDeviceCredentials.orgId, device.orgId),
          eq(notificationDeviceCredentials.userId, device.userId),
          eq(notificationDeviceCredentials.deviceId, device.deviceId),
          isNull(notificationDeviceCredentials.revokedAt),
        ),
      ),
  )
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A PHONE SIGNING OUT OF A SERVER IT IS NOT LOOKING AT: its push row goes with
 * the session. A phone keeps receiving from every server it is signed in to,
 * so removing a server it is not currently on has no bearer for the DELETE on
 * /api/push/tokens; the logout it does send names the device (the push row's
 * id), and that row is the caller's own by the session that just ended. Any
 * other id (a desktop install's `d.<hex>`, a browser profile) matches nothing.
 */
export async function forgetPushDevice(device: DeviceIdentity): Promise<void> {
  if (!UUID.test(device.deviceId)) return
  await withPrivilegedDb(device.orgId, "notifications:push-device-forget", (tx) =>
    tx
      .delete(pushTokens)
      .where(
        and(
          eq(pushTokens.orgId, device.orgId),
          eq(pushTokens.userId, device.userId),
          eq(pushTokens.id, device.deviceId),
        ),
      ),
  )
}

/**
 * A PHONE'S PUSH TOKEN BELONGS TO WHOEVER IS SIGNED IN ON IT NOW. The phone app
 * holds one session per server, so when a user registers a token every other
 * user's row for that token on this server (any org) is a session on that
 * handset that has ended, whether or not its sign-out ever reached the server:
 * a logout lost to the network or a redeploy, an app killed mid sign-out, a
 * refresh token refused. Left in place, that row keeps every notification for
 * the signed-out account landing on the lock screen of a phone now signed into
 * someone else. Those rows go, with their receipt credentials, in one
 * transaction. The browser endpoint has the same rule (registerBrowserDevice).
 */
export async function claimPushToken(device: {
  orgId: string
  userId: string
  platform: "ios" | "android"
  token: string
}): Promise<void> {
  await withPrivilegedDb(device.orgId, "notifications:push-token-claim", async (tx) => {
    const taken = await tx
      .delete(pushTokens)
      .where(
        and(
          eq(pushTokens.platform, device.platform),
          eq(pushTokens.token, device.token),
          ne(pushTokens.userId, device.userId),
        ),
      )
      .returning({ orgId: pushTokens.orgId, userId: pushTokens.userId, id: pushTokens.id })
    for (const prev of taken) {
      await tx
        .update(notificationDeviceCredentials)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(notificationDeviceCredentials.orgId, prev.orgId),
            eq(notificationDeviceCredentials.userId, prev.userId),
            eq(notificationDeviceCredentials.deviceId, prev.id),
            isNull(notificationDeviceCredentials.revokedAt),
          ),
        )
    }
  })
}

/** A browser's Web Push subscription as it registers (null: in-tab only). */
export interface BrowserPushKeys {
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * Register a browser profile of the caller, with its Web Push subscription
 * (`push` undefined keeps the stored one, null clears it).
 *
 * A PUSH ENDPOINT BELONGS TO ONE USER (fix2-F1). A browser keeps its
 * subscription across sessions, so a session that ended without a sign-out
 * (a rejected refresh token, a closed tab) leaves the endpoint on the previous
 * user's row; the next user registering it would otherwise share it, and the
 * previous user's notifications would keep reaching this browser. So, in the
 * same transaction, every OTHER row holding the endpoint (any user, any org)
 * loses it and that row's browser credential is revoked, before this row
 * takes it. The unique index on `endpoint` (0123) is the backstop.
 */
export async function registerBrowserDevice(
  device: DeviceIdentity & { push: BrowserPushKeys | null | undefined; userAgent?: string },
): Promise<void> {
  const push =
    device.push === undefined
      ? undefined
      : {
          endpoint: device.push?.endpoint ?? null,
          p256dh: device.push?.p256dh ?? null,
          auth: device.push?.auth ?? null,
        }
  await withPrivilegedDb(device.orgId, "notifications:browser-register", async (tx) => {
    if (push?.endpoint) {
      const taken = await tx
        .update(browserPushSubscriptions)
        .set({ endpoint: null, p256dh: null, auth: null })
        .where(
          and(
            eq(browserPushSubscriptions.endpoint, push.endpoint),
            or(
              ne(browserPushSubscriptions.userId, device.userId),
              ne(browserPushSubscriptions.deviceId, device.deviceId),
            ),
          ),
        )
        .returning({
          orgId: browserPushSubscriptions.orgId,
          userId: browserPushSubscriptions.userId,
          deviceId: browserPushSubscriptions.deviceId,
        })
      for (const prev of taken) {
        await tx
          .update(notificationDeviceCredentials)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(notificationDeviceCredentials.orgId, prev.orgId),
              eq(notificationDeviceCredentials.userId, prev.userId),
              eq(notificationDeviceCredentials.deviceId, prev.deviceId),
              eq(notificationDeviceCredentials.surface, "browser"),
              isNull(notificationDeviceCredentials.revokedAt),
            ),
          )
      }
    }
    await tx
      .insert(browserPushSubscriptions)
      .values({
        orgId: device.orgId,
        userId: device.userId,
        deviceId: device.deviceId,
        endpoint: push?.endpoint ?? null,
        p256dh: push?.p256dh ?? null,
        auth: push?.auth ?? null,
        userAgent: device.userAgent,
      })
      .onConflictDoUpdate({
        target: [browserPushSubscriptions.userId, browserPushSubscriptions.deviceId],
        set: {
          ...(push !== undefined ? push : {}),
          ...(device.userAgent !== undefined ? { userAgent: device.userAgent } : {}),
          lastSeenAt: new Date(),
        },
      })
  })
}

/** The device a presented credential speaks for, or null (unknown, revoked, other origin). */
export async function verifyDeviceCredential(
  token: string,
): Promise<(DeviceIdentity & { surface: CredentialSurface }) | null> {
  if (!token.startsWith(CREDENTIAL_PREFIX) || token.length > 200) return null
  const [row] = await withSystemDb("notifications:credential-verify", (db) =>
    db
      .select({
        orgId: notificationDeviceCredentials.orgId,
        userId: notificationDeviceCredentials.userId,
        deviceId: notificationDeviceCredentials.deviceId,
        surface: notificationDeviceCredentials.surface,
        serverOrigin: notificationDeviceCredentials.serverOrigin,
        revokedAt: notificationDeviceCredentials.revokedAt,
      })
      .from(notificationDeviceCredentials)
      .where(eq(notificationDeviceCredentials.tokenHash, hashCredential(token)))
      .limit(1),
  )
  if (!row || row.revokedAt !== null) return null
  if (row.serverOrigin !== currentServerOrigin()) return null
  return { orgId: row.orgId, userId: row.userId, deviceId: row.deviceId, surface: row.surface }
}

/**
 * Is `deviceId` a device of the caller on that surface? Read through the
 * caller's own RLS handle, so another user's device is simply not there.
 */
export async function ownsDevice(
  tx: RlsClient,
  surface: CredentialSurface,
  deviceId: string,
): Promise<boolean> {
  if (surface === "ios" || surface === "android") {
    if (!/^[0-9a-f-]{36}$/i.test(deviceId)) return false
    const rows = await tx
      .select({ id: pushTokens.id })
      .from(pushTokens)
      .where(and(eq(pushTokens.id, deviceId), eq(pushTokens.platform, surface)))
      .limit(1)
    return rows.length > 0
  }
  const table = surface === "desktop" ? desktopDevices : browserPushSubscriptions
  const rows = await tx
    .select({ id: table.id })
    .from(table)
    .where(eq(table.deviceId, deviceId))
    .limit(1)
  return rows.length > 0
}

export interface ReceiptInput {
  notificationId: string
  surface?: string
  appState?: string
  outcome: ReceiptOutcome
  reason?: string
}

export type ReceiptResult = { ok: true; outcome: ReceiptOutcome } | { ok: false; status: 404 }

/**
 * Record one receipt for the credential's device. 404 when no delivery row
 * exists for (notificationId, device) of this user; otherwise upsert under
 * suppressed > shown > received and answer the stored outcome.
 */
export async function recordReceipt(
  device: DeviceIdentity,
  input: ReceiptInput,
): Promise<ReceiptResult> {
  return withPrivilegedDb(device.orgId, "notifications:receipt", async (tx) => {
    const delivered = (await tx.execute(sql`
      SELECT surface FROM ${K}.notification_deliveries
       WHERE notification_id = ${input.notificationId}
         AND device_id = ${device.deviceId}
         AND user_id = ${device.userId}
         AND org_id = ${device.orgId}
       ORDER BY attempted_at DESC
       LIMIT 1`)) as unknown as Array<{ surface: string | null }>
    if (delivered.length === 0) return { ok: false, status: 404 } as const
    const surface = input.surface ?? delivered[0]?.surface ?? null
    await tx.execute(sql`
      INSERT INTO ${K}.notification_receipts AS r
        (org_id, user_id, notification_id, device_id, surface, app_state, outcome, reason)
      VALUES (${device.orgId}, ${device.userId}, ${input.notificationId}, ${device.deviceId},
              ${surface}, ${input.appState ?? null}, ${input.outcome}, ${input.reason ?? null})
      ON CONFLICT (notification_id, device_id) DO UPDATE
        SET outcome = EXCLUDED.outcome,
            reason = EXCLUDED.reason,
            app_state = COALESCE(EXCLUDED.app_state, r.app_state),
            surface = COALESCE(EXCLUDED.surface, r.surface),
            updated_at = now()
        WHERE (CASE EXCLUDED.outcome WHEN 'suppressed' THEN 3 WHEN 'shown' THEN 2 ELSE 1 END)
            > (CASE r.outcome WHEN 'suppressed' THEN 3 WHEN 'shown' THEN 2 ELSE 1 END)`)
    const [stored] = (await tx.execute(sql`
      SELECT outcome FROM ${K}.notification_receipts
       WHERE notification_id = ${input.notificationId} AND device_id = ${device.deviceId}
         AND org_id = ${device.orgId} AND user_id = ${device.userId}`)) as unknown as Array<{
      outcome: ReceiptOutcome
    }>
    return { ok: true, outcome: (stored?.outcome ?? input.outcome) as ReceiptOutcome } as const
  })
}

export interface DeviceListEntry {
  deviceId: string
  surface: "ios" | "android" | "desktop" | "browser"
  /** Platform details the Settings view shows. */
  detail: {
    environment?: string
    os?: string | null
    appVersion?: string | null
    reportedPermission?: string | null
    webPush?: boolean
    userAgent?: string | null
  }
  lastSeenAt: string
  lastDelivery: {
    notificationId: string
    channel: string
    surface: string | null
    result: string
    reason: string | null
    attemptedAt: string
  } | null
  lastReceipt: {
    notificationId: string
    outcome: string
    reason: string | null
    at: string
  } | null
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

/** The caller's devices on every surface (S3), read through their RLS handle. */
export async function listDevices(tx: RlsClient, userId: string): Promise<DeviceListEntry[]> {
  const tokens = await tx
    .select({
      id: pushTokens.id,
      platform: pushTokens.platform,
      environment: pushTokens.environment,
      lastSeenAt: pushTokens.lastSeenAt,
    })
    .from(pushTokens)
    .where(eq(pushTokens.userId, userId))
  const desktops = await tx.select().from(desktopDevices).where(eq(desktopDevices.userId, userId))
  const browsers = await tx
    .select()
    .from(browserPushSubscriptions)
    .where(eq(browserPushSubscriptions.userId, userId))

  const entries: Array<Omit<DeviceListEntry, "lastDelivery" | "lastReceipt">> = [
    ...tokens.map((t) => ({
      deviceId: t.id,
      surface: t.platform,
      detail: { environment: t.environment },
      lastSeenAt: iso(t.lastSeenAt),
    })),
    ...desktops.map((d) => ({
      deviceId: d.deviceId,
      surface: "desktop" as const,
      detail: { os: d.os, appVersion: d.appVersion, reportedPermission: d.reportedPermission },
      lastSeenAt: iso(d.lastSeenAt),
    })),
    ...browsers.map((b) => ({
      deviceId: b.deviceId,
      surface: "browser" as const,
      detail: { webPush: b.endpoint !== null, userAgent: b.userAgent },
      lastSeenAt: iso(b.lastSeenAt),
    })),
  ]
  if (entries.length === 0) return []
  const ids = entries.map((e) => e.deviceId)
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )
  const deliveries = (await tx.execute(sql`
    SELECT DISTINCT ON (device_id) device_id, notification_id, channel, surface, result, reason, attempted_at
      FROM ${K}.notification_deliveries
     WHERE user_id = ${userId} AND device_id IN (${idList})
     ORDER BY device_id, attempted_at DESC`)) as unknown as Array<{
    device_id: string
    notification_id: string
    channel: string
    surface: string | null
    result: string
    reason: string | null
    attempted_at: unknown
  }>
  const receipts = (await tx.execute(sql`
    SELECT DISTINCT ON (device_id) device_id, notification_id, outcome, reason, updated_at
      FROM ${K}.notification_receipts
     WHERE user_id = ${userId} AND device_id IN (${idList})
     ORDER BY device_id, updated_at DESC`)) as unknown as Array<{
    device_id: string
    notification_id: string
    outcome: string
    reason: string | null
    updated_at: unknown
  }>
  const lastDelivery = new Map(deliveries.map((d) => [d.device_id, d]))
  const lastReceipt = new Map(receipts.map((r) => [r.device_id, r]))
  return entries.map((e) => {
    const d = lastDelivery.get(e.deviceId)
    const r = lastReceipt.get(e.deviceId)
    return {
      ...e,
      lastDelivery: d
        ? {
            notificationId: d.notification_id,
            channel: d.channel,
            surface: d.surface,
            result: d.result,
            reason: d.reason,
            attemptedAt: iso(d.attempted_at),
          }
        : null,
      lastReceipt: r
        ? {
            notificationId: r.notification_id,
            outcome: r.outcome,
            reason: r.reason,
            at: iso(r.updated_at),
          }
        : null,
    }
  })
}
