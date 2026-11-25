// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client access panel's routes, `/api/contacts/companies/:id/portal/*`: a
// person's click, so nothing here parks an approval. Every route needs
// `kernel:portal:admin`, except the shares (`kernel:portal:share`) and the log
// (`kernel:portal:logs`). The preview is GET only: it runs the portal's own reads as
// one of the company's portal people, writes one staff audit row and nothing as the
// client.

import { sql } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { withPortalContext } from "~/db/portal-rls"
import { schemaRef } from "~/db/schema-ref"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import { writeAuditLog } from "~/modules/audit/service"
import { hasScope } from "~/modules/permissions/permissions"
import {
  endPortalAccess,
  invitePortalPerson,
  PORTAL_SHARE_KINDS,
  PortalAccessError,
  readCompany,
  readPortalAccessLog,
  readPortalLogReaders,
  readPortalPerson,
  readPortalRequireTotp,
  readPortalSettings,
  removePortalPerson,
  resetPortalTotp,
  restorePortalAccess,
  setPortalRequireTotp,
  setPortalSettings,
  setPortalShare,
  showWholeCompany,
} from "./access"
import { PORTAL_HOME_READS } from "./routes"
import { agreementShareLabels } from "./tools"

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const K = () => sql.raw(schemaRef("kernel"))

function companyId(c: Context<AppEnv>): string | null {
  const id = c.req.param("id")
  return id && UUID.test(id) ? id : null
}

function fail(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof PortalAccessError) {
    return c.json(
      { error: { code: err.code, message: err.message } },
      err.status as 403 | 404 | 409 | 422 | 429 | 500,
    )
  }
  throw err
}

/** The read scope each preview part needs: a part the previewing member may not read is null. */
const PREVIEW_PART_SCOPES: Record<string, string> = {
  projects: "projects:projects:read",
  invoices: "invoicing:documents:read",
  upcoming: "invoicing:documents:read",
  requests: "tickets:tickets:read",
}

/**
 * Where each row of a part lives (as `r`), read again under the member's own row security.
 * An upcoming billing step counts only when its project is readable too.
 */
const PREVIEW_PART_TABLES: Record<string, string> = {
  projects: `${schemaRef("app_projects")}.projects r`,
  invoices: `${schemaRef("app_invoicing")}.documents r`,
  upcoming: `${schemaRef("app_invoicing")}.billing_steps r
    JOIN ${schemaRef("app_projects")}.projects p ON p.id = r.billing_project_id AND p.org_id = r.org_id`,
  requests: `${schemaRef("app_tickets")}.tickets r`,
}

const notFound = (c: Context<AppEnv>) =>
  c.json({ error: { code: "not_found", message: "Not found" } }, 404)

const inviteSchema = z
  .object({
    contactId: z.string().uuid().optional(),
    email: z.string().email().optional(),
    name: z.string().min(1).max(200).optional(),
    title: z.string().max(200).optional(),
  })
  .refine((p) => Boolean(p.contactId) || Boolean(p.email && p.name))
const shareSchema = z.object({
  kind: z.enum(PORTAL_SHARE_KINDS),
  objectId: z.string().uuid().optional(),
  open: z.boolean(),
  onlyUserIds: z.array(z.string().uuid()).max(50).optional(),
})
const endSchema = z.object({ reason: z.string().max(500).optional() })
const signInSchema = z.object({ requireTotp: z.boolean() })

const ADMIN = requireScope("kernel:portal:admin")

/** The portal person of this company a route names, read under the caller's RLS. */
async function personOfCompany(c: Context<AppEnv>, id: string) {
  const userId = c.req.param("userId")
  if (!userId || !UUID.test(userId)) return null
  const p = await withRequestRls(c, (tx) => readPortalPerson(tx, userId)).catch(() => null)
  return p && p.company_id === id ? p : null
}

