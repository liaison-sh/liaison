// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The owner's reads and the app start of node sessions (spec-protocol.md,
 * client reads), mounted at `/api/me/node-sessions`:
 *
 *   GET   /?group=needs_you|running|done|failed|older&cursor=   the owner's sessions, pages of 50
 *   GET   /:id                                    one session row (never its folder path)
 *   GET   /:id/events?after=<seq>&limit=<=500>    its events after a seq, in seq order
 *         &scope=top       S53 (D20): the main thread's events only (no `parentToolUseId`)
 *         &parent=<id>     S53: one subagent's events only (its Agent call's tool use id)
 *       Both answer `through`: the seq up to which the read is complete (the
 *       last event of a full page, else the session's lastSeq), so a client
 *       holding one scope moves past the events of the other. Without either,
 *       every event (older clients rely on contiguous seqs).
 *         &before=<seq>    S56 (D30): the last `limit` events below a seq instead,
 *                          still in seq order and in the scope asked (the web's
 *                          "load earlier": it holds a recent window only); no
 *                          `through`. Not with `after`. One event again by seq
 *                          (an elided output) is `after=<seq-1>&limit=1`.
 *   GET   /:id/files-changed?hunks=1             S53 (D29): what it changed per file, from
 *                                                 every applied Edit, MultiEdit and Write,
 *                                                 subagents' included (the web holds the
 *                                                 main thread only); paths relative, never
 *                                                 absolute; the diff hunks only with hunks=1
 *   PATCH /:id {muted}                            mute or unmute its notices (S14)
 *   DELETE /:id                                   A49, A61: remove an import from Liaison only
 *   POST  /                                       start a session from the app (P1-T19)
 *
 * Every read goes through the caller's own RLS (node_sessions_owner_read):
 * another user, an org admin included, sees nothing and gets 404.
 *
 * Groups (S9): needs_you = waiting, and needs_you ended within 30 days,
 * oldest need first (by the end, else updated_at); running = queued,
 * running, paused, by updated_at; done = every ended status ended within 30
 * days (what older clients' `done` shows; newer clients file each row by its
 * own state); failed = failed and stopped ended within 30 days; older = every
 * ended status ended earlier. Ended groups are ordered by ended_at, newest
 * first. Ties by id; the cursor is base64url JSON `{t, id}` of the last row.
 * The old id `waiting` answers the needs_you group (phone builds before
 * round 2). Rows go out with `status` legacy-safe and `state` true (D14).
 */
import {
  AUTONOMY_LEVELS,
  EFFORT_LEVELS,
  FINISH_WITH,
  type FileChange,
  filesChanged,
  NODE_LEVELS,
  NODE_SESSION_ENDED_STATUSES,
  sessionStartCwd,
} from "@liaison/shared"
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { nodeSessionEvents, nodeSessions } from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import { createAppSession } from "./create"
import { deleteImportedSession, fanOut, publicRow, setSessionMuted, toStoredEvent } from "./store"

export const meNodeSessionRoutes = new Hono<AppEnv>()

export const NODE_SESSION_PAGE = 50
export const NODE_SESSION_EVENTS_PAGE = 500
const DONE_WINDOW = sql`now() - interval '30 days'`

export const NODE_SESSION_GROUPS = [
  "needs_you",
  "running",
  "done",
  "failed",
  "older",
  // The old id of the needs_you group, still asked by older phone builds.
  "waiting",
] as const
type Group = Exclude<(typeof NODE_SESSION_GROUPS)[number], "waiting">

const listQuery = z.object({
  group: z.enum(NODE_SESSION_GROUPS),
  cursor: z.string().max(400).optional(),
  // S9: a client of this wave says so; `done` then lists done only. Without
  // it, `done` is the old group (done, failed and stopped) of older builds.
  v: z.literal("2").optional(),
})
const idParam = z.object({ id: z.string().uuid() })
const eventsQuery = z
  .object({
    after: z.coerce.number().int().min(0).optional(),
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(NODE_SESSION_EVENTS_PAGE)
      .default(NODE_SESSION_EVENTS_PAGE),
    scope: z.enum(["all", "top"]).optional(),
    parent: z.string().min(1).max(200).optional(),
  })
  .refine((q) => q.after === undefined || q.before === undefined, {
    message: "after and before are exclusive",
  })

