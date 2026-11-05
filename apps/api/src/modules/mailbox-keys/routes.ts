// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mailbox keyring REST surface (spec section 6.3).
//
// Every route here is owner scoped and carries no app scope: a user's own key
// material is not something an org role grants access to. Ownership is enforced
// by RLS on the four kernel tables, so these handlers are thin.
//
// The wrap LISTING and the wrap BLOB are deliberately separate routes. The
// listing is metadata; the blob is a wrapped Account Key, which is an offline
// cracking oracle at passphrase KDF speed. Returning blobs from the listing would
// hand an attacker who briefly holds a session every oracle in one call, so the
// blob is fetched one named wrap at a time and rate limited.

import { totpStepUpSchema } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { users } from "~/db/schema/kernel"
import { redis } from "~/lib/redis"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { writeAuditLog } from "~/modules/audit/service"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import { assertStepUp } from "~/modules/auth/step-up"
import * as ackVerify from "~/modules/mailbox-crypto/ack-verify"
import {
  enqueueResyncForReadyMailboxes,
  MailboxNotEnrolledError,
  resetMailbox,
} from "~/modules/mailbox-keys/reset"
import * as service from "~/modules/mailbox-keys/service"
import * as syncCursor from "~/modules/mailbox-keys/sync-cursor"
import { PermissionDeniedError } from "~/modules/permissions/errors"
import { hasScope } from "~/modules/permissions/permissions"

/** Base64, and short enough that a body cannot become a memory event. */
const b64 = z
  .string()
  .min(1)
  .max(64 * 1024)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64")

const keyIdSchema = z.number().int().min(0).max(255)

// Only the wrap types a client may still create: a `recovery_phrase` wrap is no
// longer generated or offered anywhere, so the API refuses a new one.
const wrapSchema = z.object({
  wrapType: z.enum(service.NEW_WRAP_TYPES),
  label: z.string().max(200).nullish(),
  credentialId: b64.nullish(),
  wrappedAccountKey: b64,
  kdfParams: z.record(z.string(), z.unknown()).nullish(),
  verifier: b64.nullish(),
})

// The four wrapped-private fields are OPTIONAL on the wire and required in
// practice. They are optional because a client older than migration 0041 does
// not send them and must still be able to enrol; they are what a fresh browser
// profile rebuilds the keyring from, so a client that omits them is choosing a
// keyring that dies with its browser. Zod strips unknown keys, so leaving them
// out of this schema silently discarded them, which is exactly how the loss
// happened in the first place.
const keyringSchema = z.object({
  ecdhPublicKey: b64,
  signPublicKey: b64,
  keyId: keyIdSchema,
  attestation: b64,
  wrappedEcdhPrivate: b64.nullish(),
  wrappedSignPrivate: b64.nullish(),
  ecdhWrapIv: b64.nullish(),
  signWrapIv: b64.nullish(),
})

const enrollSchema = keyringSchema.extend({ wraps: z.array(wrapSchema).min(1).max(10) })

// A rotation also carries the step-up proof (current password, or the emailed
// code), exactly one of them.
const rotateSchema = keyringSchema
  .extend({
    currentPassword: z.string().min(1).optional(),
    stepUpCode: z
      .string()
      .length(6, "Step-up code must be exactly 6 digits")
      .regex(/^\d+$/, "Step-up code must contain only digits")
      .optional(),
  })
  .refine((d) => d.currentPassword !== undefined || d.stepUpCode !== undefined, {
    message: "Provide currentPassword or stepUpCode",
  })

/**
 * The scope that reaches a user's own mailbox key material and sealed mail: the
 * scope to read mail at all. A token without it (a narrow-scope token, a
 * service token) has no business with the keyring.
 */
export const MAILBOX_KEYS_SCOPE = "mail:conversations:read"

/**
 * Every route on this surface hands out or changes key material (wrap blobs, the
 * keyring, the sealed listing, the cutover proof), so none is reachable from a
 * restricted device session (a token minted for a narrow job) and all need the
 * mail scope. Ownership of the rows is still enforced by RLS.
 */
const mailboxSessionGuard = createMiddleware<AppEnv>(async (c, next) => {
  assertUnrestrictedSession(c, "use the mailbox keys")
  if (!hasScope(MAILBOX_KEYS_SCOPE, c.get("scopes") as string[])) {
    throw new PermissionDeniedError({ missingScope: MAILBOX_KEYS_SCOPE })
  }
  await next()
})

