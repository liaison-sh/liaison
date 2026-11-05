// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, desc, sql as drizzleSql, eq } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { agents, threadParticipants, timelineEntries, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { withRequestRls } from "~/lib/request-rls"
import { paginated } from "~/lib/response"
import { entityRegistry } from "~/modules/apps/app-registries"
import { resolveParent } from "~/modules/files/service"
import { hasScope } from "~/modules/permissions/permissions"

export const timeline = new Hono<AppEnv>()

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/i

/**
 * The table behind a timeline entity, taken from what the app declared: its
 * `fileParent` (schema, table, key) or its entity table name in the app's own
 * schema. Names are checked as plain identifiers before they reach SQL.
 */
function resolveTimelineEntityTable(
  orgId: string,
  appName: string,
  entityType: string,
): { schema: string; table: string; joinOn: string } | null {
  const candidates = [entityType, `${entityType}s`, entityType.replace(/s$/, "")]
  for (const name of candidates) {
    const parent = resolveParent(orgId, appName, name)
    if (parent && SAFE_IDENT.test(parent.tableName)) {
      const joinOn = SAFE_IDENT.test(parent.joinOn) ? parent.joinOn : "id"
      return { schema: schemaRef(parent.schemaRef), table: parent.tableName, joinOn }
    }
  }
  if (appName === "kernel") return null
  for (const name of candidates) {
    const entity = entityRegistry.get([orgId, appName, name])
    if (entity?.tableName && SAFE_IDENT.test(entity.tableName)) {
      return {
        schema: schemaRef(`app_${appName.replace(/-/g, "_")}`),
        table: entity.tableName,
        joinOn: "id",
      }
    }
  }
  return null
}

timeline.get("/:app/:entityType/:entityId", async (c) => {
  const appName = c.req.param("app")
  const entityType = c.req.param("entityType")
  const entityId = c.req.param("entityId")
  const orgId = c.get("orgId")
  const scopes = c.get("scopes")
  const page = Math.max(1, Math.floor(Number(c.req.query("page") ?? 1)) || 1)
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100)
  const offset = (page - 1) * limit

  // Validate URL params are safe identifiers
  if (!/^[a-z][a-z0-9_-]*$/i.test(appName) || !/^[a-z][a-z0-9_-]*$/i.test(entityType)) {
    throw new HTTPException(400, { message: "Invalid app or entity type" })
  }
  if (!/^[a-z0-9_-]{1,128}$/i.test(entityId)) {
    throw new HTTPException(400, { message: "Invalid entity id" })
  }

  // Check read scope for the app entity.
  // Scope convention uses plural resource names (e.g. kernel:threads:read), but timeline
  // entity types are singular (e.g. "thread"). Pluralize for scope lookup.
  const scopeResource = entityType.endsWith("s") ? entityType : `${entityType}s`
  const requiredScope = `${appName}:${scopeResource}:read`
  if (!hasScope(requiredScope, scopes)) {
    throw new HTTPException(403, { message: "Forbidden" })
  }

  // For thread entities, verify the user is a participant (scope alone is insufficient)
  if (appName === "kernel" && entityType === "thread") {
    const userId = c.get("userId")
    const [participant] = await withRequestRls(c, (tx) =>
      tx
        .select({ id: threadParticipants.id })
        .from(threadParticipants)
        .where(
          and(
            eq(threadParticipants.threadId, entityId),
            eq(threadParticipants.userId, userId),
            eq(threadParticipants.orgId, orgId),
          ),
        )
        .limit(1),
    )
    if (!participant) throw new HTTPException(404, { message: "Not found" })
  }

  if (appName === "mail" && entityType === "conversation") {
    const rows = await withRequestRls(c, async (tx) =>
      extractRows(
        await tx.execute(drizzleSql`
        SELECT id FROM app_mail.conversations
        WHERE id = ${entityId} AND org_id = ${orgId}
        LIMIT 1
      `),
      ),
    )
    if (rows.length === 0) throw new HTTPException(404, { message: "Not found" })
  }

  // Every other timeline entity: the scope above says the caller may read this
  // KIND of record, not this record. Load the entity through the caller's own
  // RLS (the team / sensitivity / ACL policies live there) before returning its
  // history, so a ticket outside the caller's dimension grants has no readable
  // timeline either. Thread and mail conversation were handled above.
  const handled =
    (appName === "kernel" && entityType === "thread") ||
    (appName === "mail" && entityType === "conversation")
  if (!handled) {
    const target = resolveTimelineEntityTable(orgId, appName, entityType)
    // An app entity whose table cannot be resolved has no row-level source to
    // check its visibility against: refuse rather than return its history.
    // (Kernel entities without a table mapping, such as a user, are org-wide.)
    if (!target && appName !== "kernel") {
      throw new HTTPException(404, { message: "Not found" })
    }
    if (target) {
      const visible = await withRequestRls(c, async (tx) => {
        const exists = extractRows<{ reg: string | null }>(
          await tx.execute(
            drizzleSql`SELECT to_regclass(${`${target.schema}.${target.table}`})::text AS reg`,
          ),
        )
        // A declared table the database does not have: nothing proves the
        // caller may see this record, so it is not shown.
        if (!exists[0]?.reg) return false
        const schema = drizzleSql.raw(`"${target.schema}"`)
        const table = drizzleSql.raw(`"${target.table}"`)
        const column = drizzleSql.raw(`"${target.joinOn}"`)
        const found = extractRows(
          await tx.execute(
            drizzleSql`SELECT 1 FROM ${schema}.${table} WHERE ${column}::text = ${entityId} LIMIT 1`,
          ),
        )
        return found.length > 0
      })
      if (!visible) throw new HTTPException(404, { message: "Not found" })
    }
  }

  const conditions = and(
    eq(timelineEntries.orgId, orgId),
    eq(timelineEntries.app, appName),
    eq(timelineEntries.entityType, entityType),
    eq(timelineEntries.entityId, entityId),
  )

  // Single query: window function provides total count alongside each row
  const rows = await withRequestRls(c, (tx) =>
    tx
      .select({
        id: timelineEntries.id,
        orgId: timelineEntries.orgId,
        app: timelineEntries.app,
        entityType: timelineEntries.entityType,
        entityId: timelineEntries.entityId,
        action: timelineEntries.action,
        actorId: timelineEntries.actorId,
        actorType: timelineEntries.actorType,
        summary: timelineEntries.summary,
        fieldChanges: timelineEntries.fieldChanges,
        createdAt: timelineEntries.createdAt,
        // Who did it, by name: the person, else the agent; null for a system
        // change. A reader shown only `actorId` printed "Unknown created".
        actorName: drizzleSql<string | null>`COALESCE(${users.name}, ${agents.displayName})`,
        total: drizzleSql<number>`COUNT(*) OVER ()::int`,
      })
      .from(timelineEntries)
      .leftJoin(users, and(eq(users.id, timelineEntries.actorId), eq(users.orgId, orgId)))
      .leftJoin(agents, and(eq(agents.id, timelineEntries.actorId), eq(agents.orgId, orgId)))
      .where(conditions)
      .orderBy(desc(timelineEntries.createdAt))
      .limit(limit)
      .offset(offset),
  )

  const total = rows[0]?.total ?? 0
  const entries = rows.map(({ total: _total, ...rest }) => rest)

  return paginated(c, entries, { page, limit, total })
})