interface Cursor {
  t: string
  id: string
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url")
}

/** A Postgres timestamptz text, as `::text` prints it. */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2})?|Z)$/

function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor
    if (typeof c?.t !== "string" || typeof c?.id !== "string") return null
    if (!CURSOR_TIME.test(c.t)) return null
    if (!/^[0-9a-f-]{36}$/i.test(c.id)) return null
    return c
  } catch {
    return null
  }
}

const ENDED = [...NODE_SESSION_ENDED_STATUSES]

/** The sort time of a group's rows: updated_at for live ones, the end for ended ones. */
function sortKey(group: Group): SQL<Date> {
  return group === "running"
    ? sql<Date>`${nodeSessions.updatedAt}`
    : sql<Date>`coalesce(${nodeSessions.endedAt}, ${nodeSessions.updatedAt})`
}

/** The needs_you group reads oldest need first; every other group newest first. */
const ascending = (group: Group) => group === "needs_you"

function groupFilter(group: Group, current: boolean): SQL | undefined {
  const recent = sql`${sortKey(group)} >= ${DONE_WINDOW}`
  switch (group) {
    case "needs_you":
      return or(
        eq(nodeSessions.status, "waiting"),
        and(eq(nodeSessions.status, "needs_you"), recent),
      )
    case "running":
      return inArray(nodeSessions.status, ["queued", "running", "paused"])
    case "done":
      return and(
        current
          ? eq(nodeSessions.status, "done")
          : inArray(nodeSessions.status, ["done", "failed", "stopped"]),
        recent,
      )
    case "failed":
      return and(inArray(nodeSessions.status, ["failed", "stopped"]), recent)
    case "older":
      return and(inArray(nodeSessions.status, ENDED), sql`${sortKey("older")} < ${DONE_WINDOW}`)
  }
}

const notFound = { error: { code: "not_found", message: "No such session." } }

meNodeSessionRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const { group: asked, cursor: rawCursor, v } = c.req.valid("query")
  const group: Group = asked === "waiting" ? "needs_you" : asked
  const cursor = rawCursor ? decodeCursor(rawCursor) : null
  if (rawCursor && !cursor) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "cursor: invalid" } }, 400)
  }
  const key = sortKey(group)
  // The cursor keeps the database's own microsecond text of the sort time, so
  // the next page starts exactly after the last row (a millisecond ISO would
  // skip rows inside the same millisecond).
  const at = cursor ? sql`${cursor.t}::timestamptz` : null
  const up = ascending(group)
  const after =
    cursor && at
      ? or(up ? gt(key, at) : lt(key, at), and(eq(key, at), gt(nodeSessions.id, cursor.id)))
      : undefined
  const rows = await withRequestRls(c, (tx) =>
    tx
      .select({ row: nodeSessions, sortAt: sql<string>`${key}::text` })
      .from(nodeSessions)
      .where(
        and(
          eq(nodeSessions.orgId, c.get("orgId")),
          eq(nodeSessions.ownerUserId, c.get("userId")),
          groupFilter(group, v === "2"),
          after,
        ),
      )
      .orderBy(up ? asc(key) : desc(key), asc(nodeSessions.id))
      .limit(NODE_SESSION_PAGE + 1),
  )
  const page = rows.slice(0, NODE_SESSION_PAGE)
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > NODE_SESSION_PAGE && last
      ? encodeCursor({ t: last.sortAt, id: last.row.id })
      : null
  return success(c, { sessions: page.map((r) => publicRow(r.row)), nextCursor })
})

meNodeSessionRoutes.get("/:id", zValidator("param", idParam), async (c) => {
  const [row] = await withRequestRls(c, (tx) =>
    tx
      .select()
      .from(nodeSessions)
      .where(
        and(eq(nodeSessions.id, c.req.valid("param").id), eq(nodeSessions.orgId, c.get("orgId"))),
      )
      .limit(1),
  )
  if (!row) return c.json(notFound, 404)
  return success(c, publicRow(row))
})

const muteSchema = z.object({ muted: z.boolean() }).strict()