/**
 * Unlock-time fetches of a wrapped Account Key. The cap is per user, not per
 * IP: the thing being protected is one user's offline oracle.
 */
const WRAP_BLOB_LIMIT = 20
const WRAP_BLOB_WINDOW_SECONDS = 60

async function guardUserRate(
  identifier: string,
  limit: number,
  windowSeconds: number,
  refusal: string,
): Promise<void> {
  let result: Awaited<ReturnType<typeof checkRateLimit>>
  try {
    result = await checkRateLimit(redis, [{ identifier, limit, windowSeconds }])
  } catch {
    // Fail closed, as the shared limiter middleware does: an unavailable
    // limiter must not become an unlimited oracle.
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }
  if (!result.allowed) {
    throw new HTTPException(429, { message: refusal })
  }
}

async function guardWrapBlobRate(userId: string): Promise<void> {
  await guardUserRate(
    `mailbox-wrap-blob:${userId}`,
    WRAP_BLOB_LIMIT,
    WRAP_BLOB_WINDOW_SECONDS,
    "Too many unlock attempts",
  )
}

/**
 * The mailbox reset destroys the user's own data, so it is guarded like the
 * other destructive self-service actions (TOTP setup and disable): a per-user
 * rate limit, and a step-up re-confirmation (current password, or a code
 * emailed by `POST /api/auth/totp/step-up`). A stolen session alone cannot wipe
 * someone's mailbox. The limit also caps guessing of the 6-digit emailed code.
 */
const RESET_LIMIT = 5
const RESET_WINDOW_SECONDS = 3600

export const mailboxKeysRoutes = new Hono<AppEnv>()
mailboxKeysRoutes.use("*", mailboxSessionGuard)

/** Mailboxes whose import could not be queued now (the sweep retries them), for the client. */
function importDeferredMeta(resync: { deferred: string[] }): Record<string, unknown> | undefined {
  return resync.deferred.length > 0 ? { importDeferredAccountIds: resync.deferred } : undefined
}

mailboxKeysRoutes.post("/enroll", zValidator("json", enrollSchema), async (c) => {
  const body = c.req.valid("json")
  const result = await withRequestRls(c, (tx) =>
    service.enrollKeyring(tx, c.get("userId"), c.get("orgId"), body),
  )
  // After the commit: a mailbox that was reset is now armed to the new key and
  // waiting at `pre-sync`, so its import starts here rather than on the next
  // stranded-sync sweep.
  const resync = await enqueueResyncForReadyMailboxes(c.get("userId"), c.get("orgId"))
  return success(c, result.keyring, importDeferredMeta(resync), result.created ? 201 : 200)
})

/**
 * Forgot the mailbox password: delete the keyring and every encrypted copy of
 * the caller's personal mail, keep the connection, and let the mailbox
 * re-download after the next enrollment. See `reset.ts` for exactly what goes
 * and what stays. Owner scoped by construction: the user and org come from the
 * session, never from the body.
 */
mailboxKeysRoutes.post("/reset", zValidator("json", totpStepUpSchema), async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  await guardUserRate(
    `mailbox-reset:${userId}`,
    RESET_LIMIT,
    RESET_WINDOW_SECONDS,
    "Too many mailbox reset attempts",
  )
  // The caller's own row, read as the caller (kernel.users is org readable).
  const [user] = await withRequestRls(c, (db) =>
    db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
      .limit(1),
  )
  if (!user) throw new HTTPException(404, { message: "User not found" })
  await assertStepUp(userId, user.passwordHash, c.req.valid("json"), "mailbox_reset")
  try {
    const result = await resetMailbox(userId, orgId)
    return success(c, result)
  } catch (err) {
    if (err instanceof MailboxNotEnrolledError) {
      throw new HTTPException(409, { message: err.message })
    }
    throw err
  }
})

// Re-arm a suspended personal mailbox for an owner who already has keys. The
// wizard has nothing to do for such an owner and the enroll route needs a
// keyring payload, so this is the one call the "Set up encryption" action can
// make when the keys exist.
mailboxKeysRoutes.post("/arm", async (c) => {
  const result = await withRequestRls(c, (tx) =>
    service.armMailboxes(tx, c.get("userId"), c.get("orgId")),
  )
  const resync = await enqueueResyncForReadyMailboxes(c.get("userId"), c.get("orgId"))
  return success(c, result, importDeferredMeta(resync))
})

