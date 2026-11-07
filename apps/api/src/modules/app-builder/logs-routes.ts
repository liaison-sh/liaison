// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET /api/apps/:name/logs: what an app logged (logs.ts), newest first, for a
// holder of kernel:apps:logs. The database returns only the lines whose run
// read nothing the reader's scopes do not cover, and never another person's
// draft preview lines.
//
// Query: since (ISO time), level (lowest level: debug|info|warn|error), runId,
// limit (1-200, default 100). Errors: 400 invalid_query, 403 forbidden.

import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import { READ_APP_LOGS_MAX_LIMIT, readAppLogs } from "~/modules/app-builder/logs"

const nameParam = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/) })
const logsQuery = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  runId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(READ_APP_LOGS_MAX_LIMIT).optional(),
})

export const appLogsRoutes = new Hono<AppEnv>().get(
  "/:name/logs",
  requireScope("kernel:apps:logs"),
  zValidator("param", nameParam),
  zValidator("query", logsQuery),
  async (c) => {
    const { name } = c.req.valid("param")
    const q = c.req.valid("query")
    const logs = await withRequestRls(c, (tx) =>
      readAppLogs(tx, {
        app: name,
        ...(q.since ? { since: new Date(q.since) } : {}),
        ...(q.level ? { level: q.level } : {}),
        ...(q.runId ? { runId: q.runId } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      }),
    )
    return success(c, logs)
  },
)
