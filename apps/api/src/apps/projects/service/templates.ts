// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Project templates. A template's `structure` (version 2) carries the board's statuses, its task
// fields and a task tree whose nodes may set a priority, field values and a status:
//   {version: 2, statuses?: [{label, color?, terminal?}], fields?: Column[],
//    tasks: [{title, description?, priority?, statusLabel?, fields?, children?}]}
// The structure first stored (a bare array of {title, description, children}) is read as
// {version: 2, tasks: <that array>}.
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { UUID_RE } from "~/lib/uuid"
import type { Column } from "~/modules/dashboards/tables/columns"
import { normalizeFieldDefs, normalizeStatusSeeds, type ProjectStatusSeed } from "./create-project"
import {
  activeFields,
  maskLinkCells,
  readerScopes,
  readProjectFields,
  validateTaskFields,
} from "./fields"
import { assertTaskPriority } from "./resolve"
import { ProjectsServiceError } from "./statuses"
import { MAX_TASK_DEPTH } from "./task-depth"

export interface TemplateNode {
  title: string
  description?: string | null
  priority?: string
  /** The status the task starts in (by label); default the first non-terminal one. */
  statusLabel?: string | null
  fields?: Record<string, unknown>
  children?: TemplateNode[]
}

export interface TemplateStructure {
  version: 2
  statuses?: ProjectStatusSeed[]
  fields?: Column[]
  tasks: TemplateNode[]
}

export const MAX_TEMPLATE_TASKS = 500
export const MAX_TEMPLATE_NAME = 200

const nodeSchema: z.ZodType<TemplateNode> = z.lazy(() =>
  z
    .object({
      title: z.string().trim().min(1, "a task needs a title").max(500),
      description: z.string().max(20_000).nullable().optional(),
      priority: z.string().optional(),
      statusLabel: z.string().trim().min(1).max(60).nullable().optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
      children: z.array(nodeSchema).optional(),
    })
    .strict(),
)

const statusSeedSchema = z
  .object({
    label: z.string(),
    color: z.string().nullable().optional(),
    terminal: z.boolean().optional(),
  })
  .strict()

/**
 * The node shape a STORED structure is read with: unknown keys dropped, never refused, and limits
 * at least those of every writer that ever stored one (the v1 importer took descriptions up to
 * 100 000 characters, import-kind.ts). The strict `nodeSchema` above checks what is saved now.
 */
const storedNodeSchema: z.ZodType<TemplateNode> = z.lazy(() =>
  z.object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).nullable().optional(),
    priority: z.string().optional(),
    statusLabel: z.string().nullable().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    children: z.array(storedNodeSchema).optional(),
  }),
)

/**
 * A stored structure as a v2 structure. A part that cannot be read refuses the whole template
 * (422 `template_unreadable`): an instantiation never builds a project short of its tasks.
 */
