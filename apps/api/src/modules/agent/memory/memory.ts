// SPDX-License-Identifier: FSL-1.1-ALv2
// Typed agent user memory: entries belong to one of four semantic types
// (user / feedback / project / reference). Each entry has a slug `name`, a
// one-line `description` that surfaces in the MEMORY.md-style index, and a
// markdown `content` body. The reserved `_index` row holds the rendered
// index that the agent loads with its system prompt every turn.
import { isLegalMemorySlug, MEMORY_INDEX_PATH } from "@liaison/shared"
import { and, sql as drizzleSql, eq, isNull, ne, or } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { agentMemory, agents, agentThreadCheckpoints, threads } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import {
  fileToRow,
  listDirectory,
  pathForRow,
  resolvePath,
  rowToFile,
} from "~/modules/agent/memory/memory-tree"
import {
  assertExplicitRequiredScopes,
  currentTurnWriteScopes,
  normalizeRequiredScopes,
  scopeUnknownError,
} from "~/modules/agent/scopes/write-required-scopes"
import { filterByVisibility } from "~/services/security/visibility"

const _log = rootLogger.child({ module: "agent-memory" })

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const

interface MemoryContext {
  userId: string
  orgId: string
  db: RlsClient
  /**
   * The caller's EFFECTIVE scopes, set by `executeToolHandler` from the actor
   * (`ctx.scopes = actorScopes`). Over an agent-bound MCP connection that actor
   * already holds the intersected set (the grantor's live grants narrowed by
   * the agent's live ceiling), so this reads the SAME set the tool catalog
   * filters on rather than loading a second, wider one.
   *
   * Absent means no scopes, which is the fail-closed answer: a row carrying
   * requiredScopes is then hidden. An unscoped row (`requiredScopes: []`) is
   * visible either way, so today's untagged memories are unaffected.
   */
  scopes?: string[]
  /**
   * The agent whose TREE this call addresses, when it is not the caller's own
   * personal agent. The Memory tab's write for a role agent is the case: the
   * caller is a human, the tree belongs to the role agent, and every row this
   * call reads or writes is keyed on that agent. Absent means the caller's own
   * personal agent, which is the tool path and stays keyed exactly as before.
   */
  ownerAgentId?: string
  /**
   * The owning human of `ownerAgentId`, for rows written before the rekey that
   * still carry only `user_id`. Null for a role or system agent, which never
   * had one.
   */
  ownerLegacyUserId?: string | null
  /**
   * The write's clock: what the rows and the index lines this call writes are
   * stamped with. Absent means the wall clock, which every product path uses;
   * the seed engine passes its base time so a seeded tree, index dates
   * included, is the same for the same base time.
   */
  now?: Date
}

/**
 * The rows this call owns: the target agent's when one is named, the caller's
 * own otherwise. One predicate, so a read and the write that follows it can
 * never disagree about whose tree they are in.
 */
function ownedRows(ctx: MemoryContext) {
  if (!ctx.ownerAgentId) return eq(agentMemory.userId, ctx.userId)
  if (!ctx.ownerLegacyUserId) return eq(agentMemory.ownerAgentId, ctx.ownerAgentId)
  return or(
    eq(agentMemory.ownerAgentId, ctx.ownerAgentId),
    and(isNull(agentMemory.ownerAgentId), eq(agentMemory.userId, ctx.ownerLegacyUserId)),
  )
}

/** The viewer a memory read is filtered against: this caller, these grants. */
function memoryViewer(ctx: MemoryContext): { userId: string; grants: string[] } {
  return { userId: ctx.userId, grants: ctx.scopes ?? [] }
}

function assertNotReserved(type: string, name: string): void {
  if (type === "_index" || name === "_index") {
    throw new Error("Memory type/name '_index' is reserved")
  }
}

