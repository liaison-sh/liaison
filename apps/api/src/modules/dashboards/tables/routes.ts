// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/dashboards/tables: a person's tables (service.ts), under their RLS. A person with editor
// access never needs an approval: their scopes and the table's sharing decide (the agent's tools
// add the approvals, tools.ts). Errors: {error: {code, message, details: {column?, rowId?,
// current?}}} with the codes of TableErrorCode.

import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRlsContext } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { restToolCall } from "~/modules/apps/rest-tool-call"
import { searchLinkTargets } from "~/modules/dashboards/tables/link-search"
import {
  createTable,
  deleteTable,
  getTable,
  getTableSharing,
  listChanges,
  listRows,
  listTables,
  MAX_OPS_PER_WRITE,
  setTableSharing,
  TABLE_ERROR_STATUS,
  TableError,
  undoChange,
  updateTable,
  writeRows,
} from "~/modules/dashboards/tables/service"

export const tablesRoutes = new Hono<AppEnv>()

const idParam = z.object({ id: z.string().uuid() })
const changeParam = z.object({ id: z.string().uuid(), changeId: z.string().uuid() })
const orgAccess = z.enum(["none", "viewer", "editor"])
const shareRole = z.enum(["viewer", "editor"])

const createBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
    columns: z.array(z.unknown()).max(40),
    agentWritesNeedApproval: z.boolean().optional(),
    fromDashboardId: z.string().uuid().optional(),
  })
  .strict()

const updateBody = z
  .object({
    ifVersion: z.number().int().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
    agentWritesNeedApproval: z.boolean().optional(),
    columns: z
      .object({
        add: z.array(z.unknown()).max(40).optional(),
        rename: z
          .array(z.object({ key: z.string(), label: z.string() }).strict())
          .max(40)
          .optional(),
        setChoices: z
          .array(z.object({ key: z.string(), choices: z.array(z.string()).max(100) }).strict())
          .max(40)
          .optional(),
        drop: z.array(z.string()).max(40).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const cells = z.record(z.string(), z.unknown())
const rowOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), cells }).strict(),
  z
    .object({
      op: z.literal("update"),
      id: z.string().min(1).max(200),
      ifVersion: z.number().int().min(1),
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
const rowsBody = z.object({ ops: z.array(rowOp).min(1).max(MAX_OPS_PER_WRITE) }).strict()

const limitParam = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
const rowsQuery = z.object({
  limit: limitParam.optional(),
  cursor: z.string().max(4096).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  q: z.string().max(100).optional(),
})
const changesQuery = z.object({
  rowId: z.string().max(200).optional(),
  limit: limitParam.optional(),
  cursor: z.string().max(4096).optional(),
})
const linkQuery = z.object({
  // Absent for a link column with no `linkTo`: any record the person can find.
  app: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,62}$/)
    .optional(),
  entityType: z.string().max(63).optional(),
  q: z.string().max(100).default(""),
})

const sharingBody = z
  .object({
    orgAccess: orgAccess.optional(),
    users: z
      .array(z.object({ userId: z.string().uuid(), role: shareRole }).strict())
      .max(200)
      .optional(),
    roles: z
      .array(z.object({ roleId: z.string().uuid(), role: shareRole }).strict())
      .max(100)
      .optional(),
  })
  .strict()

/** A refusal as the contract's error body; anything else goes to the error handler. */
export function tableFailure(c: Context<AppEnv>, err: unknown) {
  if (err instanceof TableError) {
    const d = err.details
    const details = {
      ...(d.column ? { column: d.column } : {}),
      ...(d.rowId ? { rowId: d.rowId } : {}),
      ...(d.current !== undefined ? { current: d.current } : {}),
    }
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(Object.keys(details).length ? { details } : {}),
        },
      },
      TABLE_ERROR_STATUS[err.code],
    )
  }
  throw err as Error
}

async function run<T>(c: Context<AppEnv>, fn: () => Promise<T>, status?: 201) {
  try {
    return success(c, await fn(), undefined, status)
  } catch (err) {
    return tableFailure(c, err)
  }
}

tablesRoutes
  .get("/", (c) => run(c, async () => ({ tables: await listTables(extractRlsContext(c)) })))
  .post("/", zValidator("json", createBody), (c) =>
    run(c, () => createTable(extractRlsContext(c), c.req.valid("json")), 201),
  )
  // Link picking (A18): records of an app's entity, as the person sees them.
  .get("/link-search", zValidator("query", linkQuery), (c) =>
    run(c, async () => {
      const q = c.req.valid("query")
      return {
        items: await searchLinkTargets(
          extractRlsContext(c),
          { app: q.app, entityType: q.entityType, q: q.q },
          await restToolCall(c),
        ),
      }
    }),
  )
  .get("/:id", zValidator("param", idParam), (c) =>
    run(c, () => getTable(extractRlsContext(c), c.req.valid("param").id)),
  )
  .patch("/:id", zValidator("param", idParam), zValidator("json", updateBody), (c) =>
    run(c, () => updateTable(extractRlsContext(c), c.req.valid("param").id, c.req.valid("json"))),
  )
  .delete("/:id", zValidator("param", idParam), (c) =>
    run(c, async () => {
      await deleteTable(extractRlsContext(c), c.req.valid("param").id)
      return { deleted: true }
    }),
  )
  .get("/:id/rows", zValidator("param", idParam), zValidator("query", rowsQuery), (c) =>
    run(c, () => listRows(extractRlsContext(c), c.req.valid("param").id, c.req.valid("query"))),
  )
  .post("/:id/rows", zValidator("param", idParam), zValidator("json", rowsBody), (c) =>
    run(c, async () => ({
      rows: await writeRows(extractRlsContext(c), c.req.valid("param").id, c.req.valid("json").ops),
    })),
  )
  .get("/:id/changes", zValidator("param", idParam), zValidator("query", changesQuery), (c) =>
    run(c, () => listChanges(extractRlsContext(c), c.req.valid("param").id, c.req.valid("query"))),
  )
  .post("/:id/changes/:changeId/undo", zValidator("param", changeParam), (c) =>
    run(c, () => {
      const p = c.req.valid("param")
      return undoChange(extractRlsContext(c), p.id, p.changeId)
    }),
  )
  .get("/:id/sharing", zValidator("param", idParam), (c) =>
    run(c, () => getTableSharing(extractRlsContext(c), c.req.valid("param").id)),
  )
  .put("/:id/sharing", zValidator("param", idParam), zValidator("json", sharingBody), (c) =>
    run(c, () =>
      setTableSharing(extractRlsContext(c), c.req.valid("param").id, c.req.valid("json")),
    ),
  )