export const portalAdminRoutes = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    await next()
  })
  .get("/people", ADMIN, async (c) => {
    const id = companyId(c)
    if (!id) return notFound(c)
    try {
      const people = await withRequestRls(c, async (tx) => {
        await readCompany(tx, id)
        return extractRows<Record<string, unknown>>(
          await tx.execute(sql`
            SELECT p.user_id AS "userId", u.name, u.email, p.title, p.invited_at AS "invitedAt",
                   p.last_sign_in_at AS "lastSignInAt", u.status, u.totp_enabled AS "totpEnabled",
                   (p.sees_only_share_ids IS NOT NULL OR p.sees_only_contact_ids IS NOT NULL) AS "keepsWhatTheySawBefore"
              FROM ${K()}.portal_people p JOIN ${K()}.users u ON u.id = p.user_id
             WHERE p.company_id = ${id} AND p.removed_at IS NULL
             ORDER BY u.name`),
        )
      })
      return success(c, people)
    } catch (err) {
      return fail(c, err)
    }
  })
  .post("/invite", ADMIN, zValidator("json", inviteSchema), async (c) => {
    const id = companyId(c)
    if (!id) return notFound(c)
    const body = c.req.valid("json")
    try {
      const r = await withRequestRls(c, (tx) =>
        invitePortalPerson({
          orgId: c.get("orgId"),
          actorId: c.get("userId"),
          db: tx,
          companyId: id,
          contactId: body.contactId,
          email: body.email,
          name: body.name,
          title: body.title,
        }),
      )
      return success(c, r)
    } catch (err) {
      return fail(c, err)
    }
  })
  // Cancelling an invitation and removing a person are one act: the account stops at once.
  .post("/people/:userId/remove", ADMIN, async (c) => {
    const id = companyId(c)
    if (!id) return notFound(c)
    if (!(await personOfCompany(c, id))) return notFound(c)
    try {
      const r = await withRequestRls(c, (tx) =>
        removePortalPerson({
          orgId: c.get("orgId"),
          actorId: c.get("userId"),
          db: tx,
          userId: c.req.param("userId"),
        }),
      )
      return success(c, { userId: r.person.user_id, cancelledLinks: r.cancelledLinks })
    } catch (err) {
      return fail(c, err)
    }
  })
  // After a merge a person keeps what they read before; a person here clears it for them.
  .post("/people/:userId/show-whole-company", ADMIN, async (c) => {
    const id = companyId(c)
    if (!id) return notFound(c)
    if (!(await personOfCompany(c, id))) return notFound(c)
    const orgId = c.get("orgId")
    const actorId = c.get("userId")
    const userId = c.req.param("userId")
    try {
      const r = await withRequestRls(c, async (tx) => {
        const out = await showWholeCompany({ orgId, actorId, db: tx, userId })
        if (out.widened)
          await writeAuditLog(tx, {
            orgId,
            actorId,
            actorType: "user",
            app: "kernel",
            entityType: "portal_person",
            entityId: userId,
            action: "portal.whole_company_shown",
            metadata: { companyId: id },
          })
        return out
      })
      return success(c, {
        userId,
        widened: r.widened,
        message: r.widened
          ? `${r.person.name} now sees everything the company shares on the portal, not only what they saw before the merge.`
          : `${r.person.name} already sees everything the company shares on the portal. Nothing changed.`,
      })
    } catch (err) {
      return fail(c, err)
    }
  })
  .post("/people/:userId/totp-reset", ADMIN, async (c) => {
    const id = companyId(c)
    if (!id) return notFound(c)
    if (!(await personOfCompany(c, id))) return notFound(c)
    const orgId = c.get("orgId")
    const actorId = c.get("userId")
    const userId = c.req.param("userId")
    try {
      await withRequestRls(c, async (tx) => {
        await resetPortalTotp({ orgId, actorId, db: tx, userId })
        await writeAuditLog(tx, {
          orgId,
          actorId,
          actorType: "user",
          app: "kernel",
          entityType: "portal_person",
          entityId: userId,
          action: "portal.totp_reset",
          metadata: { companyId: id },
        })
      })
      return success(c, { userId, reset: true })
    } catch (err) {
      return fail(c, err)
    }
  })
  // The second step's current setting, for the panel's sign-in options.
  .get("/sign-in", ADMIN, async (c) => {
    const id = companyId(c)
    if (!id) return notFound(c)
    try {
      return success(
        c,
        await withRequestRls(c, (tx) => readPortalRequireTotp({ db: tx, companyId: id })),
      )
    } catch (err) {
      return fail(c, err)
    }
  })
  .post("/sign-in", ADMIN, zValidator("json", signInSchema), async (c) => {
    const id = companyId(c)
    if (!id) return notFound(c)
    try {
      const r = await withRequestRls(c, (tx) =>
        setPortalRequireTotp({
          orgId: c.get("orgId"),
          db: tx,
          companyId: id,
          required: c.req.valid("json").requireTotp,
        }),
      )
      return success(c, r)
    } catch (err) {
      return fail(c, err)
    }
  })
  .post(
    "/shares",
    requireScope("kernel:portal:share"),
    zValidator("json", shareSchema),
    async (c) => {
      const id = companyId(c)
      if (!id) return notFound(c)
      const body = c.req.valid("json")
      try {
        const r = await withRequestRls(c, (tx) =>
          setPortalShare({
            orgId: c.get("orgId"),
            actorId: c.get("userId"),
            db: tx,
            scopes: (c.get("scopes") as string[] | undefined) ?? [],
            companyId: id,
            kind: body.kind,
            objectId: body.objectId ?? null,
            open: body.open,
            onlyUserIds: body.onlyUserIds ?? null,
          }),
        )
        return success(c, r)
      } catch (err) {
        return fail(c, err)
      }
    },
  )
  .get("/shares", requireScope("kernel:portal:share"), async (c) => {
    const id = companyId(c)
    if (!id) return notFound(c)
    const rows = await withRequestRls(c, async (tx) => {
      const shares = extractRows<{ id: string; kind: string; objectId: string | null }>(
        await tx.execute(sql`
          SELECT id, kind, object_id AS "objectId", only_user_ids AS "onlyUserIds",
                 shared_by_user_id AS "sharedBy", shared_at AS "sharedAt"
            FROM ${K()}.portal_shares
           WHERE company_id = ${id} AND closed_at IS NULL
           ORDER BY shared_at`),
      )
      // A shared document is named by its number and title, when this reader can read it.
      const labels = await agreementShareLabels(tx, shares)
      return shares.map((s) => (labels.has(s.id) ? { ...s, label: labels.get(s.id) } : s))
    })
    return success(c, rows)
  })
  .post("/end", ADMIN, zValidator("json", endSchema), async (c) => {
    const id = companyId(c)
    if (!id) return notFound(c)
    try {
      const r = await withRequestRls(c, (tx) =>
        endPortalAccess({
          orgId: c.get("orgId"),
          actorId: c.get("userId"),
          db: tx,
          companyId: id,
          reason: c.req.valid("json").reason ?? null,
        }),
      )
      return success(c, r)
    } catch (err) {
      return fail(c, err)
    }
  })
  .post("/restore", ADMIN, async (c) => {
    const id = companyId(c)
    if (!id) return notFound(c)
    try {
      const r = await withRequestRls(c, (tx) =>
        restorePortalAccess({
          orgId: c.get("orgId"),
          actorId: c.get("userId"),
          db: tx,
          companyId: id,
        }),
      )
      return success(c, r)
    } catch (err) {
      return fail(c, err)
    }
  })
  // Who can read the access log, by name: the panel's "Only <names> can read it".
  .get("/log/readers", ADMIN, async (c) => {
    const id = companyId(c)
    if (!id) return notFound(c)
    try {
      return success(
        c,
        await withRequestRls(c, (tx) =>
          readPortalLogReaders({ orgId: c.get("orgId"), db: tx, companyId: id }),
        ),
      )
    } catch (err) {
      return fail(c, err)
    }
  })
  .get("/log", requireScope("kernel:portal:logs"), async (c) => {
    const id = companyId(c)
    if (!id) return notFound(c)
    const before = c.req.query("before")
    const rows = await withRequestRls(c, (tx) =>
      readPortalAccessLog({
        db: tx,
        companyId: id,
        before: before && !Number.isNaN(Date.parse(before)) ? before : null,
      }),
    )
    return success(c, rows)
  })
  // What one portal person of the company sees, through the portal's own reads.
  .get("/preview/:userId", ADMIN, async (c) => {
    const id = companyId(c)
    if (!id) return notFound(c)
    const person = await personOfCompany(c, id)
    if (!person) return notFound(c)
    const orgId = c.get("orgId")
    const scopes = (c.get("scopes") as string[] | undefined) ?? []
    const parts: Record<string, Record<string, unknown>[] | null> = {}
    const needs: Record<string, string> = {}
    try {
      await withPortalContext({ orgId, userId: person.user_id }, async (tx) => {
        for (const [name, query] of Object.entries(PORTAL_HOME_READS)) {
          const need = PREVIEW_PART_SCOPES[name]
          if (need && !hasScope(need, scopes)) {
            parts[name] = null
            needs[name] = need
            continue
          }
          parts[name] = await tx
            .transaction(async (sp) =>
              extractRows<Record<string, unknown>>(await sp.execute(query())),
            )
            .catch(() => null)
        }
        // Each project's hours line, through the same function the portal's project page calls.
        for (const row of parts.projects ?? []) {
          const [h] = await tx
            .transaction(async (sp) =>
              extractRows<Record<string, unknown>>(
                await sp.execute(sql`SELECT kind, used_minutes::int AS used_minutes,
                  of_minutes::int AS of_minutes, period
                  FROM portal.project_hours(${String(row.id)}::uuid)`),
              ),
            )
            .catch(() => [] as Record<string, unknown>[])
          row.hours = h
            ? {
                kind: h.kind,
                usedMinutes: h.used_minutes,
                ofMinutes: h.of_minutes,
                period: h.period,
              }
            : null
        }
      })
    } catch {
      // The person cannot sign in now (access ended, deactivated): they see nothing.
      return success(c, { userId: person.user_id, signedInWouldSee: null })
    }
    // The preview shows staff nothing their own reads would not: each row is kept only when
    // the previewing member reads its record under their own row security.
    await withRequestRls(c, async (tx) => {
      for (const [name, table] of Object.entries(PREVIEW_PART_TABLES)) {
        const rows = parts[name]
        if (!rows || rows.length === 0) continue
        const ids = rows.map((r) => String(r.id))
        const readable = new Set(
          await tx
            .transaction(async (sp) =>
              extractRows<{ id: string }>(
                await sp.execute(
                  sql`SELECT r.id::text AS id FROM ${sql.raw(table)}
                       WHERE r.id = ANY(${`{${ids.join(",")}}`}::uuid[])`,
                ),
              ).map((r) => r.id),
            )
            .catch(() => [] as string[]),
        )
        parts[name] = rows.filter((r) => readable.has(String(r.id)))
      }
    })
    await withRequestRls(c, (tx) =>
      writeAuditLog(tx, {
        orgId,
        actorId: c.get("userId"),
        actorType: "user",
        app: "kernel",
        entityType: "portal_person",
        entityId: person.user_id,
        action: "portal.preview",
        metadata: { companyId: id },
      }),
    )
    return success(c, {
      userId: person.user_id,
      signedInWouldSee: parts,
      ...(Object.keys(needs).length > 0 ? { hiddenParts: needs } : {}),
    })
  })

const settingsSchema = z
  .object({
    notice: z.string().max(4000).nullable().optional(),
    logRetentionMonths: z.number().int().optional(),
    logRetentionReason: z.string().max(500).optional(),
  })
  .strict()

/** The org's portal settings: the notice clients read at first sign-in, the log's length. */
export const portalSettingsRoutes = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    await next()
  })
  .get("/", ADMIN, async (c) => success(c, await readPortalSettings(c.get("orgId"))))
  .put("/", ADMIN, zValidator("json", settingsSchema), async (c) => {
    try {
      return success(c, await setPortalSettings(c.get("orgId"), c.req.valid("json")))
    } catch (err) {
      return fail(c, err)
    }
  })
