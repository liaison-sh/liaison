// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A project's typed task fields. The definitions are the dashboard table column shape
// (modules/dashboards/tables/columns.ts, imported as is: one set of rules for a table cell and a
// task value), stored on the project (`projects.task_fields`); a task's values live in
// `tasks.fields` as {key: cell}.
//
// A definition taken off the project stays as a tombstone (`removed: true`): the tasks keep their
// values, reads stop returning them, and putting the key back restores them. Because values carry
// no type, a definition change is checked against the values the tasks hold: a type (or link
// target) they no longer fit is refused (`field_type_in_use`), and so is a choice option still in
// use (`choice_in_use`) unless `renames` maps it to a kept option, rewritten in the same
// transaction.
//
// Link values follow the dashboard tables' rule: a reader who may not open the linked app sees the
// link with the label "Linked record" (dashboards/tables/service.ts, visibleCells).
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import { advisoryXactLock, advisoryXactLockShared } from "~/db/advisory-lock"
import type { UserContext } from "~/db/rls"
import {
  CellError,
  type Column,
  columnsSchema,
  type LinkCell,
  normalizeCell,
  personIdsIn,
  validateCells,
} from "~/modules/dashboards/tables/columns"
import { ensureProjectMutableForTasks } from "./move-task"
import { ProjectsServiceError } from "./statuses"

/** The label a reader sees on a link to an app they may not open (dashboards/tables/service.ts). */
export const HIDDEN_LINK_LABEL = "Linked record"

/** A stored definition: an active column, or a tombstone of one taken off the project. */
export type ProjectField = Column & { removed?: boolean }

type Db = RlsClient | RlsTx

/** The stored list as written (tolerant: anything malformed is skipped, never thrown). */
export function parseStoredFields(raw: unknown): ProjectField[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (f): f is ProjectField =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as { key?: unknown }).key === "string" &&
      typeof (f as { type?: unknown }).type === "string",
  )
}

/** The project's active field definitions, in order (tombstones left out). */
export function activeFields(defs: readonly ProjectField[]): Column[] {
  return defs.filter((f) => f.removed !== true).map(({ removed: _removed, ...col }) => col)
}

/**
 * Serializes a project's definition changes against its value writes. A value write (a task
 * create, a field update, a move into the project) takes the shared lock before it reads the
 * definitions; `setFields` takes the exclusive one before it reads the values the tasks hold. So
 * a write validated against definitions `setFields` is replacing commits first (and `setFields`
 * then sees its value), or reads the new definitions. Transaction-scoped.
 */
export async function lockProjectFields(
  tx: Db,
  projectId: string,
  mode: "write-values" | "change-definitions",
): Promise<void> {
  const name = `projects:task-fields:${projectId}`
  await tx.execute(
    mode === "change-definitions" ? advisoryXactLock(name) : advisoryXactLockShared(name),
  )
}

/** Every stored definition of a project (tombstones included). */
export async function readProjectFields(
  tx: Db,
  orgId: string,
  projectId: string,
): Promise<ProjectField[]> {
  const [row] = extractRows<{ task_fields: unknown }>(
    await tx.execute(drizzleSql`
      SELECT task_fields FROM ${projectsRel("projects")}
      WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
    `),
  )
  if (!row) throw new ProjectsServiceError(404, "not_found", "project not found")
  return parseStoredFields(row.task_fields)
}

/** A refused value as the projects error: 422 naming the field. */
export function fieldError(err: CellError): ProjectsServiceError {
  if (err.reason === "is not a column of this table") {
    return new ProjectsServiceError(
      422,
      "unknown_field",
      `field '${err.column}' is not a field of this project`,
      { field: err.column },
    )
  }
  return new ProjectsServiceError(422, "invalid_field", `field '${err.column}' ${err.reason}`, {
    field: err.column,
  })
}

