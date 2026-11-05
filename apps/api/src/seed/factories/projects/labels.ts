// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The labels factory: the org's task label groups and their values, through
// the projects app's own `createLabel`, then a few tasks' own values through
// `resolveLabelInput` / `applyTaskLabels`, the functions the task write path
// uses. Everything runs on an RLS transaction as a person who holds the labels
// admin scope; no privileged write.
//
// Idempotent: a group or a value already there (same name, same parent) is
// adopted, and a task that already holds a value for a group keeps it, so a
// re-run writes no row.
import { sql } from "drizzle-orm"
import { createLabel, LABELS_ADMIN_SCOPE, loadLabelRows } from "~/apps/projects/service/labels"
import { applyTaskLabels, resolveLabelInput } from "~/apps/projects/service/task-labels"
import type { UserContext } from "~/db/rls"
import { hasScope } from "~/modules/permissions/permissions"
import type { SeedContext } from "~/seed/context"
import { asUser, rowsOf } from "~/seed/factories/people/actors"

export interface LabelGroupSpec {
  name: string
  values: string[]
}

export interface TaskLabelSpec {
  /** The task's external reference (UNIQUE per org). */
  externalRef: string
  /** Group name to value name. */
  labels: Record<string, string>
}

export interface SeedLabelsResult {
  /** Every group and value id, created or adopted. */
  labelIds: string[]
  /** The tasks that hold at least one of the specified values. */
  labelledTaskIds: string[]
}

/** Whether this person may manage the org's labels. */
export function canManageLabels(actor: UserContext): boolean {
  return hasScope(LABELS_ADMIN_SCOPE, actor.scopes ?? [])
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Seed the label groups, then each task's values. A task that is not there is skipped. */
export async function seedTaskLabels(
  ctx: SeedContext,
  admin: UserContext,
  input: { groups: LabelGroupSpec[]; tasks: TaskLabelSpec[] },
): Promise<SeedLabelsResult> {
  const { orgId } = ctx
  if (!canManageLabels(admin)) {
    throw new Error(`labels seed: the acting person lacks ${LABELS_ADMIN_SCOPE}`)
  }
  const labelIds: string[] = []
  const labelledTaskIds: string[] = []
  await asUser(admin, async (tx) => {
    for (const group of input.groups) {
      const rows = await loadLabelRows(tx, orgId)
      const existing = rows.find((r) => r.parent_id === null && sameName(r.name, group.name))
      const groupId =
        existing?.id ??
        (await createLabel({ tx, orgId, actor: admin, input: { name: group.name } })).id
      labelIds.push(groupId)
      for (const value of group.values) {
        const now = await loadLabelRows(tx, orgId)
        const found = now.find((r) => r.parent_id === groupId && sameName(r.name, value))
        const valueId =
          found?.id ??
          (
            await createLabel({
              tx,
              orgId,
              actor: admin,
              input: { name: value, parentId: groupId },
            })
          ).id
        labelIds.push(valueId)
      }
    }

    for (const task of input.tasks) {
      const [row] = rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM app_projects.tasks
              WHERE org_id = ${orgId} AND external_ref = ${task.externalRef} LIMIT 1`,
        ),
      )
      if (!row) continue
      const held = new Set(
        rowsOf<{ group_id: string }>(
          await tx.execute(
            sql`SELECT group_id FROM app_projects.task_labels
                WHERE org_id = ${orgId}::uuid AND task_id = ${row.id}::uuid`,
          ),
        ).map((r) => r.group_id),
      )
      const resolved = (await resolveLabelInput(tx, orgId, task.labels)) ?? []
      const missing = resolved.filter((a) => !held.has(a.groupId))
      if (missing.length > 0) await applyTaskLabels(tx, orgId, row.id, missing)
      labelledTaskIds.push(row.id)
    }
  })
  ctx.log(`labels: ${labelIds.length} labels, ${labelledTaskIds.length} labelled tasks`)
  return { labelIds, labelledTaskIds }
}