// S14: the owner mutes a session's notices (the in-app row is still written).
// The session tables grant the app role SELECT only (0140): the owner is
// checked through their own RLS, then the store writes it (privileged).
meNodeSessionRoutes.patch(
  "/:id",
  requireScope("kernel:threads:write"),
  zValidator("param", idParam),
  zValidator("json", muteSchema),
  async (c) => {
    // Like steering and starting one: a restricted device session may not.
    assertUnrestrictedSession(c, "mute a session on your computer")
    const id = c.req.valid("param").id
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const [mine] = await withRequestRls(c, (tx) =>
      tx
        .select({ id: nodeSessions.id })
        .from(nodeSessions)
        .where(
          and(
            eq(nodeSessions.id, id),
            eq(nodeSessions.orgId, orgId),
            eq(nodeSessions.ownerUserId, userId),
          ),
        )
        .limit(1),
    )
    if (!mine) return c.json(notFound, 404)
    const row = await setSessionMuted(orgId, userId, id, c.req.valid("json").muted)
    if (!row) return c.json(notFound, 404)
    await fanOut(row, [])
    return success(c, publicRow(row))
  },
)

meNodeSessionRoutes.get(
  "/:id/events",
  zValidator("param", idParam),
  zValidator("query", eventsQuery),
  async (c) => {
    const id = c.req.valid("param").id
    const { after: afterQ, before, limit, scope, parent } = c.req.valid("query")
    const after = afterQ ?? 0
    const scoped = parent !== undefined || scope === "top"
    const filter = parent
      ? eq(nodeSessionEvents.parentToolUseId, parent)
      : scope === "top"
        ? isNull(nodeSessionEvents.parentToolUseId)
        : undefined
    const found = await withRequestRls(c, async (tx) => {
      const [row] = await tx
        .select({ lastSeq: nodeSessions.lastSeq })
        .from(nodeSessions)
        .where(and(eq(nodeSessions.id, id), eq(nodeSessions.orgId, c.get("orgId"))))
        .limit(1)
      if (!row) return null
      if (before !== undefined) {
        const newest = await tx
          .select()
          .from(nodeSessionEvents)
          .where(
            and(eq(nodeSessionEvents.sessionId, id), lt(nodeSessionEvents.seq, before), filter),
          )
          .orderBy(desc(nodeSessionEvents.seq))
          .limit(limit)
        return { lastSeq: row.lastSeq, events: newest.reverse() }
      }
      const events = await tx
        .select()
        .from(nodeSessionEvents)
        .where(and(eq(nodeSessionEvents.sessionId, id), gt(nodeSessionEvents.seq, after), filter))
        .orderBy(asc(nodeSessionEvents.seq))
        .limit(limit)
      return { lastSeq: row.lastSeq, events }
    })
    if (!found) return c.json(notFound, 404)
    const events = found.events.map(toStoredEvent)
    if (!scoped || before !== undefined) return success(c, { events, lastSeq: found.lastSeq })
    // The row was read first: every event up to its lastSeq is committed and
    // was visible to the event query, so a short page covers through there.
    const last = events.at(-1)?.seq ?? after
    const through = events.length === limit ? last : Math.max(found.lastSeq, last, after)
    return success(c, { events, lastSeq: found.lastSeq, through })
  },
)

const FILE_TOOLS = ["Edit", "MultiEdit", "Write"]
/** The most edit calls a files-changed read reads (a session past it shows its first ones). */
const FILES_CHANGED_MAX_CALLS = 5000

/**
 * D31d: the summary is computed when asked and kept per (session, last seq),
 * hunks included, so the reads of every open view and the drawer's hunks cost
 * one computation per change of the session. Read only after the row passed
 * RLS, so it never answers someone the row would not. The latest seq per
 * session, least recently used out first.
 */
const FILES_CHANGED_CACHE_MAX = 64
const filesChangedCache = new Map<string, { lastSeq: number; files: FileChange[] }>()
function cachedFilesChanged(sessionId: string, lastSeq: number): FileChange[] | null {
  const hit = filesChangedCache.get(sessionId)
  if (!hit || hit.lastSeq !== lastSeq) return null
  filesChangedCache.delete(sessionId)
  filesChangedCache.set(sessionId, hit)
  return hit.files
}
function cacheFilesChanged(sessionId: string, lastSeq: number, files: FileChange[]): void {
  filesChangedCache.delete(sessionId)
  filesChangedCache.set(sessionId, { lastSeq, files })
  while (filesChangedCache.size > FILES_CHANGED_CACHE_MAX) {
    const oldest = filesChangedCache.keys().next().value
    if (oldest === undefined) break
    filesChangedCache.delete(oldest)
  }
}

