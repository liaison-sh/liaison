// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Importing Claude Code sessions from the owner's computer (S40, S42, A47),
 * mounted at `/api/me/node-session-imports`:
 *
 *   GET  /?nodeId=<id>&query=<text>   the node's importable sessions:
 *        {rows: [{candidateId | null, title, firstPrompt, folderName,
 *        worktreePath? (D53: the shared repo's worktree outside the folder), cwdSubdir,
 *        branch, lastModified, createdAt, sizeBytes, from, liveNow,
 *        inLiaison: sessionId | null}], truncated, folders?: [{name, sessions}],
 *        unshared?: [{candidateId | null, name, display, sessions, lastModified,
 *        refusal}], skipped?, unsharedPartial?}. `query` only for a search
 *        the person submits over a truncated listing (D47); `folder` lists one
 *        shared folder (S12). The optional fields come from a node that knows
 *        them (A1); an unshared group is shared by its `candidateId` through
 *        `POST /api/nodes/:id/folders/share`.
 *   POST / {candidateId, mode: follow|take_over}   -> 201 {sessionId}
 *
 * Owner-only: a node credential is refused (403), a restricted device session
 * too (session-ceiling.ts), and a node or a candidate that is not the
 * caller's is not found. The CLI session id never leaves the server.
 * Refusals: `node_offline`, `node_outdated`, `import_in_flight`,
 * `already_in_liaison` {sessionId} (409); `timeout` (504); the node's own
 * codes (422).
 */
import { NODE_IMPORT_MODES } from "@liaison/shared"
import { and, eq, isNull } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { nodes } from "~/db/schema/kernel"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import { NODE_CREDENTIAL_HEADER } from "~/modules/nodes/credentials"
import { importStart, listImportable } from "./import"

export const meNodeSessionImportRoutes = new Hono<AppEnv>()

const err = (code: string, message: string, detail: Record<string, unknown> = {}) => ({
  error: { code, message, ...detail },
})

const listQuery = z
  .object({
    nodeId: z.string().uuid(),
    query: z.string().trim().min(1).max(100).optional(),
    folder: z.string().trim().min(1).max(200).optional(),
  })
  .strict()

const startBody = z
  .object({ candidateId: z.string().uuid(), mode: z.enum(NODE_IMPORT_MODES) })
  .strict()

meNodeSessionImportRoutes.use("*", async (c, next) => {
  if (c.req.header(NODE_CREDENTIAL_HEADER) !== undefined) {
    return c.json(
      err("node_credential_refused", "Sessions are imported by their owner in the app."),
      403,
    )
  }
  await next()
})

/** A refusal as a response: its status from its code. */
function refusal(c: Context<AppEnv>, code: string, detail: Record<string, unknown> = {}) {
  switch (code) {
    case "not_found":
      return c.json(err(code, "List the sessions again, then import one."), 404)
    case "node_offline":
      return c.json(err(code, "That computer is offline."), 409)
    case "node_outdated":
      return c.json(err(code, "Update Liaison on that computer to import its sessions."), 409)
    case "import_in_flight":
      return c.json(err(code, "Another import is starting on that computer."), 409)
    case "already_in_liaison":
      return c.json(err(code, "This session is already in Liaison.", detail), 409)
    case "model_unavailable":
      return c.json(err(code, "That computer offers no model."), 409)
    case "timeout":
      return c.json(err(code, "That computer did not answer in time."), 504)
    default:
      return c.json(err(code, "That computer refused the import."), 422)
  }
}

/** The caller's own live node, read through their RLS, or null. */
async function ownNode(c: Context<AppEnv>, id: string): Promise<boolean> {
  const [row] = await withRequestRls(c, (tx) =>
    tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.id, id),
          eq(nodes.orgId, c.get("orgId")),
          eq(nodes.ownerUserId, c.get("userId")),
          isNull(nodes.revokedAt),
        ),
      )
      .limit(1),
  )
  return row !== undefined
}

meNodeSessionImportRoutes.get(
  "/",
  requireScope("kernel:threads:read"),
  zValidator("query", listQuery),
  async (c) => {
    assertUnrestrictedSession(c, "list the sessions of your computer")
    const { nodeId, query, folder } = c.req.valid("query")
    if (!(await ownNode(c, nodeId))) return c.json(err("not_found", "No such node."), 404)
    const listed = await listImportable({
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      nodeId,
      ...(query ? { query } : {}),
      ...(folder ? { folder } : {}),
      detail: true,
    })
    if (listed.status !== "done") return refusal(c, listed.code)
    const { status: _done, ...listing } = listed
    return success(c, listing)
  },
)

meNodeSessionImportRoutes.post(
  "/",
  requireScope("kernel:threads:write"),
  zValidator("json", startBody),
  async (c) => {
    assertUnrestrictedSession(c, "import a session of your computer")
    const { candidateId, mode } = c.req.valid("json")
    const outcome = await importStart({
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      candidateId,
      mode,
    })
    if (!outcome.ok) {
      const { ok: _refused, code, ...detail } = outcome
      return refusal(c, code, detail)
    }
    return success(c, { sessionId: outcome.sessionId }, undefined, 201)
  },
)
