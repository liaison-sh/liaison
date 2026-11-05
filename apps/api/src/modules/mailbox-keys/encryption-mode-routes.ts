// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `/api/mailbox/encryption/*`: how personal mailboxes are encrypted at rest.
//
// - GET  /encryption                    this person's settings (the org switch,
//                                       the deployment default, their pick)
// - PUT  /encryption/preference         their pick for NEW mailboxes
// - PUT  /encryption/policy             the org switch (mail admins only)
// - POST /encryption/accounts/:id/make-private            (start or resume; runs to the end)
// - POST /encryption/accounts/:id/make-transparent         (start, with a step-up; or resume)
// - GET  /encryption/accounts/:id/make-transparent         (progress)
// - GET  /encryption/accounts/:id/make-transparent/pending (what is still private-sealed)
// - POST /encryption/accounts/:id/make-transparent/batch   (browser-opened rows)
// - POST /encryption/accounts/:id/make-transparent/files/:fileId (one opened attachment)
// - POST /encryption/accounts/:id/make-transparent/finish  (flip once nothing is left)
//
// Every action is the mailbox OWNER's own (`mode-switch.ts` re-checks it), and
// each one is audit-logged without content. Starting a move to transparent
// hands the server a private mailbox's content, so it takes a fresh step-up
// (current password or an emailed `mailbox_transparent` code), and every row
// handed back must prove it was opened with the mailbox key (`mode-switch.ts`).

import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { writeAuditLog } from "~/modules/audit/service"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import { assertStepUp } from "~/modules/auth/step-up"
import {
  isMailboxEncryptionMode,
  mailboxEncryptionSettings,
} from "~/modules/mailbox-crypto/encryption-mode"
import {
  applyTransparentBatch,
  applyTransparentFile,
  beginMakeMailboxTransparent,
  finishMakeMailboxTransparent,
  listTransparentPending,
  MailboxModeSwitchError,
  makeMailboxPrivate,
  transparentProgress,
} from "~/modules/mailbox-crypto/mode-switch"
import { PermissionDeniedError } from "~/modules/permissions/errors"
import { hasScope } from "~/modules/permissions/permissions"

/** The org switch is a mail administration setting. */
export const MAILBOX_POLICY_SCOPE = "mail:accounts:admin"
const MAIL_READ_SCOPE = "mail:conversations:read"

const K = () => drizzleSql.raw(`"${schemaRef("kernel")}"`)

function requireMailRead(c: { get(key: "scopes"): unknown }) {
  if (!hasScope(MAIL_READ_SCOPE, c.get("scopes") as string[])) {
    throw new PermissionDeniedError({ missingScope: MAIL_READ_SCOPE })
  }
}

function toHttp(err: unknown): never {
  if (err instanceof MailboxModeSwitchError) {
    const status =
      err.code === "MAILBOX_NOT_FOUND" ? 404 : err.code === "MAILBOX_NOT_OWNER" ? 403 : 409
    throw new HTTPException(status, { message: err.message, cause: err.code })
  }
  throw err
}