function assertKnownType(type: string): void {
  if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Unknown memory type '${type}'. Expected one of: ${MEMORY_TYPES.join(", ")}`)
  }
}

/**
 * Resolve the acting user's personal agent id for a memory write (rekey,
 * migration 0055). A plain SELECT under the caller's own RLS connection is
 * enough — `agents_select` (0045) grants org-wide read, so no privileged
 * connection is needed here. Returns `null` when the user has no personal
 * agent yet (legacy/test-seeded user never run through bootstrapRegister):
 * the row is still written, just without an owner, matching the column's
 * nullable declaration ahead of slice 1b's backfill+NOT NULL step.
 */
async function resolveOwnerAgentId(ctx: MemoryContext): Promise<string | null> {
  // An explicitly addressed tree is the owner, full stop: resolving the
  // caller's own personal agent here is what made a role agent's edit land in
  // the editor's tree.
  if (ctx.ownerAgentId) return ctx.ownerAgentId
  const [row] = await ctx.db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, ctx.orgId),
        eq(agents.ownerUserId, ctx.userId),
        eq(agents.kind, "personal"),
      ),
    )
    .limit(1)
  return row?.id ?? null
}

/**
 * The same call, re-keyed onto the tree of the agent the turn ACTS AS.
 *
 * `executeToolHandler` puts the acting agent on every tool ctx (FX3-1). The
 * verbs resolved the owner from the CALLER instead, so a role agent's own write
 * landed in the human operator's tree: unreadable to the agent on its next turn
 * (the tail reads MEMORY.md by `owner_agent_id`) and visible to a human who
 * never wrote it. An explicitly addressed tree (the Memory tab's REST write)
 * wins, and a turn with no acting agent keeps the caller's own keying, which is
 * the human path and the `user_memory_*` aliases' historical one.
 */
export async function memoryCtxForActingAgent<
  C extends MemoryContext & { actingAgentId?: string | null },
>(ctx: C): Promise<C> {
  if (ctx.ownerAgentId) return ctx
  const actingAgentId = ctx.actingAgentId
  if (!actingAgentId) return ctx
  const [agent] = await ctx.db
    .select({ id: agents.id, ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, actingAgentId)))
    .limit(1)
  if (!agent) return ctx
  // `ownerLegacyUserId` keeps a personal agent's pre-rekey rows (owner_agent_id
  // still null, user_id the human) inside `ownedRows`, so re-keying the turn
  // never hides a file the same agent wrote before the rekey.
  return { ...ctx, ownerAgentId: agent.id, ownerLegacyUserId: agent.ownerUserId }
}

export async function handleMemoryGet(
  params: { type?: string; name?: string },
  ctx: MemoryContext,
): Promise<
  | { index: string }
  | { type: string; name: string; description: string; content: string }
  | {
      entries: Array<{ type: string; name: string; description: string; content: string }>
    }
> {
  const { type, name } = params

  if (!type && !name) {
    return { index: await readIndexContent(ctx) }
  }

  if (type && name) {
    const rows = await ctx.db
      .select({
        type: agentMemory.type,
        name: agentMemory.name,
        description: agentMemory.description,
        content: agentMemory.content,
        requiredScopes: agentMemory.requiredScopes,
      })
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.orgId, ctx.orgId),
          ownedRows(ctx),
          eq(agentMemory.type, type),
          eq(agentMemory.name, name),
        ),
      )
    // The same single filter every scoped read goes through. A row the caller's
    // scopes do not cover reads as absent, never as "access denied": the
    // gateway's withheld-capability contract is silent omission.
    const [visible] = filterByVisibility(rows, memoryViewer(ctx))
    if (!visible) return { index: "" }
    const { requiredScopes: _rs, ...entry } = visible
    return entry
  }

  if (type) {
    const rows = await ctx.db
      .select({
        type: agentMemory.type,
        name: agentMemory.name,
        description: agentMemory.description,
        content: agentMemory.content,
        requiredScopes: agentMemory.requiredScopes,
      })
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.orgId, ctx.orgId),
          ownedRows(ctx),
          eq(agentMemory.type, type),
          ne(agentMemory.name, "_index"),
        ),
      )
    return {
      entries: filterByVisibility(rows, memoryViewer(ctx)).map(
        ({ requiredScopes: _rs, ...entry }) => entry,
      ),
    }
  }

  return { index: "" }
}

/** The sink name this module writes, for the explicit-argument error message. */
const MEMORY_SINK = "kernel.agent_memory"

/** A `text[]` literal built from a JS array, with no comma-splitting games. */
function textArraySql(values: string[]) {
  return drizzleSql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`
}

/**
 * The row's tag after this write: the union of what it already carried and
 * what this turn contributes. A write NEVER narrows an existing tag, because
 * the row's content still quotes whatever the earlier turn put there, so a
 * later low-scope edit must not make it visible to more people.
 */
function unionRequiredScopesSql(values: string[]) {
  return drizzleSql`ARRAY(SELECT DISTINCT s FROM unnest(${agentMemory.requiredScopes} || ${textArraySql(values)}) AS s ORDER BY s)`
}

/**
 * The `user_memory_set` tool entry point (D5). Memory is re-injected into every
 * later turn, so a row written during a turn inherits that turn's accumulated
 * requiredScopes; a turn whose taint cannot be established is refused rather
 * than writing an untagged row.
 */
export async function handleMemorySetTool(
  params: { type: string; name: string; description: string; content: string },
  ctx: MemoryContext & { scopes?: string[] },
): Promise<{ saved: true }> {
  const requiredScopes = currentTurnWriteScopes(ctx.scopes)
  if (requiredScopes === null) throw scopeUnknownError("user_memory_set")
  return handleMemorySet(params, ctx, requiredScopes)
}

export async function handleMemorySet(
  params: { type: string; name: string; description: string; content: string },
  ctx: MemoryContext,
  requiredScopes: string[],
): Promise<{ saved: true }> {
  assertExplicitRequiredScopes(requiredScopes, MEMORY_SINK)
  assertNotReserved(params.type, params.name)
  assertKnownType(params.type)

  const scopes = normalizeRequiredScopes(requiredScopes)
  const { type, name, description, content } = params
  const ownerAgentId = await resolveOwnerAgentId(ctx)
  const now = ctx.now ?? new Date()

  const [written] = await ctx.db
    .insert(agentMemory)
    .values({
      orgId: ctx.orgId,
      // The tree's owning human, never the caller: a role agent's row has none,
      // and stamping the editor there would put the row in the editor's own
      // legacy-keyed tree.
      userId: ctx.ownerAgentId ? (ctx.ownerLegacyUserId ?? null) : ctx.userId,
      ownerAgentId,
      type,
      name,
      content,
      description,
      // The row's path in the tree, kept in step with (type, name) on every
      // write so no row written after the backfill lands with a null path.
      path: `${type}/${name}.md`,
      // A write is a confirmation: the entry was just stated to still be true,
      // which is what keeps it off the index-full candidate list.
      lastConfirmedAt: now,
      ...(ctx.now ? { createdAt: ctx.now, updatedAt: ctx.now } : {}),
      requiredScopes: scopes,
    })
    .onConflictDoUpdate({
      target: [agentMemory.orgId, agentMemory.ownerAgentId, agentMemory.type, agentMemory.name],
      set: {
        description,
        content,
        path: `${type}/${name}.md`,
        lastConfirmedAt: now,
        updatedAt: now,
        requiredScopes: unionRequiredScopesSql(scopes),
      },
    })
    .returning({ updatedAt: agentMemory.updatedAt })

  // The index line carries the STORED timestamp, never a fresh one, so the
  // rendered index stays a pure function of the rows.
  await updateIndex(ctx, type, name, description, scopes, written?.updatedAt ?? now)
  return { saved: true }
}

