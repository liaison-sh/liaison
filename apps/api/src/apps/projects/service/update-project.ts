// SPDX-License-Identifier: FSL-1.1-ALv2
// Edit a project's own fields: name, description, icon, colour, key, group and
// the checklist-on-cards switch. One writer for the REST PATCH and the agent's
// `update_project` tool, so both refuse with the same codes.
//
// The key is the prefix of every task's display key (ERB-12) and of every
// mention and link written with one, so it changes only while the project has
// no task at all: a trashed task counts, since a restore brings its key back.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { describeDbError } from "~/lib/transient-db-error"
import {
  loadProjectDetail,
  normalizeExplicitProjectKey,
  normalizeProjectGroup,
  type ProjectDetail,
} from "./create-project"
import { ProjectsServiceError } from "./statuses"

export interface UpdateProjectPatch {
  name?: string
  description?: string | null
  icon?: string | null
  color?: string | null
  key?: string
  /** Sidebar group heading: trimmed, "" or null clears it. */
  group?: string | null
  checklistOnCards?: boolean
}

export interface UpdateProjectArgs {
  tx: RlsClient
  orgId: string
  projectId: string
  actor: UserContext
  patch: UpdateProjectPatch
  /** The event's actor type: "agent" when the agent tool made the edit. */
  actorType?: "user" | "agent"
}

/** Does the project hold any task row, live or in the trash? */
export async function projectHasTasks(
  tx: RlsClient,
  orgId: string,
  projectId: string,
): Promise<boolean> {
  const rows = extractRows<{ one: number }>(
    await tx.execute(drizzleSql`
      SELECT 1 AS one FROM ${projectsRel("tasks")}
      WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  return rows.length > 0
}

export async function updateProject(args: UpdateProjectArgs): Promise<ProjectDetail> {
  const { tx, orgId, projectId, actor, patch } = args
  return tx.transaction(async (innerTx) => {
    const rows = extractRows<{ id: string; key: string | null; archived_at: Date | string | null }>(
      await innerTx.execute(drizzleSql`
        SELECT id, key, archived_at FROM ${projectsRel("projects")}
        WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
        LIMIT 1
        FOR UPDATE
      `),
    )
    const row = rows[0]
    if (!row) throw new ProjectsServiceError(404, "not_found", "project not found")
    if (row.archived_at) {
      throw new ProjectsServiceError(409, "project_archived", "project is archived")
    }
    if (patch.name !== undefined && patch.name.trim().length === 0) {
      throw new ProjectsServiceError(400, "invalid_params", "name must not be empty")
    }
    let normalizedGroup: string | null | undefined
    try {
      normalizedGroup = normalizeProjectGroup(patch.group)
    } catch (err) {
      throw new ProjectsServiceError(400, "invalid_group", String((err as Error)?.message ?? err))
    }
    const sets: ReturnType<typeof drizzleSql>[] = []
    if (patch.name !== undefined) sets.push(drizzleSql`name = ${patch.name.trim()}`)
    if (patch.description !== undefined) sets.push(drizzleSql`description = ${patch.description}`)
    if (patch.icon !== undefined) sets.push(drizzleSql`icon = ${patch.icon}`)
    if (patch.color !== undefined) sets.push(drizzleSql`color = ${patch.color}`)
    if (normalizedGroup !== undefined) sets.push(drizzleSql`"group" = ${normalizedGroup}`)
    if (patch.checklistOnCards !== undefined) {
      sets.push(drizzleSql`checklist_on_cards = ${patch.checklistOnCards}`)
    }
    let normalizedKey: string | undefined
    if (patch.key !== undefined) {
      try {
        normalizedKey = normalizeExplicitProjectKey(patch.key)
      } catch (err) {
        throw new ProjectsServiceError(
          400,
          "invalid_project_key",
          String((err as Error)?.message ?? err),
        )
      }
      if (normalizedKey !== row.key) {
        if (await projectHasTasks(innerTx as RlsClient, orgId, projectId)) {
          throw new ProjectsServiceError(
            409,
            "project_key_locked",
            "the key cannot change once the project has tasks: every task key and link is built on it",
            { key: row.key },
          )
        }
        sets.push(drizzleSql`key = ${normalizedKey}`)
      }
    }
    sets.push(drizzleSql`updated_at = now()`)
    const setSql = sets.reduce<ReturnType<typeof drizzleSql> | null>(
      (acc, frag) => (acc === null ? frag : drizzleSql`${acc}, ${frag}`),
      null,
    )
    try {
      await innerTx.execute(drizzleSql`
        UPDATE ${projectsRel("projects")}
        SET ${setSql}
        WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      `)
    } catch (err) {
      const { code, message: causeMessage } = describeDbError(err)
      const isKeyCollision =
        code === "23505" && !!causeMessage?.includes("app_projects_org_key_uidx")
      if (normalizedKey && isKeyCollision) {
        throw new ProjectsServiceError(
          409,
          "project_key_taken",
          `key ${JSON.stringify(normalizedKey)} is already in use by another project`,
        )
      }
      throw err
    }
    await innerTx.queueEvent({
      app: "projects",
      entity: "project",
      action: "updated",
      entityId: projectId,
      data: {
        id: projectId,
        ...patch,
        ...(normalizedKey !== undefined ? { key: normalizedKey } : {}),
        ...(normalizedGroup !== undefined ? { group: normalizedGroup } : {}),
      },
      actorId: actor.userId,
      actorType: args.actorType ?? "user",
      orgId,
    })
    return loadProjectDetail(innerTx as RlsClient, orgId, projectId)
  })
}