const preferenceSchema = z.object({ mode: z.enum(["managed", "private"]) })
const policySchema = z.object({ allowPrivate: z.boolean() })
const MAX_FIELD = 2_000_000
/** A D5 field subkey, base64: 32 bytes. */
const fieldKey = z.string().max(64)
const batchItem = z.object({
  id: z.string().uuid(),
  contentKeyWrapped: z.string().min(1).max(4096),
  subject: z.string().max(MAX_FIELD).nullable().optional(),
  textBody: z.string().max(MAX_FIELD).nullable().optional(),
  htmlBody: z.string().max(MAX_FIELD).nullable().optional(),
  snippet: z.string().max(MAX_FIELD).nullable().optional(),
  rawHeaders: z.string().max(MAX_FIELD).nullable().optional(),
  fieldKeys: z
    .object({
      subject: fieldKey.optional(),
      textBody: fieldKey.optional(),
      htmlBody: fieldKey.optional(),
      snippet: fieldKey.optional(),
      rawHeaders: fieldKey.optional(),
    })
    .optional(),
})
/** Starting the move: the step-up proof. Resuming one under way needs none. */
const beginSchema = z.object({
  currentPassword: z.string().min(1).max(1024).optional(),
  stepUpCode: z
    .string()
    .length(6, "Step-up code must be exactly 6 digits")
    .regex(/^\d+$/, "Step-up code must contain only digits")
    .optional(),
})
const batchSchema = z.object({
  messages: z.array(batchItem).max(50).optional(),
  drafts: z.array(batchItem).max(50).optional(),
  conversations: z.array(batchItem).max(50).optional(),
})
const pendingQuery = z.object({
  entity: z.enum(["messages", "drafts", "conversations", "files"]),
  after: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
/** One attachment, opened by the owner's browser: at most what it may open. */
const MAX_FILE_BYTES = 25 * 1024 * 1024

function accountInput(c: {
  get(key: "orgId"): string
  get(key: "userId"): string
  req: { param(name: "accountId"): string }
}) {
  return {
    orgId: c.get("orgId"),
    userId: c.get("userId"),
    accountId: z.string().uuid().parse(c.req.param("accountId")),
  }
}

export const mailboxEncryptionRoutes = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    assertUnrestrictedSession(c, "change mailbox encryption")
    requireMailRead(c)
    await next()
  })
  .get("/", async (c) => {
    const orgId = c.get("orgId")
    const settings = await withPrivilegedDb(orgId, "mailbox-encryption:settings", (tx) =>
      mailboxEncryptionSettings(tx, orgId, c.get("userId")),
    )
    return success(c, {
      ...settings,
      canSetPolicy: hasScope(MAILBOX_POLICY_SCOPE, c.get("scopes") as string[]),
    })
  })
  .put("/preference", zValidator("json", preferenceSchema), async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const { mode } = c.req.valid("json")
    const settings = await withPrivilegedDb(orgId, "mailbox-encryption:preference", async (tx) => {
      const current = await mailboxEncryptionSettings(tx, orgId, userId)
      if (mode === "private" && !current.allowPrivate) {
        throw new HTTPException(409, {
          message: "PRIVATE_NOT_ALLOWED: your organization does not allow private mailboxes",
        })
      }
      if (mode === "managed" && !current.allowManaged) {
        throw new HTTPException(409, {
          message: "MANAGED_NOT_ALLOWED: this deployment keeps every mailbox private",
        })
      }
      if (!isMailboxEncryptionMode(mode)) throw new HTTPException(400)
      await tx.execute(drizzleSql`
        UPDATE ${K()}.users
           SET settings = jsonb_set(
             COALESCE(settings, '{}'::jsonb), '{mail}',
             COALESCE(settings -> 'mail', '{}'::jsonb) || ${JSON.stringify({ encryptionPreference: mode })}::jsonb,
             true)
         WHERE id = ${userId}::uuid AND org_id = ${orgId}::uuid`)
      await writeAuditLog(tx, {
        orgId,
        actorId: userId,
        actorType: "user",
        app: "mail",
        entityType: "users",
        entityId: userId,
        action: "mail.encryption.preference",
        changes: { encryptionPreference: mode },
      })
      return mailboxEncryptionSettings(tx, orgId, userId)
    })
    return success(c, settings)
  })
  .put("/policy", zValidator("json", policySchema), async (c) => {
    if (!hasScope(MAILBOX_POLICY_SCOPE, c.get("scopes") as string[])) {
      throw new PermissionDeniedError({ missingScope: MAILBOX_POLICY_SCOPE })
    }
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const { allowPrivate } = c.req.valid("json")
    const settings = await withPrivilegedDb(orgId, "mailbox-encryption:policy", async (tx) => {
      // Turning it off changes NEW mailboxes only: every existing private
      // mailbox stays private, nobody is downgraded.
      await tx.execute(drizzleSql`
        UPDATE ${K()}.organizations
           SET settings = jsonb_set(
             COALESCE(settings, '{}'::jsonb), '{mail}',
             COALESCE(settings -> 'mail', '{}'::jsonb) || ${JSON.stringify({ allowPrivateMailboxes: allowPrivate })}::jsonb,
             true)
         WHERE id = ${orgId}::uuid`)
      await writeAuditLog(tx, {
        orgId,
        actorId: userId,
        actorType: "user",
        app: "mail",
        entityType: "organizations",
        entityId: orgId,
        action: "mail.encryption.policy",
        changes: { allowPrivateMailboxes: allowPrivate },
      })
      return mailboxEncryptionSettings(tx, orgId, userId)
    })
    return success(c, settings)
  })
  .post("/accounts/:accountId/make-private", async (c) => {
    const input = accountInput(c)
    const result = await makeMailboxPrivate(input).catch(toHttp)
    await withPrivilegedDb(c.get("orgId"), "mailbox-encryption:audit", (tx) =>
      writeAuditLog(tx, {
        orgId: input.orgId,
        actorId: input.userId,
        actorType: "user",
        app: "mail",
        entityType: "accounts",
        entityId: input.accountId,
        action: "mail.encryption.made_private",
        metadata: { ...result },
      }),
    )
    return success(c, result)
  })
  .post("/accounts/:accountId/make-transparent", async (c) => {
    const input = accountInput(c)
    const proof = beginSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!proof.success) {
      throw new HTTPException(400, { message: "Provide currentPassword or stepUpCode" })
    }
    const confirmStepUp = async (tx: PrivilegedDb) => {
      const [user] = await tx
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(and(eq(users.id, input.userId), eq(users.orgId, input.orgId)))
        .limit(1)
      if (!user) throw new HTTPException(404, { message: "User not found" })
      await assertStepUp(input.userId, user.passwordHash, proof.data, "mailbox_transparent")
    }
    await beginMakeMailboxTransparent({ ...input, confirmStepUp }).catch(toHttp)
    await withPrivilegedDb(c.get("orgId"), "mailbox-encryption:audit", (tx) =>
      writeAuditLog(tx, {
        orgId: input.orgId,
        actorId: input.userId,
        actorType: "user",
        app: "mail",
        entityType: "accounts",
        entityId: input.accountId,
        action: "mail.encryption.make_transparent_started",
      }),
    )
    return success(c, await transparentProgress(input).catch(toHttp))
  })
  .get("/accounts/:accountId/make-transparent", async (c) => {
    return success(c, await transparentProgress(accountInput(c)).catch(toHttp))
  })
  .get(
    "/accounts/:accountId/make-transparent/pending",
    zValidator("query", pendingQuery),
    async (c) => {
      const query = c.req.valid("query")
      return success(
        c,
        await listTransparentPending({
          ...accountInput(c),
          entity: query.entity,
          after: query.after,
          limit: query.limit,
        }).catch(toHttp),
      )
    },
  )
  .post(
    "/accounts/:accountId/make-transparent/batch",
    zValidator("json", batchSchema),
    async (c) => {
      const result = await applyTransparentBatch({
        ...accountInput(c),
        batch: c.req.valid("json"),
      }).catch(toHttp)
      return success(c, result)
    },
  )
  .post("/accounts/:accountId/make-transparent/files/:fileId", async (c) => {
    const fileId = z.string().uuid().parse(c.req.param("fileId"))
    // The content key the browser opened, so a stale copy is refused.
    const contentKeyWrapped = c.req.query("ck") ?? ""
    if (!contentKeyWrapped || contentKeyWrapped.length > 4096) {
      throw new HTTPException(400, { message: "ck (the opened file's content key) is required" })
    }
    // The D5 subkey the browser opened the file with: the server writes the
    // bytes only when they re-seal to the stored object under it.
    const streamKey = c.req.query("fk") ?? ""
    if (!streamKey || streamKey.length > 128) {
      throw new HTTPException(400, { message: "fk (the opened file's field key) is required" })
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new HTTPException(413, { message: "attachment too large to convert here" })
    }
    const result = await applyTransparentFile({
      ...accountInput(c),
      fileId,
      contentKeyWrapped,
      fieldKey: streamKey,
      bytes,
    }).catch(toHttp)
    return success(c, result)
  })
  .post("/accounts/:accountId/make-transparent/finish", async (c) => {
    const input = accountInput(c)
    const result = await finishMakeMailboxTransparent(input).catch(toHttp)
    if (result.done) {
      await withPrivilegedDb(c.get("orgId"), "mailbox-encryption:audit", (tx) =>
        writeAuditLog(tx, {
          orgId: input.orgId,
          actorId: input.userId,
          actorType: "user",
          app: "mail",
          entityType: "accounts",
          entityId: input.accountId,
          action: "mail.encryption.made_transparent",
        }),
      )
    }
    return success(c, result)
  })
