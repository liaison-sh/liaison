// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's dashboard table tools (S9), registered with the dashboard tools:
//  - tables_list, tables_get, tables_query: reads, under the person's RLS (a table not shared
//    with them does not exist for their agent). tables_query is also a dashboard source.
//  - tables_rows_write: up to 50 row ops, all or none. Applies at once, unless the table's
//    "agent row writes need approval" switch is on: then one card lists every op. Its readers
//    are the table's (scope taint judges the write by them, `sinkReadersResource`).
//  - tables_edit: create a table, change its columns or settings, delete it. Always waits for a
//    person's approval when an agent asks (A6); a person's own REST call never does.
// Deciders: the table's owner while it is restricted to some people or roles, the dashboards
// admins when the whole organisation sees it (as for dashboards, tools.ts restrictedDecider).

import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { dashboards, dashboardTables } from "~/db/schema/kernel"
import {
  type ApprovalSummarizer,
  approvalResourceOwnerRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { type Column, columnSchema } from "~/modules/dashboards/tables/columns"
import {
  ADMIN_SCOPE,
  applyColumnOps,
  createTable,
  deleteTable,
  getTable,
  getTableSharing,
  listRows,
  listTables,
  MAX_OPS_PER_WRITE,
  READ_SCOPE,
  type Row,
  type RowOp,
  TABLE_ERROR_STATUS,
  TABLE_RESOURCE,
  TableError,
  updateTable,
  WRITE_SCOPE,
  writeRows,
} from "~/modules/dashboards/tables/service"
import { viewerOf } from "~/modules/dashboards/tools"

/** Where a table's rows live: the scope taint's write target for row writes. */
const ROWS_SINK = "kernel.app_documents"
const TABLES_SINK = "kernel.dashboard_tables"

interface HandlerCtx {
  userId: string
  orgId: string
  db: RlsClient
  scopes?: string[]
  dimensionGrants?: Record<string, string[]>
}

type Handler = (params: unknown, ctx: any) => Promise<unknown>

/** A refusal as the tool's error, with the column or row it names. */
function asToolError(err: unknown) {
  if (!(err instanceof TableError)) throw err
  return {
    error: {
      code: err.code,
      message: err.message,
      retryable: err.code === "invalid_cell" || err.code === "version_conflict",
      status: TABLE_ERROR_STATUS[err.code],
      ...(err.details.column || err.details.rowId || err.details.current
        ? {
            body: {
              ...(err.details.column ? { column: err.details.column } : {}),
              ...(err.details.rowId ? { rowId: err.details.rowId } : {}),
              ...(err.details.current ? { current: compactRow(err.details.current) } : {}),
            },
          }
        : {}),
    },
  }
}

async function guarded<T>(fn: () => Promise<T>) {
  try {
    return await fn()
  } catch (err) {
    return asToolError(err)
  }
}

function compactRow(r: Row) {
  return {
    id: r.id,
    version: r.version,
    cells: r.cells,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy.label,
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface StoredTable {
  orgAccess: "none" | "viewer" | "editor"
  ownerUserId: string | null
  agentWritesNeedApproval: boolean
}

/** A table's sharing and switch, read for the gate and its routing (before the handler runs). */
async function storedTable(orgId: string, id: unknown): Promise<StoredTable | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null
  return withPrivilegedDb(orgId, "dashboard-table-gate", async (tx) => {
    const [row] = await tx
      .select({
        orgAccess: dashboardTables.orgAccess,
        ownerUserId: dashboardTables.ownerUserId,
        agentWritesNeedApproval: dashboardTables.agentWritesNeedApproval,
      })
      .from(dashboardTables)
      .where(and(eq(dashboardTables.id, id), eq(dashboardTables.orgId, orgId)))
      .limit(1)
    return row ?? null
  })
}

/**
 * Who decides an agent's change to a table: null (the dashboards admins) when the whole
 * organisation sees it; its owner while it is restricted (else the requester), so nobody who
 * cannot see it reads its card.
 */
async function tableDecider(
  orgId: string,
  id: unknown,
  requestedBy: string,
): Promise<string | null> {
  const stored = await storedTable(orgId, id)
  if (!stored) return requestedBy
  if (stored.orgAccess !== "none") return null
  return stored.ownerUserId ?? requestedBy
}

/** Who decides a new table: the requester for their own, the admins for an org-wide one. */
async function createDecider(
  orgId: string,
  params: Record<string, unknown>,
  requestedBy: string,
): Promise<string | null> {
  if (params.orgAccess === "viewer" || params.orgAccess === "editor") return null
  const from = params.fromDashboardId
  if (typeof from !== "string" || !UUID.test(from)) return requestedBy
  const dash = await withPrivilegedDb(orgId, "dashboard-table-create-gate", async (tx) => {
    const [d] = await tx
      .select({ orgAccess: dashboards.orgAccess, ownerUserId: dashboards.ownerUserId })
      .from(dashboards)
      .where(and(eq(dashboards.id, from), eq(dashboards.orgId, orgId)))
      .limit(1)
    return d ?? null
  })
  if (!dash) return requestedBy
  return dash.orgAccess !== "none" ? null : (dash.ownerUserId ?? requestedBy)
}

// ── Cards ───────────────────────────────────────────────────────────────────

const cellText = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "(empty)"
  if (Array.isArray(v)) return v.join(", ")
  if (typeof v === "object") return String((v as { label?: unknown }).label ?? JSON.stringify(v))
  return String(v)
}

function cellsWords(cells: Record<string, unknown> | undefined, labels: Map<string, string>) {
  return Object.entries(cells ?? {})
    .map(([k, v]) => `${labels.get(k) ?? k} = ${cellText(v)}`)
    .join(", ")
    .slice(0, 450)
}

async function cardTable(tx: RlsClient, id: unknown) {
  if (typeof id !== "string" || !UUID.test(id)) return null
  const [row] = await tx
    .select({ name: dashboardTables.name, columns: dashboardTables.columns })
    .from(dashboardTables)
    .where(eq(dashboardTables.id, id))
    .limit(1)
  return row ?? null
}

const summarizeRowsWrite: ApprovalSummarizer = async (raw, ctx) => {
  const p = (raw ?? {}) as { tableId?: string; ops?: RowOp[] }
  const table = await cardTable(ctx.tx, p.tableId)
  const labels = new Map(
    ((table?.columns ?? []) as unknown as Column[]).map((c) => [c.key, c.label]),
  )
  const ops = Array.isArray(p.ops) ? p.ops.slice(0, 50) : []
  return {
    kind: "dashboard_table_rows",
    title:
      `Change ${ops.length} row${ops.length === 1 ? "" : "s"} of the table "${table?.name ?? "a table"}"`.slice(
        0,
        200,
      ),
    subtitle: "All changes apply together. Every change is recorded and can be undone.",
    impact: "internal",
    lines: ops.map((op, i) => {
      const n = `${i + 1}. `
      if (op.op === "add") return `${n}Add a row: ${cellsWords(op.cells, labels)}`
      if (op.op === "update") return `${n}Row ${op.id.slice(0, 8)}: ${cellsWords(op.cells, labels)}`
      return `${n}Delete row ${String((op as { id?: string }).id ?? "").slice(0, 8)}`
    }),
  }
}

const COLUMN_TYPE_WORDS: Record<string, string> = {
  text: "text",
  number: "number",
  amount: "amount",
  date: "date",
  choice: "one choice",
  choices: "several choices",
  checkbox: "checkbox",
  person: "person",
  link: "link to a record",
}

function columnWords(c: Partial<Column>): string {
  const type = COLUMN_TYPE_WORDS[String(c.type)] ?? String(c.type)
  const extra =
    c.type === "amount" && c.currency
      ? ` in ${c.currency}`
      : (c.type === "choice" || c.type === "choices") && c.choices
        ? ` (${c.choices.join(", ")})`
        : c.type === "link" && c.linkTo
          ? ` to ${c.linkTo.app}${c.linkTo.entityType ? ` ${c.linkTo.entityType}` : ""}`
          : ""
  return `"${String(c.label ?? c.key)}" (${String(c.key)}): ${type}${extra}${c.required ? ", required" : ""}`
}

const summarizeEdit: ApprovalSummarizer = async (raw, ctx) => {
  const p = (raw ?? {}) as EditParams
  if (p.action === "create") {
    const cols = Array.isArray(p.columns) ? (p.columns as Partial<Column>[]) : []
    const shared =
      p.fromDashboardId !== undefined
        ? "Shared like the dashboard it is made from."
        : p.orgAccess && p.orgAccess !== "none"
          ? `Everyone in the organisation gets ${p.orgAccess} access.`
          : "Only you see it until you share it."
    return {
      kind: "dashboard_table_edit",
      title: `Create the table "${String(p.name ?? "")}"`.slice(0, 200),
      subtitle: shared,
      impact: "internal",
      lines: [
        ...cols.slice(0, 40).map((c, i) => `${i + 1}. Column ${columnWords(c)}`),
        ...(p.agentWritesNeedApproval ? ["Agents' row changes will wait for an approval."] : []),
      ].slice(0, 50),
    }
  }
  const table = await cardTable(ctx.tx, p.tableId)
  const name = table?.name ?? "a table"
  if (p.action === "delete") {
    return {
      kind: "dashboard_table_edit",
      title: `Delete the table "${name}"`.slice(0, 200),
      impact: "internal",
      lines: [
        "Its rows are deleted with it, and every block reading it shows an error.",
        "Its change history is kept for retention only.",
      ],
    }
  }
  const labels = new Map(
    ((table?.columns ?? []) as unknown as Column[]).map((c) => [c.key, c.label]),
  )
  const cols = (p.columns ?? {}) as {
    add?: Partial<Column>[]
    rename?: { key: string; label: string }[]
    setChoices?: { key: string; choices: string[] }[]
    drop?: string[]
  }
  const lines = [
    ...(p.name !== undefined ? [`Rename it "${p.name}"`] : []),
    ...(p.description !== undefined ? ["Change its description"] : []),
    ...(p.agentWritesNeedApproval !== undefined
      ? [
          p.agentWritesNeedApproval
            ? "Agents' row changes will wait for an approval"
            : "Agents' row changes apply at once (recorded, undoable)",
        ]
      : []),
    ...(cols.add ?? []).map((c) => `Add the column ${columnWords(c)}`),
    ...(cols.rename ?? []).map(
      (r) => `Rename the column "${labels.get(r.key) ?? r.key}" to "${r.label}"`,
    ),
    ...(cols.setChoices ?? []).map(
      (c) => `Choices of "${labels.get(c.key) ?? c.key}": ${c.choices.join(", ")}`,
    ),
    ...(cols.drop ?? []).map(
      (k) => `Drop the column "${labels.get(k) ?? k}" (its values stay in the history)`,
    ),
  ]
  return {
    kind: "dashboard_table_edit",
    title: `Change the table "${name}"`.slice(0, 200),
    impact: "internal",
    lines: lines.map((l, i) => `${i + 1}. ${l}`.slice(0, 500)).slice(0, 50),
  }
}

// ── Params ──────────────────────────────────────────────────────────────────

const cells = z
  .record(z.string(), z.unknown())
  .describe(
    "{columnKey: value}: text and dates (YYYY-MM-DD) as strings, numbers and amounts as numbers, a choice as one of its choices, choices as a list, a checkbox as true/false, a person as a user id (kernel__users_search), a link as {app, entityType, id, label}. null empties a cell.",
  )
const rowOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), cells }).strict(),
  z
    .object({
      op: z.literal("update"),
      id: z.string().min(1).max(200),
      ifVersion: z.number().int().min(1).describe("The row's version from kernel__tables_query"),
      cells,
    })
    .strict(),
  z
    .object({
      op: z.literal("delete"),
      id: z.string().min(1).max(200),
      ifVersion: z.number().int().min(1),
    })
    .strict(),
])