/** The active org members among `ids` (lowercased), the set a person value must belong to. */
async function activeMembers(tx: Db, orgId: string, ids: string[]): Promise<Set<string>> {
  const uuids = ids.filter((id) => /^[0-9a-f-]{36}$/.test(id))
  if (uuids.length === 0) return new Set()
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${kernelRel("users")}
      WHERE org_id = ${orgId}::uuid AND status = 'active'
        AND id IN (${drizzleSql.join(
          uuids.map((id) => drizzleSql`${id}::uuid`),
          drizzleSql`, `,
        )})
    `),
  )
  return new Set(rows.map((r) => r.id.toLowerCase()))
}

/**
 * Checks a task's field values against the project's active fields: unknown keys refused, each
 * value by its type, a person by active membership. `full` (an interactive or agent create) also
 * requires every required field. Returns the values as stored; null means "empty this field".
 */
export async function validateTaskFields(
  tx: Db,
  orgId: string,
  defs: readonly ProjectField[],
  input: unknown,
  opts: { full: boolean },
): Promise<Record<string, unknown>> {
  const columns = activeFields(defs)
  try {
    const raw =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {}
    const members = await activeMembers(tx, orgId, personIdsIn(columns, raw))
    return validateCells(columns, input, { full: opts.full, members })
  } catch (err) {
    if (err instanceof CellError) {
      if (err.column === "*") {
        throw new ProjectsServiceError(
          422,
          "invalid_field",
          "fields are an object {fieldKey: value}",
        )
      }
      throw fieldError(err)
    }
    throw err
  }
}

/** May the reader open records of `app` (a link value's label is theirs to see)? */
export function seesApp(scopes: readonly string[], app: string): boolean {
  if (app === "kernel") return true
  return scopes.some((s) => s === "*" || s === app || s.startsWith(`${app}:`))
}

/**
 * The values a reader sees: the project's active fields only, in definition order; a link to an
 * app the reader may not open carries the hidden label. `scopes` null = no reader to filter for.
 */
export function visibleTaskFields(
  defs: readonly ProjectField[],
  stored: unknown,
  scopes: readonly string[] | null,
): Record<string, unknown> {
  const data =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {}
  const out: Record<string, unknown> = {}
  for (const col of activeFields(defs)) {
    const v = data[col.key]
    if (v === undefined || v === null) continue
    if (col.type === "link" && scopes !== null && typeof v === "object") {
      const link = v as LinkCell
      out[col.key] = seesApp(scopes, link.app) ? link : { ...link, label: HIDDEN_LINK_LABEL }
    } else out[col.key] = v
  }
  return out
}

/**
 * A copy of `values` ({key: cell}) where every link value (the only object cells) to an app the
 * reader may not open carries the hidden label. For values read without their definitions: a
 * template snapshot, an event payload.
 */
export function maskLinkCells(
  values: Record<string, unknown>,
  scopes: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) {
    const app =
      typeof v === "object" && v !== null && !Array.isArray(v)
        ? (v as { app?: unknown }).app
        : undefined
    out[k] =
      typeof app === "string" && !seesApp(scopes, app)
        ? { ...(v as Record<string, unknown>), label: HIDDEN_LINK_LABEL }
        : v
  }
  return out
}

/** Does any active link field hold a value in these rows (so the reader's scopes matter)? */
export function needsReaderScopes(defs: readonly ProjectField[], stored: unknown[]): boolean {
  const links = activeFields(defs).filter((c) => c.type === "link")
  if (links.length === 0) return false
  return stored.some(
    (s) =>
      typeof s === "object" &&
      s !== null &&
      links.some((c) => (s as Record<string, unknown>)[c.key] != null),
  )
}

/** The reader's session scopes, as the RLS context was given them (fails closed). */
export async function readerScopes(tx: Db): Promise<string[]> {
  const [row] = extractRows<{ scopes: string | null }>(
    await tx.execute(drizzleSql`SELECT rls_ctx.scopes() AS scopes`),
  )
  const raw = row?.scopes ?? ""
  return raw === "" || raw === "__none__" ? [] : raw.split(",")
}

export interface SetFieldsArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  projectId: string
  /** The full new list of active definitions, in order (replace-all). */
  fields: unknown
  /** Choice options renamed: {fieldKey: {oldOption: newOption}}; the values are rewritten. */
  renames?: Record<string, Record<string, string>> | null
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** The choice options a stored value uses (for a choice or choices field). */
function optionsIn(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string")
  return []
}

function renameValue(col: Column, value: unknown, map: Record<string, string>): unknown {
  if (col.type === "choice" && typeof value === "string") return map[value] ?? value
  if (col.type === "choices" && Array.isArray(value)) {
    const out: unknown[] = []
    for (const v of value) {
      const next = typeof v === "string" ? (map[v] ?? v) : v
      if (!out.includes(next)) out.push(next)
    }
    return out
  }
  return value
}

/**
 * Replaces a project's field definitions. Definitions left out become tombstones (their values
 * stay, hidden). Refuses, before anything is written: an invalid list (422 `invalid_fields`), a
 * definition the values tasks already hold no longer fit (422 `field_type_in_use`), a choice
 * option still used (422 `choice_in_use`) unless renamed. Returns the active definitions.
 */
export async function setFields(args: SetFieldsArgs): Promise<Column[]> {
  const { tx, orgId, actor, projectId } = args
  const parsed = columnsSchema.safeParse(args.fields)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.length ? ` (${issue.path.join(".")})` : ""
    throw new ProjectsServiceError(
      422,
      "invalid_fields",
      `${issue?.message ?? "invalid field list"}${path}`,
    )
  }
  const next: Column[] = parsed.data
  const renames = args.renames ?? {}
  for (const [key, map] of Object.entries(renames)) {
    const col = next.find((c) => c.key === key)
    if (!col || (col.type !== "choice" && col.type !== "choices")) {
      throw new ProjectsServiceError(
        422,
        "invalid_fields",
        `renames names '${key}', which is not a choice field of the new list`,
        { field: key },
      )
    }
    for (const [from, to] of Object.entries(map)) {
      if (typeof to !== "string" || !(col.choices ?? []).includes(to)) {
        throw new ProjectsServiceError(
          422,
          "invalid_fields",
          `renames maps '${from}' of '${key}' to '${String(to)}', which is not one of its choices`,
          { field: key },
        )
      }
    }
  }

  return tx.transaction(async (innerTx) => {
    await ensureProjectMutableForTasks(innerTx, orgId, projectId)
    await lockProjectFields(innerTx, projectId, "change-definitions")
    const current = await readProjectFields(innerTx, orgId, projectId)
    // Every value the project's tasks hold (binned tasks too: they can be restored).
    const held = extractRows<{ id: string; fields: Record<string, unknown> | null }>(
      await innerTx.execute(drizzleSql`
        SELECT id, fields FROM ${projectsRel("tasks")}
        WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid AND fields <> '{}'::jsonb
      `),
    )
    const rewritten = new Map<string, Record<string, unknown>>()
    for (const col of next) {
      const map = renames[col.key]
      const before = current.find((f) => f.key === col.key)
      // Unchanged active definition: nothing the tasks hold can stop fitting it. A tombstone put
      // back is checked: while it was off the project, a move could bring in values it never saw.
      if (
        before &&
        before.removed !== true &&
        !map &&
        sameJson(activeFields([{ ...before, removed: false }])[0], col)
      ) {
        continue
      }
      const persons = new Set<string>()
      for (const row of held) {
        const v = row.fields?.[col.key]
        if (typeof v === "string") persons.add(v.toLowerCase())
      }
      const unfit: string[] = []
      const unknownOptions = new Set<string>()
      for (const row of held) {
        const stored = row.fields ?? {}
        if (!(col.key in stored) || stored[col.key] === null) continue
        let value = stored[col.key]
        if (map) {
          const renamed = renameValue(col, value, map)
          if (!sameJson(renamed, value)) {
            value = renamed
            const cur = rewritten.get(row.id) ?? { ...stored }
            cur[col.key] = renamed
            rewritten.set(row.id, cur)
          }
        }
        try {
          // A person value's membership is checked when it is written, not here: a person who
          // has left keeps their value.
          normalizeCell(col, value, persons)
        } catch {
          if (col.type === "choice" || col.type === "choices") {
            const sameKind = !before || before.type === col.type
            if (sameKind) {
              for (const o of optionsIn(value)) {
                if (!(col.choices ?? []).includes(o)) unknownOptions.add(o)
              }
              if (optionsIn(value).length > 0) continue
            }
          }
          unfit.push(row.id)
        }
      }
      if (unknownOptions.size > 0) {
        const options = [...unknownOptions].sort()
        throw new ProjectsServiceError(
          422,
          "choice_in_use",
          `field '${col.key}': tasks still use ${options.map((o) => `'${o}'`).join(", ")}; keep the option or rename it to a kept one (renames)`,
          { field: col.key, options },
        )
      }
      if (unfit.length > 0) {
        throw new ProjectsServiceError(
          422,
          "field_type_in_use",
          `field '${col.key}': ${unfit.length} task(s) hold values that are not ${col.type}${before ? ` (it was ${before.type})` : ""}; empty them first`,
          { field: col.key, taskCount: unfit.length },
        )
      }
    }
    for (const [taskId, fields] of rewritten) {
      await innerTx.execute(drizzleSql`
        UPDATE ${projectsRel("tasks")}
        SET fields = ${JSON.stringify(fields)}::jsonb, updated_at = now()
        WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid
      `)
    }
    const nextKeys = new Set(next.map((c) => c.key))
    const tombstones: ProjectField[] = current
      .filter((f) => !nextKeys.has(f.key))
      .map((f) => ({ ...f, removed: true }))
    const stored: ProjectField[] = [...next, ...tombstones]
    await innerTx.execute(drizzleSql`
      UPDATE ${projectsRel("projects")}
      SET task_fields = ${JSON.stringify(stored)}::jsonb, updated_at = now()
      WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
    `)
    await innerTx.queueEvent({
      app: "projects",
      entity: "project",
      action: "updated",
      entityId: projectId,
      data: { id: projectId, changedFields: ["fields"], fields: next },
      actorId: actor.userId,
      actorType: "user",
      orgId,
    })
    return next
  })
}

/**
 * Where a cross-project move puts the values the destination declares a field they do not fit.
 * Not a valid field key (keys start with a letter), so it never collides with one.
 */
export const HIDDEN_FIELDS_KEY = "_hidden"

const fitsField = (col: Column, value: unknown): boolean => {
  try {
    // Membership is checked on write, not on a move: any person id string fits.
    normalizeCell(col, value, new Set(typeof value === "string" ? [value.toLowerCase()] : []))
    return true
  } catch {
    return false
  }
}

/**
 * A task's stored values as they go into another project: a value the destination declares a
 * field it does not fit is put aside under HIDDEN_FIELDS_KEY (and one put aside earlier comes
 * back when it fits); keys the destination does not declare stay as they are. A tombstone of the
 * destination counts as a declaration: putting the field back must never surface a value it does
 * not fit. `hidden` lists the keys the destination does not show.
 */
export function fieldsForProject(
  stored: Record<string, unknown>,
  target: readonly ProjectField[],
): { fields: Record<string, unknown>; hidden: string[] } {
  const asideRaw = stored[HIDDEN_FIELDS_KEY]
  const aside: Record<string, unknown> =
    typeof asideRaw === "object" && asideRaw !== null && !Array.isArray(asideRaw)
      ? { ...(asideRaw as Record<string, unknown>) }
      : {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(stored)) if (k !== HIDDEN_FIELDS_KEY) out[k] = v
  const byKey = new Map(
    target.map((f) => {
      const { removed: _removed, ...col } = f
      return [f.key, col as Column] as const
    }),
  )
  const shown = new Set(activeFields(target).map((c) => c.key))
  for (const [k, v] of Object.entries(out)) {
    const col = byKey.get(k)
    if (col && !fitsField(col, v)) {
      aside[k] = v
      delete out[k]
    }
  }
  for (const [k, v] of Object.entries(aside)) {
    const col = byKey.get(k)
    if (col && out[k] === undefined && fitsField(col, v)) {
      out[k] = v
      delete aside[k]
    }
  }
  if (Object.keys(aside).length > 0) out[HIDDEN_FIELDS_KEY] = aside
  const hidden = [
    ...Object.keys(out).filter((k) => k !== HIDDEN_FIELDS_KEY && !shown.has(k)),
    ...Object.keys(aside),
  ].sort()
  return { fields: out, hidden }
}

export function sameFields(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return sameJson(a, b)
}

/**
 * The SQL conditions of a field filter {key: value | value[] | null} on the tasks aliased `alias`:
 * a value matches equal (a choices field: holds it; a link: its record id), a list any of its
 * values, null an empty field. A key that is not an active field refuses (422 `unknown_field`).
 */
export function fieldFilterConditions(
  defs: readonly ProjectField[],
  filter: unknown,
  alias: string,
): SQL[] {
  if (filter === undefined || filter === null) return []
  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw new ProjectsServiceError(422, "invalid_field", "fields filter is {fieldKey: value}")
  }
  const byKey = new Map(activeFields(defs).map((c) => [c.key, c]))
  const t = drizzleSql.raw(alias)
  const out: SQL[] = []
  for (const [key, raw] of Object.entries(filter as Record<string, unknown>)) {
    const col = byKey.get(key)
    if (!col) {
      throw new ProjectsServiceError(
        422,
        "unknown_field",
        `field '${key}' is not a field of this project`,
        { field: key },
      )
    }
    const cell = drizzleSql`${t}.fields -> ${key}`
    if (raw === null || (Array.isArray(raw) && raw.length === 0)) {
      out.push(
        drizzleSql`(${cell} IS NULL OR ${cell} = 'null'::jsonb OR ${cell} = '[]'::jsonb OR ${cell} = '""'::jsonb)`,
      )
      continue
    }
    const values = Array.isArray(raw) ? raw : [raw]
    const one = (v: unknown): SQL => {
      if (col.type === "choices") return drizzleSql`(${cell} ? ${String(v)})`
      if (col.type === "link") {
        const id =
          typeof v === "object" && v !== null ? String((v as { id?: unknown }).id ?? "") : String(v)
        return drizzleSql`(${cell} ->> 'id' = ${id})`
      }
      const norm = col.type === "person" && typeof v === "string" ? v.toLowerCase() : v
      return drizzleSql`(${cell} = ${JSON.stringify(norm)}::jsonb)`
    }
    out.push(drizzleSql`(${drizzleSql.join(values.map(one), drizzleSql` OR `)})`)
  }
  return out
}