meNodeSessionRoutes.get(
  "/:id/files-changed",
  zValidator("param", idParam),
  zValidator("query", z.object({ hunks: z.literal("1").optional() })),
  async (c) => {
    const id = c.req.valid("param").id
    const withHunks = c.req.valid("query").hunks === "1"
    const found = await withRequestRls(c, async (tx) => {
      const [row] = await tx
        .select({
          id: nodeSessions.id,
          folderName: nodeSessions.folderName,
          repo: nodeSessions.repo,
          lastSeq: nodeSessions.lastSeq,
        })
        .from(nodeSessions)
        .where(and(eq(nodeSessions.id, id), eq(nodeSessions.orgId, c.get("orgId"))))
        .limit(1)
      if (!row) return null
      const cached = cachedFilesChanged(row.id, row.lastSeq)
      if (cached) return { row, files: cached, events: null }
      const calls = await tx
        .select({
          seq: nodeSessionEvents.seq,
          type: nodeSessionEvents.type,
          payload: nodeSessionEvents.payload,
          truncated: nodeSessionEvents.truncated,
        })
        .from(nodeSessionEvents)
        .where(
          and(
            eq(nodeSessionEvents.sessionId, id),
            or(
              and(
                eq(nodeSessionEvents.type, "tool_call"),
                inArray(sql<string>`${nodeSessionEvents.payload}->>'name'`, FILE_TOOLS),
              ),
              and(
                eq(nodeSessionEvents.type, "system"),
                eq(sql<string>`${nodeSessionEvents.payload}->>'subtype'`, "start"),
              ),
            ),
          ),
        )
        .orderBy(asc(nodeSessionEvents.seq))
        .limit(FILES_CHANGED_MAX_CALLS)
      const ids = calls
        .filter((e) => e.type === "tool_call")
        .map((e) => (e.payload as { id?: unknown }).id)
        .filter((v): v is string => typeof v === "string")
      // Only whether each call succeeded: never the results' output.
      const results =
        ids.length === 0
          ? []
          : await tx
              .select({
                seq: nodeSessionEvents.seq,
                type: nodeSessionEvents.type,
                payload: sql<
                  Record<string, unknown>
                >`jsonb_build_object('id', ${nodeSessionEvents.payload}->'id', 'isError', ${nodeSessionEvents.payload}->'isError')`,
              })
              .from(nodeSessionEvents)
              .where(
                and(
                  eq(nodeSessionEvents.sessionId, id),
                  eq(nodeSessionEvents.type, "tool_result"),
                  inArray(sql<string>`${nodeSessionEvents.payload}->>'id'`, ids),
                ),
              )
      return { row, files: null, events: [...calls, ...results] }
    })
    if (!found) return c.json(notFound, 404)
    let files = found.files
    if (!files) {
      // Computed outside the transaction: the diff holds no connection.
      const events = (found.events ?? []).map((e) => ({
        seq: e.seq,
        type: e.type,
        payload: e.payload as Record<string, unknown>,
        ...("truncated" in e && e.truncated ? { truncated: true } : {}),
      })) as Parameters<typeof filesChanged>[0]
      files = filesChanged(events, {
        cwd: sessionStartCwd(events),
        folderName: found.row.folderName,
        sessionId: found.row.id,
        repo: found.row.repo,
      })
      cacheFilesChanged(found.row.id, found.row.lastSeq, files)
    }
    return success(c, {
      files: files.map(({ hunks, ...f }) => (withHunks ? { ...f, hunks } : f)),
    })
  },
)