mailboxKeysRoutes.get("/me", async (c) => {
  const keyring = await withRequestRls(c, (tx) =>
    service.getKeyring(tx, c.get("userId"), c.get("orgId")),
  )
  return success(c, keyring)
})

mailboxKeysRoutes.get("/wraps/:id/blob", async (c) => {
  await guardWrapBlobRate(c.get("userId"))
  const blob = await withRequestRls(c, (tx) =>
    service.getWrapBlob(tx, c.get("userId"), c.get("orgId"), c.req.param("id")),
  )
  // 404 for both "no such wrap" and "not yours". A 403 with a body would turn
  // this route into an existence oracle over another user's key material.
  if (!blob) throw new HTTPException(404, { message: "wrap not found" })
  return success(c, blob)
})

mailboxKeysRoutes.post("/wraps", zValidator("json", wrapSchema), async (c) => {
  const wrap = await withRequestRls(c, (tx) =>
    service.addWrap(tx, c.get("userId"), c.get("orgId"), c.req.valid("json")),
  )
  return success(c, wrap, undefined, 201)
})

mailboxKeysRoutes.delete("/wraps/:id", async (c) => {
  await withRequestRls(c, (tx) =>
    service.deleteWrap(tx, c.get("userId"), c.get("orgId"), c.req.param("id")),
  )
  return success(c, { deleted: true })
})

/**
 * Rotating the identity changes the key every future message is sealed to, so a
 * stolen session must not be able to do it alone: it needs the step-up proof
 * (like the mailbox reset), a rate limit, and an attestation that verifies under
 * the CURRENT signing key (so only the holder of the keyring can authorise its
 * successor; see `service.rotateIdentity`).
 */
mailboxKeysRoutes.post("/rotate", zValidator("json", rotateSchema), async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  await guardUserRate(
    `mailbox-rotate:${userId}`,
    RESET_LIMIT,
    RESET_WINDOW_SECONDS,
    "Too many key rotation attempts",
  )
  const { currentPassword, stepUpCode, ...keyring } = c.req.valid("json")
  const [user] = await withRequestRls(c, (db) =>
    db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
      .limit(1),
  )
  if (!user) throw new HTTPException(404, { message: "User not found" })
  await assertStepUp(userId, user.passwordHash, { currentPassword, stepUpCode }, "mailbox_rotate")
  const identity = await withRequestRls(c, async (tx) => {
    const rotated = await service.rotateIdentity(tx, userId, orgId, keyring)
    await writeAuditLog(
      tx,
      {
        orgId,
        actorId: userId,
        actorType: "user",
        app: "kernel",
        entityType: "mailbox",
        entityId: userId,
        action: "mailbox_identity_rotated",
        metadata: { keyId: keyring.keyId },
      },
      { required: true },
    )
    return rotated
  })
  return success(c, identity, undefined, 201)
})

/**
 * The browser's downgrade alarm lives on the DEVICE and only the device can
 * clear it, after the owner proves the mailbox secret there again. This route
 * is the other half: it RECORDS that a clear happened, which findings it
 * covered and who did it, so an admin or support can see it in the audit
 * trail. It clears nothing and has nothing to clear: the server never holds
 * the alarm.
 */
const ALARM_CLEARED_LIMIT = 20
const ALARM_CLEARED_WINDOW_SECONDS = 3600

const alarmClearedSchema = z.object({
  findings: z
    .array(
      z.object({
        kind: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z][a-z-]*$/, "must be a finding kind"),
        subject: z.string().min(1).max(200),
        detectedAt: z.string().max(64).nullish(),
      }),
    )
    .min(1)
    .max(1000),
})