/** Atomic partial-update — used by PATCH /api/agent/memories/:type/:name to
 *  avoid the read-modify-write race window the old route had (existence check
 *  then handleMemorySet). The DB-level COALESCE preserves unchanged columns
 *  in one round trip; if the row doesn't exist, returns `null` and the caller
 *  responds 404. The MEMORY.md index is refreshed only when the description
 *  actually changed. */
export async function handleMemoryPatch(
  params: { type: string; name: string; description?: string; content?: string },
  ctx: MemoryContext,
  requiredScopes: string[],
): Promise<{
  type: string
  name: string
  description: string
  content: string
  updatedAt: Date
} | null> {
  assertExplicitRequiredScopes(requiredScopes, MEMORY_SINK)
  assertNotReserved(params.type, params.name)
  assertKnownType(params.type)

  const patchScopes = normalizeRequiredScopes(requiredScopes)
  // A row the caller cannot READ must not be rewritable either, exactly as for
  // delete: without this, the scoped row a get hides could still be overwritten
  // by naming it, and the write's scope UNION meant the caller never even saw
  // what they replaced. Indistinguishable from "there was no such entry" (the
  // caller gets the same null the missing-row case returns, and the route turns
  // it into the same 404), because the silent omission is the contract.
  const existing = await ctx.db
    .select({ requiredScopes: agentMemory.requiredScopes })
    .from(agentMemory)
    .where(
      and(
        eq(agentMemory.orgId, ctx.orgId),
        ownedRows(ctx),
        eq(agentMemory.type, params.type),
        eq(agentMemory.name, params.name),
      ),
    )
  if (existing.length > 0 && filterByVisibility(existing, memoryViewer(ctx)).length === 0) {
    return null
  }

  const [row] = await ctx.db
    .update(agentMemory)
    .set({
      description: params.description ?? agentMemory.description,
      content: params.content ?? agentMemory.content,
      updatedAt: new Date(),
      requiredScopes: unionRequiredScopesSql(patchScopes),
    })
    .where(
      and(
        eq(agentMemory.orgId, ctx.orgId),
        ownedRows(ctx),
        eq(agentMemory.type, params.type),
        eq(agentMemory.name, params.name),
      ),
    )
    .returning({
      type: agentMemory.type,
      name: agentMemory.name,
      description: agentMemory.description,
      content: agentMemory.content,
      updatedAt: agentMemory.updatedAt,
    })
  if (!row) return null

  if (params.description !== undefined) {
    await updateIndex(ctx, row.type, row.name, row.description, patchScopes, row.updatedAt)
  }
  return row
}

export async function handleMemoryDelete(
  params: { type: string; name: string },
  ctx: MemoryContext,
): Promise<{ deleted: true }> {
  assertNotReserved(params.type, params.name)
  assertKnownType(params.type)

  const { type, name } = params
  // A row the caller cannot READ must not be deletable either: without this the
  // scoped row a get hides could still be erased by naming it.
  const target = await ctx.db
    .select({ requiredScopes: agentMemory.requiredScopes })
    .from(agentMemory)
    .where(
      and(
        eq(agentMemory.orgId, ctx.orgId),
        ownedRows(ctx),
        eq(agentMemory.type, type),
        eq(agentMemory.name, name),
      ),
    )
  if (target.length > 0 && filterByVisibility(target, memoryViewer(ctx)).length === 0) {
    // Indistinguishable from "there was no such entry", the same silent
    // omission the read gives.
    return { deleted: true }
  }
  await ctx.db
    .delete(agentMemory)
    .where(
      and(
        eq(agentMemory.orgId, ctx.orgId),
        ownedRows(ctx),
        eq(agentMemory.type, type),
        eq(agentMemory.name, name),
      ),
    )

  await removeFromIndex(ctx, type, name)
  return { deleted: true }
}

// --- Index helpers ---

// Format: `- [Description](type/name.md), YYYY-MM-DD`
//
// The link target is the entry's PATH in the memory tree, so a line the model
// reads is already the argument it passes to memory_view. The trailing date is
// the row's stored `updatedAt` rendered in UTC, never `new Date()`: the index
// must stay a pure function of the rows it summarises, or the same rows would
// render differently on two turns and rewrite a cached prefix.
//
// We anchor the per-entry parser tag on that path AT THE END OF LINE. A
// description cannot hijack another entry's tag line by accident: the suffix
// requires the closing `]` at the description boundary, the known path
// verbatim, and a trailing ISO date.
//
// Description is rendered verbatim, never parsed back out.
export function renderIndexLine(
  type: string,
  name: string,
  description: string,
  updatedAt: Date | string,
): string {
  return renderIndexLineForPath(`${type}/${name}.md`, description, updatedAt)
}

/**
 * The same line for a row whose path is already known (an episode folder, a
 * backfilled row). The index is a list of POINTERS: a line carries a path and a
 * one line description, never a body.
 */