export function parseTemplateStructure(raw: unknown): TemplateStructure {
  const unreadable = (part: string, issue?: { path: PropertyKey[]; message: string }) =>
    new ProjectsServiceError(
      422,
      "template_unreadable",
      `the stored template's ${part} cannot be read${issue ? ` (${issue.path.map(String).join(".") || "root"}: ${issue.message})` : ""}`,
    )
  if (Array.isArray(raw)) {
    const tasks = z.array(storedNodeSchema).safeParse(raw)
    if (!tasks.success) throw unreadable("tasks", tasks.error.issues[0])
    return { version: 2, tasks: tasks.data }
  }
  if (typeof raw !== "object" || raw === null) throw unreadable("structure")
  const r = raw as Record<string, unknown>
  const tasks = z.array(storedNodeSchema).safeParse(r.tasks ?? [])
  if (!tasks.success) throw unreadable("tasks", tasks.error.issues[0])
  const statuses = z.array(statusSeedSchema).safeParse(r.statuses ?? [])
  if (!statuses.success) throw unreadable("statuses", statuses.error.issues[0])
  const fields = Array.isArray(r.fields) ? (r.fields as Column[]) : []
  return {
    version: 2,
    ...(statuses.data.length > 0 ? { statuses: statuses.data } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    tasks: tasks.data,
  }
}

function invalid(message: string): ProjectsServiceError {
  return new ProjectsServiceError(422, "invalid_template", message)
}

/** Checks a structure to be stored; a field value in a node is checked like a task's. */
async function checkStructure(
  tx: RlsClient,
  orgId: string,
  input: { statuses?: unknown; fields?: unknown; tasks?: unknown },
): Promise<TemplateStructure> {
  const statuses =
    input.statuses === undefined || input.statuses === null
      ? undefined
      : z.array(statusSeedSchema).safeParse(input.statuses)
  if (statuses && !statuses.success) throw invalid("statuses are [{label, color?, terminal?}]")
  if (statuses?.data && statuses.data.length > 0) {
    try {
      normalizeStatusSeeds(statuses.data)
    } catch (err) {
      throw invalid((err as Error).message.replace(/^invalid_statuses: /, "statuses: "))
    }
  }
  const fields = normalizeFieldDefs(input.fields)
  const tasks = z.array(nodeSchema).safeParse(input.tasks ?? [])
  if (!tasks.success) {
    const issue = tasks.error.issues[0]
    throw invalid(`tasks${issue?.path.length ? `.${issue.path.join(".")}` : ""}: ${issue?.message}`)
  }
  const statusLabels = new Set(
    (statuses?.data?.length ? statuses.data.map((s) => s.label) : null)?.map((l) =>
      l.trim().toLowerCase(),
    ),
  )
  let count = 0
  const walk = async (nodes: TemplateNode[], depth: number): Promise<void> => {
    if (depth > MAX_TASK_DEPTH) throw invalid(`tasks nest at most ${MAX_TASK_DEPTH} levels`)
    for (const node of nodes) {
      count += 1
      if (count > MAX_TEMPLATE_TASKS) throw invalid(`at most ${MAX_TEMPLATE_TASKS} tasks`)
      if (node.priority !== undefined) {
        try {
          assertTaskPriority(node.priority)
        } catch {
          throw invalid(`task '${node.title}': priority is low, normal, high or urgent`)
        }
      }
      if (node.statusLabel && statusLabels.size > 0) {
        if (!statusLabels.has(node.statusLabel.trim().toLowerCase())) {
          throw invalid(
            `task '${node.title}': status '${node.statusLabel}' is not a template status`,
          )
        }
      }
      if (node.fields) await validateTaskFields(tx, orgId, fields, node.fields, { full: false })
      await walk(node.children ?? [], depth + 1)
    }
  }
  await walk(tasks.data, 1)
  return {
    version: 2,
    ...(statuses?.data && statuses.data.length > 0 ? { statuses: statuses.data } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    tasks: tasks.data,
  }
}

/**
 * A project's board as a template structure: its statuses, its active fields and its open task
 * tree (title, description, priority, status, field values). An archived project may be copied.
 */
export async function snapshotProject(
  tx: RlsClient,
  orgId: string,
  projectId: string,
): Promise<TemplateStructure> {
  const statuses = extractRows<{
    id: string
    label: string
    color: string | null
    terminal: boolean
  }>(
    await tx.execute(drizzleSql`
      SELECT id, label, color, terminal FROM ${projectsRel("project_statuses")}
      WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      ORDER BY "order" ASC
    `),
  )
  const fields = activeFields(await readProjectFields(tx, orgId, projectId))
  const rows = extractRows<{
    id: string
    parent_task_id: string | null
    title: string
    description: string | null
    priority: string
    status_id: string
    fields: Record<string, unknown> | null
  }>(
    await tx.execute(drizzleSql`
      SELECT t.id, t.parent_task_id, t.title, t.description, t.priority, t.status_id, t.fields
      FROM ${projectsRel("tasks")} t
      LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id AND s.org_id = t.org_id
      WHERE t.project_id = ${projectId}::uuid AND t.org_id = ${orgId}::uuid
        AND t.archived_at IS NULL AND s.terminal IS NOT TRUE
      ORDER BY s."order" ASC NULLS LAST, t.position ASC, t.created_at ASC
      LIMIT ${MAX_TEMPLATE_TASKS}
    `),
  )
  const labelOf = new Map(statuses.map((s) => [s.id, s.label]))
  const keys = new Set(fields.map((f) => f.key))
  // The copy holds what its maker may read: a link to an app they may not open keeps its record
  // but carries the hidden label, as on the task itself (fields.ts, visibleTaskFields).
  const scopes = fields.some((f) => f.type === "link") ? await readerScopes(tx) : []
  const byParent = new Map<string | null, typeof rows>()
  const ids = new Set(rows.map((r) => r.id))
  for (const r of rows) {
    // A child whose parent is done hangs from the root of the copy.
    const parent = r.parent_task_id && ids.has(r.parent_task_id) ? r.parent_task_id : null
    byParent.set(parent, [...(byParent.get(parent) ?? []), r])
  }
  const build = (parent: string | null): TemplateNode[] =>
    (byParent.get(parent) ?? []).map((r) => {
      const values = maskLinkCells(
        Object.fromEntries(
          Object.entries(r.fields ?? {}).filter(([k, v]) => keys.has(k) && v !== null),
        ),
        scopes,
      )
      const children = build(r.id)
      return {
        title: r.title,
        ...(r.description ? { description: r.description } : {}),
        ...(r.priority !== "normal" ? { priority: r.priority } : {}),
        ...(labelOf.get(r.status_id) ? { statusLabel: labelOf.get(r.status_id) } : {}),
        ...(Object.keys(values).length > 0 ? { fields: values } : {}),
        ...(children.length > 0 ? { children } : {}),
      }
    })
  return {
    version: 2,
    statuses: statuses.map((s) => ({ label: s.label, color: s.color, terminal: s.terminal })),
    ...(fields.length > 0 ? { fields } : {}),
    tasks: build(null),
  }
}

export interface TemplateSummary {
  id: string
  name: string
  statusCount: number
  fieldCount: number
  taskCount: number
  /** The stored structure cannot be read (instantiating it refuses); counts are then 0. */
  unreadable?: true
  createdAt: string
}

function countNodes(nodes: TemplateNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children ?? []), 0)
}