mailboxKeysRoutes.post(
  "/integrity-alarm-cleared",
  zValidator("json", alarmClearedSchema),
  async (c) => {
    const userId = c.get("userId")
    const orgId = c.get("orgId")
    await guardUserRate(
      `mailbox-alarm-cleared:${userId}`,
      ALARM_CLEARED_LIMIT,
      ALARM_CLEARED_WINDOW_SECONDS,
      "Too many integrity warning clears",
    )
    const { findings } = c.req.valid("json")
    const clearedAt = new Date().toISOString()
    await withRequestRls(c, (tx) =>
      writeAuditLog(
        tx,
        {
          orgId,
          actorId: userId,
          actorType: "user",
          app: "kernel",
          entityType: "mailbox",
          entityId: userId,
          action: "mailbox_integrity_alarm_cleared",
          // Kinds and ids only: a finding names a message, never its content.
          metadata: {
            clearedAt,
            count: findings.length,
            kinds: [...new Set(findings.map((finding) => finding.kind))],
            findings: findings.map((finding) => ({
              kind: finding.kind,
              subject: finding.subject,
              detectedAt: finding.detectedAt ?? null,
            })),
          },
        },
        // The browser clears only once this row exists, so a write that did
        // not land must fail the request rather than answer 200.
        { required: true },
      ),
    )
    return success(c, { recorded: true, clearedAt })
  },
)

export const mailboxRoutes = new Hono<AppEnv>()
mailboxRoutes.use("*", mailboxSessionGuard)

mailboxRoutes.get("/migration-state", async (c) => {
  const state = await withRequestRls(c, (tx) =>
    service.getMigrationState(tx, c.get("userId"), c.get("orgId")),
  )
  return success(c, state)
})

/**
 * The sealed listing (spec section 5.5, section 6.3). Ciphertext plus the
 * cleartext envelope, owner scoped. The server has no key, so what it returns
 * here is opaque to it.
 *
 * `mode=verify` additionally returns the plaintext half and drops the
 * `enc_version > 0` filter, because the migration sweep must cover the exact
 * row set the acknowledgement digest covers. See `sync-cursor.ts` for why the
 * two modes cannot be collapsed into one.
 */
mailboxRoutes.get("/sync-cursor", async (c) => {
  const page = await withRequestRls(c, (tx) =>
    syncCursor.listSealedMessages(
      tx as unknown as syncCursor.SyncCursorExecutor,
      c.get("userId"),
      c.get("orgId"),
      {
        mode: syncCursor.parseSyncCursorMode(c.req.query("mode")),
        cursor: c.req.query("cursor") ?? null,
        limit: syncCursor.parseSyncCursorLimit(c.req.query("limit")),
        ids: syncCursor.parseSyncCursorIds(c.req.query("ids")),
      },
    ),
  )
  return success(c, page)
})

// ── The cutover proof (blueprint Task 12.3) ──────────────────────────────────
//
// The server cannot check its own backfill: no plaintext and no
// plaintext-derived value may cross to it, so there is deliberately no
// server-computed HMAC of plaintext here and there must never be one. The
// client walks every message, compares both representations byte for byte, and
// signs a statement over a digest of the id set; the server re-derives that
// digest over the exact rows it holds and checks the signature.

mailboxRoutes.post("/verify-nonce", async (c) => {
  const issued = await withRequestRls(c, (tx) =>
    ackVerify.issueVerifyNonce(
      tx as unknown as ackVerify.AckSqlExecutor,
      c.get("userId"),
      c.get("orgId"),
    ),
  )
  return success(c, issued)
})

const verifyDecryptSchema = z.object({
  accountId: z.string().uuid(),
  keyId: keyIdSchema,
  nonce: z.string().min(1).max(512),
  count: z.number().int().min(0).max(10_000_000),
  idSetDigest: b64,
  signature: b64,
  backfillCursor: z.string().max(64 * 1024),
})

mailboxRoutes.post("/verify-decrypt", zValidator("json", verifyDecryptSchema), async (c) => {
  const body = c.req.valid("json")
  try {
    const result = await withRequestRls(c, async (rlsTx) => {
      const tx = rlsTx as unknown as ackVerify.AckSqlExecutor
      const { digest } = await ackVerify.verifyMailboxAck(
        tx,
        c.get("userId"),
        c.get("orgId"),
        body.accountId,
        body,
      )
      const verifiedAt = await ackVerify.recordVerifiedAck(
        tx,
        c.get("userId"),
        body.accountId,
        body,
        digest,
      )
      return { verified: true as const, verifiedAt, count: body.count }
    })
    return success(c, result)
  } catch (err) {
    if (err instanceof ackVerify.MailboxAckError) {
      // 409, not 400: the request is well formed, the PROOF is not good enough.
      // The code is surfaced so the client can say which check failed.
      throw new HTTPException(409, { message: err.message, cause: err.code })
    }
    throw err
  }
})