const columnOps = z
  .object({
    add: z.array(columnSchema).max(40).optional(),
    rename: z
      .array(z.object({ key: z.string(), label: z.string().min(1).max(80) }).strict())
      .max(40)
      .optional(),
    setChoices: z
      .array(
        z
          .object({ key: z.string(), choices: z.array(z.string().min(1).max(80)).min(1).max(100) })
          .strict(),
      )
      .max(40)
      .optional(),
    drop: z.array(z.string()).max(40).optional(),
  })
  .strict()

const editParams = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).optional(),
      columns: z.array(columnSchema).max(40),
      agentWritesNeedApproval: z.boolean().optional(),
      fromDashboardId: z
        .string()
        .uuid()
        .optional()
        .describe("Share the table exactly like this dashboard (the one it will show on)"),
      orgAccess: z.enum(["none", "viewer", "editor"]).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("alter"),
      tableId: z.string().uuid(),
      ifVersion: z.number().int().min(1),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(2000).nullable().optional(),
      agentWritesNeedApproval: z.boolean().optional(),
      columns: columnOps.optional(),
    })
    .strict(),
  z.object({ action: z.literal("delete"), tableId: z.string().uuid() }).strict(),
])
/** The params as the card reads them (validated by the time a card is made, loosely typed here). */
interface EditParams {
  action?: "create" | "alter" | "delete"
  tableId?: string
  name?: string
  description?: string | null
  agentWritesNeedApproval?: boolean
  fromDashboardId?: string
  orgAccess?: "none" | "viewer" | "editor"
  columns?: unknown
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerTableTools(orgId: string): void {
  toolRegistry.set([orgId, "kernel", "tables_list"], {
    appName: "kernel",
    name: "tables_list",
    readOnly: true,
    deferLoading: true,
    description:
      "List the dashboard tables you can see (org data people and agents keep, such as inbound batches or repairs): id, name, columns, your access and row count.",
    searchKeywords: ["table", "tableau", "rows", "lignes", "suivi", "tracker", "list"],
    requiredScopes: [READ_SCOPE],
    params: z.object({}),
    handler: (async (_p: unknown, ctx: HandlerCtx) =>
      guarded(async () => ({
        tables: (await listTables(await viewerOf(ctx), ctx.db)).map((t) => ({
          id: t.id,
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          columns: t.columns.map((c) => ({ key: c.key, label: c.label, type: c.type })),
          myRole: t.myRole,
          rowCount: t.rowCount,
          agentWritesNeedApproval: t.agentWritesNeedApproval,
        })),
      }))) as Handler,
  })

  toolRegistry.set([orgId, "kernel", "tables_get"], {
    appName: "kernel",
    name: "tables_get",
    readOnly: true,
    deferLoading: true,
    description:
      "Read one dashboard table: its columns (key, label, type, choices, required), version, row count, your access and who it is shared with.",
    searchKeywords: ["table", "tableau", "columns", "colonnes"],
    requiredScopes: [READ_SCOPE],
    params: z.object({ tableId: z.string().uuid() }),
    handler: (async (params: unknown, ctx: HandlerCtx) =>
      guarded(async () => {
        const viewer = await viewerOf(ctx)
        const id = (params as { tableId: string }).tableId
        const info = await getTable(viewer, id, ctx.db)
        const sharing = await getTableSharing(viewer, id, ctx.db)
        return {
          ...info,
          sharing: {
            orgAccess: sharing.orgAccess,
            owner: sharing.ownerName,
            people: sharing.users.map((u) => ({ name: u.name, access: u.role })),
            roles: sharing.roles.map((r) => ({ name: r.name, access: r.role })),
          },
        }
      })) as Handler,
  })

  toolRegistry.set([orgId, "kernel", "tables_query"], {
    appName: "kernel",
    name: "tables_query",
    readOnly: true,
    // Cells are free text people and agents wrote, some from outside the organisation.
    taintSource: true,
    deferLoading: true,
    description:
      'Read rows of a dashboard table: each with its id, version (pass it as ifVersion to change the row), cells and who changed it last. Filter with where on column keys ({status: "arrived"}, {qty: {gte: 5}}, {status: {in: ["a","b"]}}), sort by a column key or updated_at, page with cursor. Also a dashboard source.',
    searchKeywords: ["table", "rows", "lignes", "query", "lire"],
    requiredScopes: [READ_SCOPE],
    params: z.object({
      tableId: z.string().uuid(),
      where: z.record(z.string(), z.unknown()).optional(),
      q: z.string().max(100).optional().describe("Rows holding this text in a cell"),
      sort: z.string().max(40).optional(),
      dir: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().max(4096).optional(),
    }),
    handler: (async (params: unknown, ctx: HandlerCtx) =>
      guarded(async () => {
        const p = params as {
          tableId: string
          where?: Record<string, never>
          q?: string
          sort?: string
          dir?: "asc" | "desc"
          limit?: number
          cursor?: string
        }
        const page = await listRows(
          await viewerOf(ctx),
          p.tableId,
          {
            ...(p.where ? { where: p.where } : {}),
            ...(p.q ? { q: p.q } : {}),
            ...(p.sort ? { sort: p.sort } : {}),
            ...(p.dir ? { dir: p.dir } : {}),
            ...(p.limit ? { limit: p.limit } : {}),
            ...(p.cursor ? { cursor: p.cursor } : {}),
          },
          ctx.db,
        )
        return { rows: page.rows.map(compactRow), nextCursor: page.nextCursor }
      })) as Handler,
  })

  toolRegistry.set([orgId, "kernel", "tables_rows_write"], {
    appName: "kernel",
    name: "tables_rows_write",
    deferLoading: true,
    description: `Add, change or delete rows of a dashboard table, up to ${MAX_OPS_PER_WRITE} operations applied together (all or none): {op:"add", cells}, {op:"update", id, ifVersion, cells} (only the cells given change), {op:"delete", id, ifVersion}. Read the columns with kernel__tables_get and the rows' ids and versions with kernel__tables_query first. Applies at once and is recorded (people can undo it), unless the table asks for approval of agents' row changes. A row changed since your read is refused naming it: read it again and retry.`,
    searchKeywords: ["table", "row", "ligne", "add", "ajouter", "update", "modifier", "statut"],
    requiredScopes: [WRITE_SCOPE],
    params: z.object({
      tableId: z.string().uuid(),
      ops: z.array(rowOp).min(1).max(MAX_OPS_PER_WRITE),
    }),
    handler: (async (params: unknown, ctx: HandlerCtx) =>
      guarded(async () => {
        const p = params as { tableId: string; ops: RowOp[] }
        const rows = await writeRows(await viewerOf(ctx), p.tableId, p.ops, { tx: ctx.db })
        return {
          rows: rows.map((r) =>
            "deleted" in r ? r : { id: r.id, version: r.version, cells: r.cells },
          ),
        }
      })) as Handler,
    writesToTable: ROWS_SINK,
    sinkReadersResource: { type: TABLE_RESOURCE, idParam: "tableId" },
    approveScope: ADMIN_SCOPE,
    approvalImpact: "internal",
    gatedWhen: async (params: unknown, { orgId: o }: { orgId: string }) =>
      (await storedTable(o, (params as { tableId?: unknown } | null)?.tableId))
        ?.agentWritesNeedApproval === true,
  })
  registerApprovalSummarizer(orgId, "kernel", "tables_rows_write", summarizeRowsWrite)
  approvalResourceOwnerRegistry.set([orgId, "kernel", "tables_rows_write"], {
    resolveOwner: (params, ctx) => tableDecider(ctx.orgId, params.tableId, ctx.requestedBy),
  })

  toolRegistry.set([orgId, "kernel", "tables_edit"], {
    appName: "kernel",
    name: "tables_edit",
    deferLoading: true,
    description:
      'Create a dashboard table, change it, or delete it; always waits for a person\'s approval. {action:"create", name, columns:[{key, label, type, required?, choices?, currency?, linkTo?}], fromDashboardId? (shared like that dashboard), agentWritesNeedApproval?}; {action:"alter", tableId, ifVersion, name?, description?, agentWritesNeedApproval?, columns?: {add?, rename?: [{key,label}], setChoices?: [{key,choices}], drop?: [keys]}}; {action:"delete", tableId}. Column types: text, number, amount (+currency), date, choice, choices, checkbox, person, link. A key is lowercase a-z, 0-9, _ and never changes. To show a table on a dashboard, add a block with source {kind:"table", table:<id>} (map.editable true for a table people edit) with kernel__dashboards_edit in the same turn: both wait on one card.',
    searchKeywords: ["table", "create", "créer", "column", "colonne", "tableau", "tracker"],
    requiredScopes: [WRITE_SCOPE],
    params: editParams,
    handler: (async (params: unknown, ctx: HandlerCtx) =>
      guarded(async () => {
        const p = params as z.infer<typeof editParams>
        const viewer = await viewerOf(ctx)
        if (p.action === "create") {
          const t = await createTable(
            viewer,
            {
              name: p.name,
              ...(p.description ? { description: p.description } : {}),
              columns: p.columns,
              ...(p.agentWritesNeedApproval !== undefined
                ? { agentWritesNeedApproval: p.agentWritesNeedApproval }
                : {}),
              ...(p.fromDashboardId ? { fromDashboardId: p.fromDashboardId } : {}),
              ...(p.orgAccess ? { orgAccess: p.orgAccess } : {}),
            },
            ctx.db,
          )
          return {
            id: t.id,
            name: t.name,
            version: t.version,
            columns: t.columns.map((c) => c.key),
          }
        }
        if (p.action === "delete") {
          await deleteTable(viewer, p.tableId, ctx.db)
          return { deleted: true }
        }
        const t = await updateTable(
          viewer,
          p.tableId,
          {
            ifVersion: p.ifVersion,
            ...(p.name !== undefined ? { name: p.name } : {}),
            ...(p.description !== undefined ? { description: p.description } : {}),
            ...(p.agentWritesNeedApproval !== undefined
              ? { agentWritesNeedApproval: p.agentWritesNeedApproval }
              : {}),
            ...(p.columns ? { columns: p.columns } : {}),
          },
          ctx.db,
        )
        return {
          id: t.id,
          version: t.version,
          columns: t.columns.map((c) => c.key),
          droppedKeys: t.droppedKeys,
        }
      })) as Handler,
    writesToTable: TABLES_SINK,
    // A new table, a column change or a deletion by an agent always waits for a person (A6).
    gated: true,
    approveScope: ADMIN_SCOPE,
    approvalImpact: "internal",
    // Checked before any approval is staged: nobody approves a change that would be refused.
    refuseBeforeGate: async (params: unknown, ctx) => {
      if (ctx.userId === "system") return null
      const p = params as z.infer<typeof editParams>
      const viewer = await viewerOf({ ...ctx, scopes: [...ctx.scopes] })
      return guarded(async () => {
        if (p.action === "create") return null
        const t = await getTable(viewer, p.tableId)
        if (p.action === "delete") {
          if (
            t.myRole !== "owner" &&
            !(t.orgAccess !== "none" && viewer.scopes.some((s) => s === "*" || s === ADMIN_SCOPE))
          ) {
            throw new TableError("forbidden", "only its owner deletes this table")
          }
          return null
        }
        if (t.myRole === "viewer") {
          throw new TableError("forbidden", "changing this table needs editor access to it")
        }
        if (t.version !== p.ifVersion) {
          throw new TableError(
            "version_conflict",
            `the table is at version ${t.version}, not ${p.ifVersion}`,
          )
        }
        if (p.columns) {
          applyColumnOps(
            t.columns,
            t.droppedKeys.map((key) => ({ key, label: key, type: "text" as const })),
            p.columns,
          )
        }
        return null
      })
    },
  })
  registerApprovalSummarizer(orgId, "kernel", "tables_edit", summarizeEdit)
  approvalResourceOwnerRegistry.set([orgId, "kernel", "tables_edit"], {
    resolveOwner: (params, ctx) =>
      params.action === "create"
        ? createDecider(ctx.orgId, params, ctx.requestedBy)
        : tableDecider(ctx.orgId, params.tableId, ctx.requestedBy),
  })
}