const startSchema = z
  .object({
    prompt: z.string().min(1).max(200_000),
    folderName: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200),
    agentId: z.string().uuid().optional(),
    level: z.enum(NODE_LEVELS).optional(),
    // S23: the reasoning effort; absent or null: the model's default.
    effort: z.enum(EFFORT_LEVELS).nullable().optional(),
    // S30: guided (absent) or autonomous.
    autonomy: z.enum(AUTONOMY_LEVELS).optional(),
    // S57: how it finishes; absent or null: a pull request when the folder is a
    // repository (the node decides), nothing otherwise.
    finishWith: z.enum(FINISH_WITH).nullable().optional(),
    confirmationId: z.string().uuid().optional(),
    // Every confirmation the app made for this start (m6); the bound one wins.
    confirmationIds: z.array(z.string().uuid()).max(10).optional(),
  })
  .strict()

const START_REFUSALS = {
  agent_not_yours: { status: 403, message: "This agent is not yours to run." },
  no_node: { status: 409, message: "None of your computers can run this session." },
  folder_unresolved: { status: 422, message: "No shared folder has that name." },
  model_unavailable: { status: 422, message: "That computer does not offer this model." },
  confirmation_required: {
    status: 403,
    message: "Confirm this level in the app before the session starts.",
  },
} as const

// A session runs Claude Code on the owner's computer with the agent's Liaison
// tools, which act on the user's stored grants, not the token's cap: gated
// like `run_on_my_computer` (kernel:threads:write) and refused to a restricted
// device session (session-ceiling.ts), like the level confirmation route.
meNodeSessionRoutes.post(
  "/",
  requireScope("kernel:threads:write"),
  zValidator("json", startSchema),
  async (c) => {
    assertUnrestrictedSession(c, "start a session on your computer")
    const body = c.req.valid("json")
    const outcome = await createAppSession({
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      ...body,
    })
    if (!outcome.ok) {
      const { ok: _refused, code, ...detail } = outcome
      const refusal = START_REFUSALS[code]
      return c.json({ error: { code, message: refusal.message, ...detail } }, refusal.status)
    }
    const [row] = await withRequestRls(c, (tx) =>
      tx
        .select()
        .from(nodeSessions)
        .where(and(eq(nodeSessions.id, outcome.sessionId), eq(nodeSessions.orgId, c.get("orgId"))))
        .limit(1),
    )
    return success(c, publicRow(row), undefined, 201)
  },
)

/**
 * A49, A61: delete an import from Liaison. Owner only (another user's id is
 * 404 through RLS); an import only (409 `not_import`); a live run refuses
 * (409 `session_live`), a live follow is cancelled (its node's next heartbeat
 * is stale and its host drops the follow). One privileged transaction in the
 * store (`deleteImportedSession`), as
 * production runs it (`liaison_admin`): every queued or offered job of the
 * session is cancelled (a later claim gets `not_claimable`), the session is
 * deleted (its events, commands and confirmations cascade as the table
 * owner) with the owner's attention rows about it. Nothing on the node is
 * touched: not the folder, not the transcript.
 */
meNodeSessionRoutes.delete(
  "/:id",
  requireScope("kernel:threads:write"),
  zValidator("param", idParam),
  async (c) => {
    assertUnrestrictedSession(c, "delete a session from Liaison")
    const id = c.req.valid("param").id
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const [mine] = await withRequestRls(c, (tx) =>
      tx
        .select({ id: nodeSessions.id })
        .from(nodeSessions)
        .where(
          and(
            eq(nodeSessions.id, id),
            eq(nodeSessions.orgId, orgId),
            eq(nodeSessions.ownerUserId, userId),
          ),
        )
        .limit(1),
    )
    if (!mine) return c.json(notFound, 404)
    const outcome = await deleteImportedSession(orgId, userId, id)
    if (outcome === "not_found") return c.json(notFound, 404)
    if (outcome !== "deleted") {
      return c.json({ error: { code: outcome, message: DELETE_REFUSALS[outcome] } }, 409)
    }
    // The owner's clients drop the row. No `id` in the data: an older client
    // that reads every `node_session` frame as a row ignores it.
    try {
      await broadcastEphemeral({
        app: "kernel",
        entity: "node_session",
        action: "delete",
        entityId: id,
        orgId,
        data: { ownerUserId: userId, sessionId: id, deleted: true },
      })
    } catch {
      // Best effort: the list's next pull no longer has the row.
    }
    return success(c, { id, deleted: true })
  },
)

const DELETE_REFUSALS = {
  not_import: "Only an imported session can be deleted from Liaison.",
  session_live: "This session is running. Stop it first, then delete it.",
} as const