function summary(row: {
  id: string
  name: string
  structure: unknown
  created_at: Date | string
}): TemplateSummary {
  let s: TemplateStructure | null = null
  try {
    s = parseTemplateStructure(row.structure)
  } catch {
    // Listed, and marked: instantiating it refuses with `template_unreadable`.
  }
  return {
    id: row.id,
    name: row.name,
    ...(s ? {} : { unreadable: true }),
    statusCount: s?.statuses?.length ?? 0,
    fieldCount: s?.fields?.length ?? 0,
    taskCount: s ? countNodes(s.tasks) : 0,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}

export interface SaveTemplateArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  input: {
    /** Replace this template; omit to create one. */
    templateId?: string | null
    name: string
    statuses?: unknown
    fields?: unknown
    tasks?: unknown
    /** Start from this project's statuses, fields and open tasks; given parts replace its own. */
    fromProjectId?: string | null
  }
}

/** Creates or replaces a template (the whole structure is checked first). */
export async function saveTemplate(
  args: SaveTemplateArgs,
): Promise<TemplateSummary & { structure: TemplateStructure }> {
  const { tx, orgId, actor, input } = args
  const name = (input.name ?? "").trim()
  if (!name || name.length > MAX_TEMPLATE_NAME) {
    throw invalid(`a template has a name of 1 to ${MAX_TEMPLATE_NAME} characters`)
  }
  for (const [param, v] of [
    ["templateId", input.templateId],
    ["fromProjectId", input.fromProjectId],
  ] as const) {
    if (v && !UUID_RE.test(v)) {
      throw new ProjectsServiceError(400, "invalid_params", `${param} must be a uuid`)
    }
  }
  return tx.transaction(async (innerTx) => {
    const base = input.fromProjectId
      ? await snapshotProject(innerTx as RlsClient, orgId, input.fromProjectId)
      : null
    const structure = await checkStructure(innerTx as RlsClient, orgId, {
      statuses: input.statuses ?? base?.statuses,
      fields: input.fields ?? base?.fields,
      tasks: input.tasks ?? base?.tasks,
    })
    const json = JSON.stringify(structure)
    let row: { id: string; name: string; structure: unknown; created_at: Date | string } | undefined
    if (input.templateId) {
      ;[row] = extractRows(
        await innerTx.execute(drizzleSql`
          UPDATE ${projectsRel("project_templates")}
          SET name = ${name}, structure = ${json}::jsonb
          WHERE id = ${input.templateId}::uuid AND org_id = ${orgId}::uuid
          RETURNING id, name, structure, created_at
        `),
      )
      if (!row) {
        throw new ProjectsServiceError(404, "template_not_found", "project template not found")
      }
    } else {
      ;[row] = extractRows(
        await innerTx.execute(drizzleSql`
          INSERT INTO ${projectsRel("project_templates")} (id, org_id, name, structure, created_by)
          VALUES (${randomUUID()}::uuid, ${orgId}::uuid, ${name}, ${json}::jsonb, ${actor.userId}::uuid)
          RETURNING id, name, structure, created_at
        `),
      )
    }
    return { ...summary(row!), structure }
  })
}

/** The org's templates, by name. */
export async function listTemplates(tx: RlsClient, orgId: string): Promise<TemplateSummary[]> {
  const rows = extractRows<{
    id: string
    name: string
    structure: unknown
    created_at: Date | string
  }>(
    await tx.execute(drizzleSql`
      SELECT id, name, structure, created_at FROM ${projectsRel("project_templates")}
      WHERE org_id = ${orgId}::uuid
      ORDER BY lower(name) ASC, created_at ASC
    `),
  )
  return rows.map(summary)
}

/** One stored template's structure (v2), or 404. */
export async function loadTemplate(
  tx: RlsClient,
  orgId: string,
  templateId: string,
): Promise<TemplateStructure> {
  if (!UUID_RE.test(templateId)) {
    throw new ProjectsServiceError(404, "template_not_found", "project template not found")
  }
  const [row] = extractRows<{ structure: unknown }>(
    await tx.execute(drizzleSql`
      SELECT structure FROM ${projectsRel("project_templates")}
      WHERE id = ${templateId}::uuid AND org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  if (!row) throw new ProjectsServiceError(404, "template_not_found", "project template not found")
  return parseTemplateStructure(row.structure)
}