export function renderIndexLineForPath(
  path: string,
  description: string,
  updatedAt: Date | string,
): string {
  const date = updatedAt instanceof Date ? updatedAt : new Date(updatedAt)
  return `- [${description}](${path}), ${date.toISOString().slice(0, 10)}`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Match this entry's own line, in the current form OR in the pre-tree em dash
 * form. The tolerant read is deliberate and lives for one release: an index
 * written before this format change is still editable, so an update replaces
 * its line instead of appending a second one for the same entry. New writes
 * always render the current form.
 */
function tagMatcher(type: string, name: string): RegExp {
  const escapedName = escapeRegex(name)
  const escapedType = escapeRegex(type)
  return new RegExp(
    `(\\]\\(${escapedType}\\/${escapedName}\\.md\\),\\s+\\d{4}-\\d{2}-\\d{2}$)` +
      `|(\\]\\(${escapedName}\\)\\s+—\\s+\\S+$)`,
  )
}

async function readIndexContent(ctx: MemoryContext): Promise<string> {
  const rows = await ctx.db
    .select({ content: agentMemory.content })
    .from(agentMemory)
    .where(
      and(
        eq(agentMemory.orgId, ctx.orgId),
        ownedRows(ctx),
        eq(agentMemory.type, "_index"),
        eq(agentMemory.name, "_index"),
      ),
    )
  return rows[0]?.content ?? ""
}

// --- MEMORY.md caps (P4m-T09) ---------------------------------------------
//
// The index is the only memory content that is always in context, so it is
// capped. Past the nag line the runtime context tail tells the model to
// consolidate; at the hard cap a write is REFUSED and names what to merge.
// It is never silently truncated: a truncated index loses entries the model
// then cannot find and does not know it has lost.

/** Lines past which the model is told the index is near its limit. */
export const MEMORY_INDEX_NAG_LINES = 160
/** Hard caps. A write that would exceed either is refused. */
export const MEMORY_INDEX_MAX_LINES = 200
export const MEMORY_INDEX_MAX_BYTES = 25_600
/** The exact copy, shown on the Memory tab and returned to the model. */
export const MEMORY_INDEX_FULL_MESSAGE =
  "MEMORY.md is full. Merge or remove an entry before adding one."

export interface MemoryIndexFill {
  lines: number
  bytes: number
  nearLimit: boolean
}

/** How full the index is. Pure, so the tail can report it without a write. */
export function memoryIndexFill(content: string): MemoryIndexFill {
  const lines = content.split("\n").filter((l) => l.trim() !== "").length
  return {
    lines,
    bytes: Buffer.byteLength(content, "utf8"),
    nearLimit: lines > MEMORY_INDEX_NAG_LINES,
  }
}

export interface MemoryIndexFullCandidate {
  path: string
  description: string
  lastConfirmedAt: Date | null
}

/**
 * A path with no file behind it, or none this turn may read. It is the agent's
 * own lookup coming back empty (an agent with no memory yet has no MEMORY.md),
 * so it carries a 404: the tool layers log a typed 4xx at warn and hand the
 * agent the message, instead of reporting a server fault.
 */
export class MemoryNotFoundError extends Error {
  readonly code = "E_MEMORY_NOT_FOUND"
  readonly status = 404
  constructor(path: string) {
    super(`No memory file at ${path}`)
    this.name = "MemoryNotFoundError"
  }
}

/** Structured so the model is told what to merge, not just that it failed. */
export class MemoryIndexFullError extends Error {
  readonly code = "E_MEMORY_INDEX_FULL"
  readonly candidates: MemoryIndexFullCandidate[]
  constructor(candidates: MemoryIndexFullCandidate[]) {
    super(MEMORY_INDEX_FULL_MESSAGE)
    this.name = "MemoryIndexFullError"
    this.candidates = candidates
  }
}

/**
 * The five entries it is safest to merge away: least recently confirmed first,
 * a never confirmed row before any confirmed one, `updatedAt` as the tie break.
 */
async function indexFullCandidates(ctx: MemoryContext): Promise<MemoryIndexFullCandidate[]> {
  const rows = await ctx.db
    .select({
      path: agentMemory.path,
      type: agentMemory.type,
      name: agentMemory.name,
      description: agentMemory.description,
      lastConfirmedAt: agentMemory.lastConfirmedAt,
    })
    .from(agentMemory)
    .where(and(eq(agentMemory.orgId, ctx.orgId), ownedRows(ctx), ne(agentMemory.type, "_index")))
    .orderBy(
      drizzleSql`${agentMemory.lastConfirmedAt} ASC NULLS FIRST`,
      drizzleSql`${agentMemory.updatedAt} ASC`,
    )
    .limit(5)
  return rows.map((row) => ({
    path: row.path ?? `${row.type}/${row.name}.md`,
    description: row.description,
    lastConfirmedAt: row.lastConfirmedAt,
  }))
}

async function assertIndexWithinCaps(ctx: MemoryContext, content: string): Promise<void> {
  const fill = memoryIndexFill(content)
  if (fill.lines <= MEMORY_INDEX_MAX_LINES && fill.bytes <= MEMORY_INDEX_MAX_BYTES) return
  throw new MemoryIndexFullError(await indexFullCandidates(ctx))
}

/**
 * The `_index` row quotes every entry's description and is loaded with the
 * system prompt on every later turn, so it carries the union of the tags of the
 * entries it summarises: whatever scopes an entry needed, its index line needs.
 *
 * THAT UNION IS RECOMPUTED, NEVER ACCUMULATED. It used to be
 * `existing || new`, which can only grow: a scope any memory ever carried
 * stayed on the index for the life of the agent, even after that memory was
 * deleted or rewritten. The index is injected into EVERY turn, so every reply
 * inherited the whole history of the tree: one `approvals_list` turn was
 * stored with seven scopes, `tickets:tickets:reply` and
 * `boxtal:shipments:read` among them, and hid from far more readers than its
 * data warranted (spec-security.md D3: the tag is what the turn READ).
 */
async function writeIndex(
  ctx: MemoryContext,
  content: string,
  requiredScopes: string[],
): Promise<void> {
  if (!content) {
    await ctx.db
      .delete(agentMemory)
      .where(
        and(
          eq(agentMemory.orgId, ctx.orgId),
          ownedRows(ctx),
          eq(agentMemory.type, "_index"),
          eq(agentMemory.name, "_index"),
        ),
      )
    return
  }
  await assertIndexWithinCaps(ctx, content)
  const ownerAgentId = await resolveOwnerAgentId(ctx)
  // The tags of the entries this index CURRENTLY holds, plus the tag of the
  // entry this write is about (its row may not be committed yet).
  const indexedRows = await ctx.db
    .select({ requiredScopes: agentMemory.requiredScopes })
    .from(agentMemory)
    .where(and(eq(agentMemory.orgId, ctx.orgId), ownedRows(ctx), ne(agentMemory.type, "_index")))
  const indexScopes = normalizeRequiredScopes([
    ...requiredScopes,
    ...indexedRows.flatMap((r) => r.requiredScopes ?? []),
  ])
  await ctx.db
    .insert(agentMemory)
    .values({
      orgId: ctx.orgId,
      // The tree's owning human, never the caller: a role agent's row has none,
      // and stamping the editor there would put the row in the editor's own
      // legacy-keyed tree.
      userId: ctx.ownerAgentId ? (ctx.ownerLegacyUserId ?? null) : ctx.userId,
      ownerAgentId,
      type: "_index",
      name: "_index",
      description: "index",
      path: MEMORY_INDEX_PATH,
      content,
      requiredScopes: indexScopes,
      ...(ctx.now ? { createdAt: ctx.now, updatedAt: ctx.now } : {}),
    })
    .onConflictDoUpdate({
      target: [agentMemory.orgId, agentMemory.ownerAgentId, agentMemory.type, agentMemory.name],
      set: {
        content,
        path: MEMORY_INDEX_PATH,
        updatedAt: ctx.now ?? new Date(),
        // SET, not union: see the note above.
        requiredScopes: indexScopes,
      },
    })
}

async function updateIndex(
  ctx: MemoryContext,
  type: string,
  name: string,
  description: string,
  requiredScopes: string[],
  updatedAt: Date | string,
): Promise<void> {
  const existing = await readIndexContent(ctx)
  const lines = existing.split("\n").filter((l) => l.trim() !== "")
  const newLine = renderIndexLine(type, name, description, updatedAt)
  const matcher = tagMatcher(type, name)
  const idx = lines.findIndex((l) => matcher.test(l))
  if (idx >= 0) lines[idx] = newLine
  else lines.push(newLine)
  await writeIndex(ctx, lines.join("\n"), requiredScopes)
}

async function removeFromIndex(ctx: MemoryContext, type: string, name: string): Promise<void> {
  const existing = await readIndexContent(ctx)
  if (!existing) return
  const matcher = tagMatcher(type, name)
  const lines = existing.split("\n").filter((l) => !matcher.test(l) && l.trim() !== "")
  // A removal only shrinks the index: it contributes no new scopes, and the
  // union keeps whatever the remaining lines already required.
  await writeIndex(ctx, lines.join("\n"), [])
}

// --- The six file verbs (P4m-T10) -----------------------------------------
//
// The model's view of its memory is a folder of Markdown files, so its verbs
// are Anthropic's memory tool verbs on a virtual directory rooted at
// `/memories/<handle>/`. Every one of them ends at the SAME rows the typed
// handlers above write, and every write goes through the same scope stamping:
// the columns stay the source of truth, so a body that claims its own
// `requiredScopes` in frontmatter changes nothing (fileToRow reads only the
// first block, and this layer never takes scopes from it at all).

/** Folders the tree exposes, beyond the type folders. */
const TREE_FOLDERS = [...MEMORY_TYPES, "episodes", "checkpoints"] as const

interface MemoryRowForTree {
  type: string
  name: string
  path: string | null
  description: string
  content: string
  requiredScopes: string[]
  updatedAt: Date
  sourceThreadId: string | null
  sourceMessageId: string | null
  supersedesId: string | null
}

/** The agent whose tree this is: the caller's own personal agent. */
async function resolveOwnerHandle(ctx: MemoryContext): Promise<string> {
  const [row] = await ctx.db
    .select({ handle: agents.handle })
    .from(agents)
    .where(
      ctx.ownerAgentId
        ? and(eq(agents.orgId, ctx.orgId), eq(agents.id, ctx.ownerAgentId))
        : and(
            eq(agents.orgId, ctx.orgId),
            eq(agents.ownerUserId, ctx.userId),
            eq(agents.kind, "personal"),
          ),
    )
    .limit(1)
  return row?.handle ?? "me"
}

/** Every file this caller may read, already scope filtered. */
async function visibleRows(ctx: MemoryContext): Promise<MemoryRowForTree[]> {
  const rows = await ctx.db
    .select({
      type: agentMemory.type,
      name: agentMemory.name,
      path: agentMemory.path,
      description: agentMemory.description,
      content: agentMemory.content,
      requiredScopes: agentMemory.requiredScopes,
      updatedAt: agentMemory.updatedAt,
      sourceThreadId: agentMemory.sourceThreadId,
      sourceMessageId: agentMemory.sourceMessageId,
      supersedesId: agentMemory.supersedesId,
    })
    .from(agentMemory)
    .where(and(eq(agentMemory.orgId, ctx.orgId), ownedRows(ctx)))
  return filterByVisibility(rows, memoryViewer(ctx)) as MemoryRowForTree[]
}

async function rowAtPath(ctx: MemoryContext, path: string): Promise<MemoryRowForTree | undefined> {
  return (await visibleRows(ctx)).find((row) => pathForRow(row) === path)
}

/**
 * Is this path taken? Answered against the UNFILTERED row set, because
 * existence is not a read. Asking the scope filtered set told a narrowed turn
 * the path was free, and the upsert underneath (orgId, ownerAgentId, type,
 * name) then replaced the body of a file that turn was never allowed to see.
 * The refusal it produces discloses nothing: the caller already named the path,
 * and the content stays unreachable.
 */
async function pathIsTaken(ctx: MemoryContext, path: string): Promise<boolean> {
  const rows = await ctx.db
    .select({ type: agentMemory.type, name: agentMemory.name, path: agentMemory.path })
    .from(agentMemory)
    .where(and(eq(agentMemory.orgId, ctx.orgId), ownedRows(ctx)))
  return rows.some((row) => pathForRow(row) === path)
}

/** The write scopes for this verb, or a refusal when the turn's taint is unknown. */
function verbWriteScopes(ctx: MemoryVerbContext, verb: string): string[] {
  const scopes = currentTurnWriteScopes(ctx.scopes)
  if (scopes === null) throw scopeUnknownError(verb)
  return scopes
}

export interface MemoryVerbContext extends MemoryContext {
  /** `agent` for a tool call, `human` for the REST route. */
  sourceKind?: "agent" | "human"
}

/** `<type>/<name>.md` split back into its columns. */
function topicPathParts(path: string): { type: string; name: string } {
  const [type, file] = path.split("/")
  return { type, name: file.replace(/\.md$/, "") }
}

function assertTopicPath(path: string, verb: string): { type: string; name: string } {
  if (path === MEMORY_INDEX_PATH) {
    throw new Error(`${verb} cannot be used on MEMORY.md; edit it in place instead`)
  }
  if (path.startsWith("episodes/") || path.startsWith("checkpoints/")) {
    throw new Error(`${verb} cannot be used on ${path}: that folder is written by consolidation`)
  }
  const { type, name } = topicPathParts(path)
  assertKnownType(type)
  return { type, name }
}

/** The directory form of a view: the root, a type folder, or an episode folder. */
function asDirectory(path: string): string | null {
  const trimmed = path.replace(/\/$/, "")
  if (trimmed === "" || trimmed === ".") return ""
  if ((TREE_FOLDERS as readonly string[]).includes(trimmed)) return trimmed
  if (/^episodes\/[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed)) return trimmed
  return null
}

export async function memoryView(
  params: { path: string; viewRange?: [number, number] },
  ctx: MemoryVerbContext,
): Promise<{ path: string; entries: string[] } | { path: string; body: string }> {
  const handle = await resolveOwnerHandle(ctx)
  const directory = asDirectory(params.path)
  if (directory !== null) {
    const rows = await visibleRows(ctx)
    const paths = rows.map((row) => pathForRow(row))
    return { path: directory, entries: listDirectory(handle, directory, paths) }
  }

  const path = resolvePath(handle, params.path)
  if (path.startsWith("checkpoints/")) {
    const rendered = await checkpointFile(ctx, path.slice("checkpoints/".length, -3))
    if (!rendered) throw new MemoryNotFoundError(path)
    return sliceBody(rendered, params.viewRange)
  }
  const row = await rowAtPath(ctx, path)
  if (!row) throw new MemoryNotFoundError(path)
  const body = path === MEMORY_INDEX_PATH ? row.content : rowToFile(row).body
  return sliceBody({ path, body }, params.viewRange)
}

/** `viewRange` is a one based, inclusive line window over the rendered file. */
function sliceBody(
  file: { path: string; body: string },
  viewRange?: [number, number],
): { path: string; body: string } {
  if (!viewRange) return file
  const [from, to] = viewRange
  return {
    path: file.path,
    body: file.body
      .split("\n")
      .slice(Math.max(0, from - 1), to)
      .join("\n"),
  }
}

export async function memoryCreate(
  params: { path: string; body: string },
  ctx: MemoryVerbContext,
): Promise<{ created: true; path: string }> {
  const requiredScopes = verbWriteScopes(ctx, "memory_create")
  const handle = await resolveOwnerHandle(ctx)
  const path = resolvePath(handle, params.path)
  const { type, name } = assertTopicPath(path, "memory_create")

  if (await pathIsTaken(ctx, path)) {
    throw new Error(`A memory file already exists at ${path}; update it instead`)
  }

  // The frontmatter a model may have written supplies the description only.
  // Scopes are stamped from the turn, never read from the body.
  const parsed = fileToRow(path, params.body)
  await handleMemorySet(
    {
      type,
      // Bounded at 160, the schema's own limit: a description quoted into
      // MEMORY.md on every turn is a budget item, and the frontmatter half of
      // it came from the model with no bound at all.
      description: boundedDescription(parsed.description || firstLineOf(parsed.content) || name),
      name,
      content: parsed.content,
    },
    ctx,
    requiredScopes,
  )
  await stampSourceKind(ctx, type, name)
  return { created: true, path }
}

/** The index line quotes this on every turn, so it is capped like the schema. */
const MEMORY_DESCRIPTION_MAX = 160
function boundedDescription(value: string): string {
  return value.slice(0, MEMORY_DESCRIPTION_MAX)
}

function firstLineOf(content: string): string {
  return (content.split("\n").find((line) => line.trim() !== "") ?? "").slice(0, 160)
}

/** Who wrote this file last: a tool call, or a human editing it in the tab. */
async function stampSourceKind(ctx: MemoryVerbContext, type: string, name: string): Promise<void> {
  await ctx.db
    .update(agentMemory)
    .set({ sourceKind: ctx.sourceKind ?? "agent" })
    .where(
      and(
        eq(agentMemory.orgId, ctx.orgId),
        ownedRows(ctx),
        eq(agentMemory.type, type),
        eq(agentMemory.name, name),
      ),
    )
}

/**
 * Write a new body for a file that already exists. The index row is written
 * through `writeIndex` so its caps apply; a topic file goes through the same
 * upsert every other write uses.
 */
async function rewriteFile(
  ctx: MemoryVerbContext,
  path: string,
  row: MemoryRowForTree,
  content: string,
  requiredScopes: string[],
): Promise<void> {
  if (path === MEMORY_INDEX_PATH) {
    await writeIndex(ctx, content, requiredScopes)
    return
  }
  const { type, name } = topicPathParts(path)
  await handleMemorySet({ type, name, description: row.description, content }, ctx, requiredScopes)
  await stampSourceKind(ctx, type, name)
}

/**
 * Write a whole file body, the ONE write path the Memory tab uses. It is not a
 * second writer: it is `rewriteFile` (the body every verb ends in) plus
 * `memoryCreate`'s upsert for a file that does not exist yet, so the index
 * caps, the scope stamping and the `lastConfirmedAt` stamp are all the ones the
 * verbs already apply. A human edit arrives with `sourceKind: 'human'` on the
 * context and is stamped from it like any other write.
 */
export async function memoryWriteFile(
  params: { path: string; content: string },
  ctx: MemoryVerbContext,
): Promise<{ path: string }> {
  const requiredScopes = verbWriteScopes(ctx, "memory_write_file")
  const handle = await resolveOwnerHandle(ctx)
  const path = resolvePath(handle, params.path)
  if (path !== MEMORY_INDEX_PATH) assertTopicPath(path, "memory_write_file")
  const row = await rowAtPath(ctx, path)
  if (row) {
    await rewriteFile(ctx, path, row, params.content, requiredScopes)
    return { path }
  }
  if (path === MEMORY_INDEX_PATH) {
    await writeIndex(ctx, params.content, requiredScopes)
    return { path }
  }
  await memoryCreate({ path, body: params.content }, ctx)
  return { path }
}

export async function memoryStrReplace(
  params: { path: string; old: string; new: string },
  ctx: MemoryVerbContext,
): Promise<{ replaced: true; path: string }> {
  const requiredScopes = verbWriteScopes(ctx, "memory_str_replace")
  const handle = await resolveOwnerHandle(ctx)
  const path = resolvePath(handle, params.path)
  const row = await rowAtPath(ctx, path)
  if (!row) throw new MemoryNotFoundError(path)

  const occurrences = row.content.split(params.old).length - 1
  if (occurrences === 0) {
    throw new Error(`The text to replace was not found in ${path}`)
  }
  if (occurrences > 1) {
    // Anthropic's contract: an ambiguous replace is an error, not a guess.
    throw new Error(
      `The text to replace appears more than once in ${path}; include more surrounding text`,
    )
  }
  await rewriteFile(ctx, path, row, row.content.replace(params.old, params.new), requiredScopes)
  return { replaced: true, path }
}

export async function memoryInsert(
  params: { path: string; line: number; text: string },
  ctx: MemoryVerbContext,
): Promise<{ inserted: true; path: string }> {
  const requiredScopes = verbWriteScopes(ctx, "memory_insert")
  const handle = await resolveOwnerHandle(ctx)
  const path = resolvePath(handle, params.path)
  const row = await rowAtPath(ctx, path)
  if (!row) throw new MemoryNotFoundError(path)

  const lines = row.content.split("\n")
  const at = Math.min(Math.max(params.line, 1), lines.length + 1) - 1
  lines.splice(at, 0, params.text)
  await rewriteFile(ctx, path, row, lines.join("\n"), requiredScopes)
  return { inserted: true, path }
}

export async function memoryDelete(
  params: { path: string },
  ctx: MemoryVerbContext,
): Promise<{ deleted: true; path: string }> {
  // A delete is a write. Every other verb refuses a turn whose taint cannot be
  // established, and this one silently proceeded: the one verb an untainted
  // turn could still use was the destructive one.
  verbWriteScopes(ctx, "memory_delete")
  const handle = await resolveOwnerHandle(ctx)
  const path = resolvePath(handle, params.path)
  const { type, name } = assertTopicPath(path, "memory_delete")
  await handleMemoryDelete({ type, name }, ctx)
  return { deleted: true, path }
}

export async function memoryRename(
  params: { from: string; to: string },
  ctx: MemoryVerbContext,
): Promise<{ renamed: true; from: string; to: string }> {
  const requiredScopes = verbWriteScopes(ctx, "memory_rename")
  const handle = await resolveOwnerHandle(ctx)
  const from = resolvePath(handle, params.from)
  const to = resolvePath(handle, params.to)
  const source = assertTopicPath(from, "memory_rename")
  const target = assertTopicPath(to, "memory_rename")

  const row = await rowAtPath(ctx, from)
  if (!row) throw new MemoryNotFoundError(from)
  if (await pathIsTaken(ctx, to)) {
    throw new Error(`A memory file already exists at ${to}`)
  }

  await handleMemorySet(
    {
      type: target.type,
      name: target.name,
      description: row.description,
      content: row.content,
    },
    ctx,
    requiredScopes,
  )
  await stampSourceKind(ctx, target.type, target.name)
  await handleMemoryDelete({ type: source.type, name: source.name }, ctx)
  return { renamed: true, from, to }
}

// --- Episodes and checkpoints as folders (P4m-T12) -------------------------
//
// `episodes/<thread handle>/<YYYY-MM-DD>[-n].md` is a closed stretch of one
// conversation as this agent saw it; `checkpoints/<thread handle>.md` is the
// current rolling summary of a conversation that outgrew the window.
//
// Episodes are memory ROWS (type `episode`). Checkpoints are NOT: they are
// rendered from kernel.agent_thread_checkpoints, because a checkpoint is a
// render artefact of the transcript and the transcript is itself the recall
// substrate. That is also why no checkpoint path is ever searchable.

export interface EpisodeInput {
  threadId: string
  threadHandle: string
  /** The day the episode closed, `YYYY-MM-DD`. */
  closedOn: string
  description: string
  body: string
  fromMessageId?: string | null
  toMessageId?: string | null
}

function episodeIndexMatcher(threadHandle: string): RegExp {
  const escaped = escapeRegex(threadHandle)
  return new RegExp(`\\]\\(episodes\\/${escaped}\\/\\),\\s+\\d{4}-\\d{2}-\\d{2}$`)
}

/**
 * ONE line per thread, never one per episode: a line per episode would flood
 * an index that is in context on every turn. The line points at the folder and
 * carries how many conversations are in it.
 */
async function updateEpisodeIndex(
  ctx: MemoryContext,
  threadHandle: string,
  closedOn: string,
  count: number,
  requiredScopes: string[],
): Promise<void> {
  const existing = await readIndexContent(ctx)
  const lines = existing.split("\n").filter((l) => l.trim() !== "")
  const line = `- [Past conversations (${count})](episodes/${threadHandle}/), ${closedOn}`
  const matcher = episodeIndexMatcher(threadHandle)
  const idx = lines.findIndex((l) => matcher.test(l))
  if (idx >= 0) lines[idx] = line
  else lines.push(line)
  await writeIndex(ctx, lines.join("\n"), requiredScopes)
}

/** Write one episode file, disambiguating a second close on the same day. */
export async function writeEpisode(
  episode: EpisodeInput,
  ctx: MemoryVerbContext,
  requiredScopes: string[],
): Promise<{ path: string }> {
  assertExplicitRequiredScopes(requiredScopes, MEMORY_SINK)
  // The handle becomes a PATH SEGMENT of every episode file, and it arrives
  // from the thread row rather than from the path grammar, so it is checked
  // here: an out of grammar handle writes rows whose paths `isLegalMemoryPath`
  // then refuses, and the episode is unreachable through every verb.
  if (!isLegalMemorySlug(episode.threadHandle)) {
    throw new Error(`Not a legal thread handle for an episode path: ${episode.threadHandle}`)
  }
  const scopes = normalizeRequiredScopes(requiredScopes)
  const ownerAgentId = await resolveOwnerAgentId(ctx)
  const existing = (await visibleRows(ctx)).filter((row) =>
    pathForRow(row).startsWith(`episodes/${episode.threadHandle}/`),
  )

  let suffix = 0
  let name = `${episode.threadHandle}-${episode.closedOn}`
  let path = `episodes/${episode.threadHandle}/${episode.closedOn}.md`
  while (existing.some((row) => pathForRow(row) === path)) {
    suffix += 1
    name = `${episode.threadHandle}-${episode.closedOn}-${suffix + 1}`
    path = `episodes/${episode.threadHandle}/${episode.closedOn}-${suffix + 1}.md`
  }

  await ctx.db.insert(agentMemory).values({
    orgId: ctx.orgId,
    userId: ctx.ownerAgentId ? (ctx.ownerLegacyUserId ?? null) : ctx.userId,
    ownerAgentId,
    type: "episode",
    name,
    description: episode.description,
    content: episode.body,
    path,
    requiredScopes: scopes,
    sourceThreadId: episode.threadId,
    sourceKind: ctx.sourceKind ?? "consolidation",
    episodeFromMessageId: episode.fromMessageId ?? null,
    episodeToMessageId: episode.toMessageId ?? null,
    lastConfirmedAt: ctx.now ?? new Date(),
    ...(ctx.now ? { createdAt: ctx.now, updatedAt: ctx.now } : {}),
  })

  await updateEpisodeIndex(ctx, episode.threadHandle, episode.closedOn, existing.length + 1, scopes)
  return { path }
}

/** The current (highest) checkpoint version for a thread, as a tree file. */
async function checkpointFile(
  ctx: MemoryContext,
  threadHandle: string,
): Promise<{ path: string; body: string } | null> {
  // THIS tree's agent, and only it (invariant I5: sessions are per agent, and
  // one agent's checkpoint is invisible to another). Keyed by the thread alone,
  // the render returned whichever agent in the room held the highest version
  // number, which is another agent's summary of the same conversation reached
  // through this agent's tree. No owning agent means no checkpoints to render.
  const ownerAgentId = await resolveOwnerAgentId(ctx)
  if (!ownerAgentId) return null
  const rows = await ctx.db
    .select({
      summary: agentThreadCheckpoints.summary,
      version: agentThreadCheckpoints.version,
      tokenEstimate: agentThreadCheckpoints.tokenEstimate,
      uptoMessageId: agentThreadCheckpoints.uptoMessageId,
      requiredScopes: agentThreadCheckpoints.requiredScopes,
      createdAt: agentThreadCheckpoints.createdAt,
    })
    .from(agentThreadCheckpoints)
    .innerJoin(threads, eq(threads.id, agentThreadCheckpoints.threadId))
    .where(
      and(
        eq(agentThreadCheckpoints.orgId, ctx.orgId),
        eq(agentThreadCheckpoints.agentId, ownerAgentId),
        eq(threads.handle, threadHandle),
      ),
    )
    .orderBy(drizzleSql`${agentThreadCheckpoints.version} DESC`)
    .limit(1)
  const [row] = filterByVisibility(rows, memoryViewer(ctx))
  if (!row) return null
  const frontmatter = [
    "---",
    `thread: ${threadHandle}`,
    `version: ${row.version}`,
    `uptoMessageId: ${row.uptoMessageId ?? "null"}`,
    `tokenEstimate: ${row.tokenEstimate}`,
    `modified: ${row.createdAt.toISOString().slice(0, 10)}`,
    "---",
    "",
  ].join("\n")
  return { path: `checkpoints/${threadHandle}.md`, body: `${frontmatter}${row.summary}` }
}

/**
 * Every path `memory_search` may return: topic files and episodes. The index
 * row is excluded (it quotes the others) and checkpoints are excluded BY
 * CONSTRUCTION, since they are not memory rows at all.
 */
export async function searchablePaths(ctx: MemoryContext): Promise<string[]> {
  const rows = await visibleRows(ctx)
  return rows
    .filter((row) => row.type !== "_index")
    .map((row) => pathForRow(row))
    .filter((path) => !path.startsWith("checkpoints/"))
    .sort()
}
