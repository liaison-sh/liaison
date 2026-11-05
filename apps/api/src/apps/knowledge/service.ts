// SPDX-License-Identifier: FSL-1.1-ALv2

import { randomUUID } from "node:crypto"
import {
  expandKnowledgeSensitivityGrants,
  type KnowledgeCreateDocument,
  type KnowledgeUpdateDocument,
  knowledgeCreateDocumentSchema,
  knowledgeUpdateDocumentSchema,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { shouldResetVerification } from "~/apps/knowledge/review"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { isUuid } from "~/lib/uuid"
import { assertExplicitRequiredScopes } from "~/modules/agent/scopes/write-required-scopes"
import { hasScope } from "~/modules/permissions/permissions"
import {
  actorGrantRole,
  listGrants,
  recomputeSearchAcl,
  replaceGrants,
} from "~/modules/sharing/service"

/** Knowledge documents in the generic sharing model (modules/sharing). */
const KNOWLEDGE_RESOURCE = "knowledge.document"

export type KnowledgeErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "VALIDATION"
  /** A named knowledge source has no enabled adapter for this org — a client
   *  precondition (connect/enable the source first), NOT a transient outage. Maps
   *  to a 4xx so it never reads as a server fault (the prior 503 inflated the
   *  server-error rate + would trip ops alerts / client retry storms). */
  | "SOURCE_NOT_ENABLED"
  /** A genuinely unavailable dependency (storage/retrieval down) — transient → 503. */
  | "SOURCE_UNAVAILABLE"

export class KnowledgeError extends Error {
  constructor(
    public readonly code: KnowledgeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "KnowledgeError"
  }
}

/** Pure KnowledgeError code → HTTP status mapping (shared by the route layer). */
export function knowledgeHttpStatus(code: KnowledgeErrorCode): 400 | 403 | 404 | 409 | 422 | 503 {
  switch (code) {
    case "REVISION_CONFLICT":
      return 409
    case "SOURCE_NOT_ENABLED":
      return 422
    case "SOURCE_UNAVAILABLE":
      return 503
    case "VALIDATION":
      return 400
    case "NOT_FOUND":
      return 404
    default:
      return 403 // FORBIDDEN
  }
}

export interface KnowledgeActor {
  orgId: string
  userId: string
  scopes: string[]
  /**
   * Already-expanded dimension grants. Use {@link knowledgeActorFromContext}
   * to construct a KnowledgeActor from raw auth context — it pre-expands
   * the sensitivity ladder so authorization and SQL filters work uniformly.
   */
  dimensionGrants: Record<string, string[]>
  /**
   * Role IDs the actor holds (JWT `roles` claim). The basis for role-based
   * document sharing — a doc shared with a role is readable/writable by its
   * members. Absent/empty for agent/system actors (they act via scopes, not
   * roles). `knowledgeActorFromContext` always populates it (possibly `[]`).
   */
  roles?: string[]
  includeArchived?: boolean
}

/**
 * Build a KnowledgeActor from raw auth context. Pre-expands the sensitivity
 * ladder and aliases `knowledge:team` → `team` / `knowledge:sensitivity` →
 * `sensitivity` so SQL filters and authorization checks see consistent grants.
 *
 * Call this once at the route/agent-tool boundary; pass the resulting actor
 * through the service layer.
 */
export function knowledgeActorFromContext(input: {
  orgId: string
  userId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  roles?: string[]
  includeArchived?: boolean
}): KnowledgeActor {
  const raw = input.dimensionGrants ?? {}
  const expanded: Record<string, string[]> = {}
  // Copy every grant verbatim, EXCEPT `sensitivity` and `team` which we
  // re-derive below so the canonical ladder ordering wins. Otherwise a raw
  // input like { sensitivity: ["confidential"] } would seed the array first
  // and then be merged into via Set — preserving the original order rather
  // than the ladder-derived order callers (and tests) expect.
  for (const [key, values] of Object.entries(raw)) {
    if (key === "sensitivity" || key === "team") continue
    expanded[key] = Array.from(new Set(values))
  }

  const teamGrants = [...(raw["knowledge:team"] ?? []), ...(raw.team ?? [])]
  if (teamGrants.length > 0) {
    expanded.team = Array.from(new Set(teamGrants))
  }

  const sensitivityInput = raw["knowledge:sensitivity"] ?? raw.sensitivity
  if (sensitivityInput && sensitivityInput.length > 0) {
    expanded.sensitivity = expandKnowledgeSensitivityGrants(sensitivityInput)
  }

  // A global wildcard dimension grant ({ "*": ["*"] } — held by org admins)
  // authorizes every dimension at every value, exactly as the RLS predicate's
  // `app_knowledge.dimension_allows('*','*')` short-circuit does. Without this,
  // the app-level team/sensitivity checks (which read only the `team` /
  // `sensitivity` keys) IGNORE the wildcard and deny an admin the very rows RLS
  // already returned — the "Knowledge item not found" 404 an admin hits on org
  // docs, and the "Forbidden by Knowledge sensitivity grant" that blocks an
  // admin from creating an organization-scoped doc. Wildcard wins over any
  // narrower grant, so apply it last.
  const hasGlobalWildcard =
    (raw["*"] ?? []).includes("*") || (raw["knowledge:*"] ?? []).includes("*")
  if (hasGlobalWildcard) {
    expanded.team = ["*"]
    expanded.sensitivity = ["*"]
  }

  return {
    orgId: input.orgId,
    userId: input.userId,
    scopes: input.scopes,
    dimensionGrants: expanded,
    roles: input.roles ?? [],
    includeArchived: input.includeArchived,
  }
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface DocumentDbRow {
  id: string
  org_id: string
  title: string
  summary: string | null
  body: string
  document_scope: "personal" | "organization"
  owner_user_id: string | null
  participant_ids: string[] | null
  team: string[]
  sensitivity: string | null
  review_status: string
  verified_by: string | null
  verified_at: Date | string | null
  review_due_at: Date | string | null
  review_reason: string | null
  archived_at: Date | string | null
  revision: number
  created_by: string
  updated_by: string | null
  created_at: Date | string
  updated_at: Date | string
  synced_source_id?: string | null
  external_path?: string | null
  external_rev?: string | null
  last_synced_at?: Date | string | null
  org_access: "none" | "viewer" | "editor"
  edit_scope: string | null
}

export interface KnowledgeDocumentRow {
  id: string
  orgId: string
  title: string
  summary: string | null
  body: string
  documentScope: "personal" | "organization"
  ownerUserId: string | null
  participantIds: string[] | null
  team: string[]
  sensitivity: string | null
  reviewStatus: string
  verifiedBy: string | null
  verifiedAt: string | null
  reviewDueAt: string | null
  reviewReason: string | null
  archivedAt: string | null
  revision: number
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  syncedSourceId?: string | null
  externalPath?: string | null
  externalRev?: string | null
  lastSyncedAt?: string | null
  orgAccess: "none" | "viewer" | "editor"
  editScope: string | null
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  if (value instanceof Date) return value.toISOString()
  return value
}

function toIsoNonNull(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function rowFromDb(r: DocumentDbRow): KnowledgeDocumentRow {
  return {
    id: r.id,
    orgId: r.org_id,
    title: r.title,
    summary: r.summary,
    body: r.body,
    documentScope: r.document_scope,
    ownerUserId: r.owner_user_id,
    participantIds: r.participant_ids,
    team: r.team ?? [],
    sensitivity: r.sensitivity,
    reviewStatus: r.review_status,
    verifiedBy: r.verified_by,
    verifiedAt: toIso(r.verified_at),
    reviewDueAt: toIso(r.review_due_at),
    reviewReason: r.review_reason,
    archivedAt: toIso(r.archived_at),
    revision: r.revision,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    createdAt: toIsoNonNull(r.created_at),
    updatedAt: toIsoNonNull(r.updated_at),
    syncedSourceId: r.synced_source_id ?? null,
    externalPath: r.external_path ?? null,
    externalRev: r.external_rev ?? null,
    lastSyncedAt: r.last_synced_at != null ? toIso(r.last_synced_at) : null,
    orgAccess: r.org_access,
    editScope: r.edit_scope ?? null,
  }
}

// ---------------------------------------------------------------------------
// Authorization helpers (pure functions, no DB)
// ---------------------------------------------------------------------------

function forbidden(message = "Forbidden"): never {
  throw new KnowledgeError("FORBIDDEN", message)
}

function validation(message = "Invalid Knowledge document payload"): never {
  throw new KnowledgeError("VALIDATION", message)
}

function scope(actor: KnowledgeActor, required: string): boolean {
  return hasScope(required, actor.scopes)
}

function includesGrant(grants: string[], value: string | null | undefined): boolean {
  return grants.includes("*") || (value != null && grants.includes(value))
}

function hasTeamGrant(rowTeams: string[], grants: string[]): boolean {
  if (rowTeams.length === 0) return true
  if (grants.includes("*")) return true
  return rowTeams.some((team) => grants.includes(team))
}

/** Re-exported for tests; canonical implementation in `dimensions.ts`. */
export function expandSensitivityGrant(value: string | string[] | null | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return expandKnowledgeSensitivityGrants(values)
}

function assertOrgMatch(row: { orgId: string }, actor: KnowledgeActor): void {
  if (row.orgId !== actor.orgId) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
}

/**
 * Mirrors the `knowledge_documents_select` RLS policy (0002 migration). Access to an
 * ORG doc is now governed by the Drive-style SHARING model — org_access + explicit
 * document_shares — NOT the team/sensitivity dimension ladder, which is decoupled
 * from access and only annotates the doc. `shareRole` is the caller's explicit
 * document_shares row for this doc (or null if none / not loaded).
 */
export function assertCanReadDocumentRow(
  row: Pick<
    KnowledgeDocumentRow,
    "orgId" | "documentScope" | "ownerUserId" | "createdBy" | "orgAccess" | "archivedAt"
  >,
  actor: KnowledgeActor,
  shareRole: "viewer" | "editor" | null = null,
): void {
  assertOrgMatch(row, actor)
  if (row.archivedAt && !actor.includeArchived)
    throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
  if (!scope(actor, "knowledge:documents:read") && !scope(actor, "knowledge:documents:admin")) {
    forbidden("Forbidden to read Knowledge document")
  }

  if (row.documentScope === "personal") {
    if (row.ownerUserId !== actor.userId) forbidden("Forbidden to read Knowledge document")
    return
  }

  // Org doc — access is governed by sharing, not team/sensitivity dimensions.
  // The creator or current owner may always read their own document, exactly
  // as the RLS SELECT policy's `created_by = me OR owner_user_id = me` branch
  // allows.
  if (row.createdBy === actor.userId || row.ownerUserId === actor.userId) return

  // A broad org-wide audience (viewer or editor) may read.
  if (row.orgAccess === "viewer" || row.orgAccess === "editor") return

  // An explicit share (either role) grants read, regardless of org_access.
  if (shareRole) return

  forbidden("Forbidden to read Knowledge document")
}

/**
 * Mirrors the `knowledge_documents_update` RLS policy (0002 migration). Write access
 * to an ORG doc requires owner/creator, an org-wide 'editor' audience, or an explicit
 * editor share — team/sensitivity dimensions are no longer part of the write gate.
 */
export function assertCanWriteDocumentRow(
  row: Pick<
    KnowledgeDocumentRow,
    | "orgId"
    | "documentScope"
    | "ownerUserId"
    | "createdBy"
    | "orgAccess"
    | "archivedAt"
    | "editScope"
  >,
  actor: KnowledgeActor,
  shareRole: "viewer" | "editor" | null = null,
): void {
  // NO admin bypass: a restricted (org_access='none') doc is writable ONLY by
  // its owner/creator or someone holding an explicit 'editor' share — org admins
  // respect the restriction too (Drive-style, matching the read check and the
  // knowledge_documents_update RLS policy, which likewise dropped the admin
  // bypass). Writers must first pass the READ check — you cannot write what you
  // cannot see — then prove the write right. (An admin still lands here with
  // knowledge:documents:update via its role/`*`, so genuine open docs stay
  // editable; only restrictions are honoured.)
  const readActor =
    scope(actor, "knowledge:documents:update") || scope(actor, "knowledge:documents:admin")
      ? { ...actor, scopes: Array.from(new Set([...actor.scopes, "knowledge:documents:read"])) }
      : actor
  assertCanReadDocumentRow(row, readActor, shareRole)

  if (row.documentScope === "personal") {
    // Personal docs: owner-only write (unchanged privacy boundary).
    if (row.ownerUserId === actor.userId && scope(actor, "knowledge:documents:update")) return
    forbidden("Forbidden to write Knowledge document")
  }

  if (!scope(actor, "knowledge:documents:update") && !scope(actor, "knowledge:documents:admin"))
    forbidden("Forbidden to write Knowledge document")
  // Owner/creator always write their own doc.
  if (row.ownerUserId === actor.userId || row.createdBy === actor.userId) return
  // Org-wide 'editor' audience may maintain the doc.
  if (row.orgAccess === "editor") return
  // An explicit editor share may maintain the doc.
  if (shareRole === "editor") return
  // Scoped edit: a doc may grant write to holders of an EXACT scope (e.g. C-Level).
  // Use a LITERAL membership test — NOT the wildcard-honouring `scope()` helper —
  // so an org admin holding `*` does not bypass it (matches has_exact_scope in RLS).
  if (row.editScope && actor.scopes.includes(row.editScope)) return
  forbidden("Forbidden to write Knowledge document")
}

/**
 * Whether the actor may edit the document's body, by the very checks an
 * update runs (a synced document is read-only, then `assertCanWriteDocumentRow`).
 * The app shows its Edit control from this; the update itself still decides.
 */
export function canEditDocumentRow(
  row: Parameters<typeof assertCanWriteDocumentRow>[0] &
    Pick<KnowledgeDocumentRow, "syncedSourceId">,
  actor: KnowledgeActor,
  shareRole: "viewer" | "editor" | null = null,
): boolean {
  if (row.syncedSourceId) return false
  try {
    assertCanWriteDocumentRow(row, actor, shareRole)
    return true
  } catch (err) {
    if (err instanceof KnowledgeError) return false
    throw err
  }
}

function assertCanSetDimensions(
  input: { team?: string[] | null; sensitivity?: string | null },
  actor: KnowledgeActor,
): void {
  const teams = input.team ?? []
  if (!hasTeamGrant(teams, actor.dimensionGrants.team ?? []))
    forbidden("Forbidden by Knowledge team grant")
  if (
    input.sensitivity &&
    !includesGrant(actor.dimensionGrants.sensitivity ?? [], input.sensitivity)
  ) {
    forbidden("Forbidden by Knowledge sensitivity grant")
  }
}

function validateCreateInput(input: unknown): KnowledgeCreateDocument {
  const parsed = knowledgeCreateDocumentSchema.safeParse(input)
  if (!parsed.success) validation(parsed.error.issues[0]?.message)
  return parsed.data
}

function validateUpdateInput(
  input: KnowledgeUpdateDocument & { id?: string },
): KnowledgeUpdateDocument & { id: string } {
  if (!input.id) validation("Document id is required")
  if (!Number.isInteger(input.revision) || input.revision < 0) validation("Revision is required")
  const parsed = knowledgeUpdateDocumentSchema.safeParse(input)
  if (!parsed.success) {
    const nonOwnerIssues = parsed.error.issues.filter(
      (issue) => issue.path.join(".") !== "ownerUserId",
    )
    if (nonOwnerIssues.length > 0) validation(nonOwnerIssues[0]?.message)
  }
  return input as KnowledgeUpdateDocument & { id: string }
}

// ---------------------------------------------------------------------------
// Data access (own SQL, own events) — call from routes via withRequestRls
// ---------------------------------------------------------------------------

export async function loadKnowledgeDocument(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<KnowledgeDocumentRow | null> {
  const rows = extractRows<DocumentDbRow>(
    await tx.execute(drizzleSql`
      SELECT * FROM ${knowledgeRel("documents")}
      WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
      LIMIT 1
    `),
  )
  return rows[0] ? rowFromDb(rows[0]) : null
}

/**
 * The caller's EFFECTIVE explicit-share role for a given document — the strongest
 * of (a) a per-USER grant and (b) any grant to a role the actor holds, in the
 * generic sharing model (kernel.resource_grants). Returns null if neither
 * grants access. Feeds
 * `assertCanReadDocumentRow` / `assertCanWriteDocumentRow`'s `shareRole` param —
 * mirrors the RLS policies' `EXISTS (... document_shares ...)` + `EXISTS
 * (... document_role_shares ... has_role ...)` branches. Because both axes fold
 * into one "explicit share" role, every existing call site picks up role-based
 * sharing with no further change.
 */
export async function loadDocumentShareRole(
  tx: RlsClient,
  documentId: string,
  actor: KnowledgeActor,
): Promise<"viewer" | "editor" | null> {
  return actorGrantRole(tx, KNOWLEDGE_RESOURCE, documentId, {
    userId: actor.userId,
    roles: actor.roles ?? [],
  })
}

/**
 * Find the existing NON-ARCHIVED ORGANIZATION-scoped doc with the EXACT (case-sensitive, trimmed) title
 * that the actor can WRITE — the "running doc" a maintain-one-doc routine should UPDATE rather than
 * duplicate. Returns the OLDEST match (the canonical running doc) the actor can update, else null. Used by
 * the agent knowledge_create upsert guard (rpc-bridge) to redirect a colliding create into an update so a
 * recurring watch routine maintains ONE running doc instead of spawning a duplicate each tick (BL-275).
 * Returns null on any error / no writable match so the caller falls back to a normal create (never throws).
 */
export async function findOrgDocByTitle(
  tx: RlsClient,
  orgId: string,
  title: string,
  actor: KnowledgeActor,
): Promise<KnowledgeDocumentRow | null> {
  const wanted = title.trim()
  if (!wanted) return null
  try {
    const rows = extractRows<DocumentDbRow>(
      await tx.execute(drizzleSql`
        SELECT * FROM ${knowledgeRel("documents")}
        WHERE org_id = ${orgId}::uuid
          AND document_scope = 'organization'
          AND archived_at IS NULL
          AND btrim(title) = ${wanted}
        ORDER BY created_at ASC
      `),
    )
    for (const r of rows) {
      const row = rowFromDb(r)
      // Only redirect to a doc the actor may actually UPDATE — else a normal create is the right path.
      try {
        const shareRole = await loadDocumentShareRole(tx, row.id, actor)
        assertCanWriteDocumentRow(row, actor, shareRole)
        return row
      } catch {
        // not writable by this actor — keep scanning for an older writable match
      }
    }
    return null
  } catch {
    // best-effort guard — never block a create on a lookup failure
    return null
  }
}

/**
 * The exact-title READ lookup exposed as the `knowledge:find_by_title` agent tool (U5.8). Read-scoped
 * sibling of {@link findOrgDocByTitle} (which is write-scoped, feeding the knowledge_create upsert-redirect
 * guard) — this one answers "does a doc with this EXACT title exist, and can I READ it", DB-backed (no
 * search index, so no Meilisearch indexing-lag window). Built for the calls connector's callRef→doc
 * resolution (`Appel — <callRef>` title convention, U5.2's DESIGN.md (c)): under replay load the app-side
 * Meili index can lag >60s behind a just-created document, and this tool queries Postgres directly instead.
 *
 * Considers BOTH personal and organization docs (unlike findOrgDocByTitle's org-only upsert scope), gated
 * through the SAME read-authorization path `get` uses: `loadDocumentShareRole` + `assertCanReadDocumentRow`.
 * Archived docs are excluded unless `includeArchived` is passed. Returns the OLDEST readable match, else
 * null — for a RLS-denied lookup, an unmatched title, or any internal error (best-effort, never throws;
 * a "not found" and a "not permitted" are intentionally indistinguishable to the caller, exactly as `get`'s
 * NOT_FOUND-on-forbidden convention already establishes elsewhere in this file).
 */
export async function findDocByTitle(
  tx: RlsClient,
  orgId: string,
  title: string,
  actor: KnowledgeActor,
  opts: { includeArchived?: boolean } = {},
): Promise<KnowledgeDocumentRow | null> {
  const wanted = title.trim()
  if (!wanted) return null
  const includeArchived = opts.includeArchived ?? false
  try {
    const rows = extractRows<DocumentDbRow>(
      await tx.execute(drizzleSql`
        SELECT * FROM ${knowledgeRel("documents")}
        WHERE org_id = ${orgId}::uuid
          AND btrim(title) = ${wanted}
          ${includeArchived ? drizzleSql`` : drizzleSql`AND archived_at IS NULL`}
        ORDER BY created_at ASC
      `),
    )
    const readActor = includeArchived ? { ...actor, includeArchived: true } : actor
    for (const r of rows) {
      const row = rowFromDb(r)
      try {
        const shareRole = await loadDocumentShareRole(tx, row.id, actor)
        assertCanReadDocumentRow(row, readActor, shareRole)
        return row
      } catch {
        // not readable by this actor — keep scanning for an older readable match
      }
    }
    return null
  } catch {
    // best-effort lookup — never throw on a query/lookup failure
    return null
  }
}

/** Regex for the running-doc binding directive create_routine injects into a watch routine's prompt
 *  ("MAINTAIN THIS EXISTING RUNNING DOC … id <UUID>"). The bound doc id is the FIRST such id. Mirrors the
 *  rpc-bridge parse so BOTH the sandbox and the HOST knowledge_create path redirect onto the same doc. */
const KNOWLEDGE_ROUTINE_BOUND_DOC_ID_RE =
  /MAINTAIN THIS EXISTING RUNNING DOC[\s\S]*?\bid\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/**
 * ROUTINE-BOUND running doc (BL-275, competitor-firmware-news-watch duplicate-doc fail). When a
 * knowledge_create runs inside a ROUTINE TICK whose authored prompt carries the binding directive
 * ("MAINTAIN THIS EXISTING RUNNING DOC … id <UUID>"), return THAT bound doc the actor can UPDATE — so the
 * tick's create (with ANY invented title / scope) is redirected onto the ONE running doc, title-independent.
 * THIS lives in the SERVICE (not only the sandbox rpc-bridge) so the HOST knowledge_create agent tool — which
 * the routine tick actually calls and which BYPASSES the rpc-bridge redirect — also redirects (the
 * intermittent duplicate-doc the rpc-bridge-only redirect missed). Best-effort + read-only: any error / not a
 * tick / no directive / doc gone / not writable → null (the caller creates normally). Never throws.
 */
export async function findRoutineBoundRunningDoc(
  tx: RlsClient,
  orgId: string,
  actor: KnowledgeActor,
): Promise<KnowledgeDocumentRow | null> {
  try {
    const { currentRunContext } = await import("~/modules/agent/runtime/run-context")
    const routineId = currentRunContext()?.routineId
    if (!routineId) return null
    const { kernelRel } = await import("~/apps/knowledge/schema-refs")
    const promptRows = extractRows<{ prompt: string | null }>(
      await tx.execute(
        drizzleSql`SELECT prompt FROM ${kernelRel("routines")} WHERE id = ${routineId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`,
      ),
    )
    const boundId = promptRows[0]?.prompt?.match(KNOWLEDGE_ROUTINE_BOUND_DOC_ID_RE)?.[1]
    if (!boundId) return null
    const doc = await loadKnowledgeDocument(tx, boundId, actor)
    if (!doc) return null
    const shareRole = await loadDocumentShareRole(tx, doc.id, actor)
    assertCanWriteDocumentRow(doc, actor, shareRole) // only redirect onto a doc the tick can UPDATE
    return doc
  } catch {
    return null
  }
}

/** Normalize a title for the running-doc PREFIX match: lowercase, strip punctuation/dashes to spaces,
 *  collapse runs of whitespace, trim. So "Dealer Price Watch — Kestrel 6 (RAL-44)" → "dealer price watch
 *  kestrel 6 ral 44". Pure. */
export function normalizeRunningDocTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
}

// Document extensions we treat as "the title is really a filename" — imported
// files (folder/Drive sync) forward the raw filename into `title`, so a doc
// named "11-presets.md" leaks its extension + kebab-case into the UI.
const DOC_FILE_EXT_RE = /\.(md|markdown|txt|rst|adoc|mdx|html?|pdf|docx?)$/i

/**
 * User-facing title for a knowledge document. The stored `title` is often the
 * raw import filename (e.g. "11-presets.md"), which leaks as data in the
 * "Recently touched" list. Prefer, in order: the document's own leading H1
 * heading (the real title an author wrote), then the stored title with a known
 * document extension stripped and separators humanized, then the stored title
 * verbatim. Pure; exported for tests.
 */
export function knowledgeDisplayTitle(title: string, body?: string | null): string {
  // 1. A leading markdown H1 is the author's real title.
  if (body) {
    for (const rawLine of body.split("\n", 20)) {
      const line = rawLine.trim()
      if (line === "") continue
      const h1 = /^#\s+(.+?)\s*#*$/.exec(line)
      if (h1?.[1]) return h1[1].trim()
      // First non-blank line is not an H1 -> no leading heading; fall through.
      break
    }
  }
  // 2. The stored title looks like a filename -> strip the extension and
  //    humanize kebab/snake separators.
  const trimmed = title.trim()
  if (DOC_FILE_EXT_RE.test(trimmed)) {
    const base = trimmed.replace(DOC_FILE_EXT_RE, "")
    const humanized = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
    if (humanized) return humanized
  }
  // 3. Verbatim.
  return trimmed
}

/** The significant (non-stopword) token SET of a normalized title — for the running-doc containment match.
 *  Strips ultra-generic doc words that would over-match ("doc"/"weekly"/"log"/"the"…) AND pure dates/years
 *  (so a date-stamped title's date tokens don't dilute the set), then dedupes. Pure. Exported for tests. */
export function runningDocTitleTokens(title: string): Set<string> {
  // STOP = ONLY ultra-generic glue words + cadence words a title rephrase commonly adds/drops. Distinctive
  // domain tokens (watch, price, dealer, log, report, …) are KEPT — they are what makes two titles the
  // same running doc. Dates/years are stripped separately (the \d filter below).
  const STOP = new Set([
    "the",
    "a",
    "an",
    "of",
    "for",
    "and",
    "to",
    "our",
    "my",
    "this",
    "on",
    "in",
    "by",
    "with",
    "doc",
    "document",
    "weekly",
    "monthly",
    "daily",
  ])
  const toks = normalizeRunningDocTitle(title)
    .split(" ")
    .filter((t) => t.length > 0 && !STOP.has(t) && !/^\d{1,4}$/.test(t))
  return new Set(toks)
}

/**
 * RUNNING-DOC CONTAINMENT fallback for the upsert guard (BL-275, dealer-price-watch-weekly duplicate-doc
 * fail). When a recurring watch routine maintains ONE running doc, a flash-lite tick under load sometimes
 * calls knowledge_create with a TITLE VARIANT of the seeded running doc — a shortening ("Dealer Price
 * Watch"), a re-ordering ("Kestrel 6 Dealer Price Watch"), or a date stamp ("Kestrel 6 Weekly Dealer Price
 * Log - 2026-07-04") — none of which exact-match the canonical "Dealer Price Watch — Kestrel 6 (RAL-44)",
 * so the exact-title guard (findOrgDocByTitle) misses them → a DUPLICATE running doc lands (the rubric's
 * "new doc per tick" FAIL). This fallback redirects ONLY in the unambiguous, safe case: the create title's
 * SIGNIFICANT token set (stopwords + dates stripped) is a SUBSET of EXACTLY ONE writable non-archived org
 * doc's token set, sharing ≥3 significant tokens. It is DELIBERATELY one-directional (wanted-tokens ⊆
 * existing-tokens, never the reverse) so a genuinely-distinct title with an EXTRA distinctive token
 * ("Running Watch Doc (different)" — "different" is not in the existing) is NOT captured, and it requires a
 * UNIQUE match above a 3-significant-token floor so a generic title ("Q3 Notes") never wrongly merges
 * distinct docs. Returns the single match, else null (the caller then creates normally). Never throws.
 */
export async function findOrgRunningDocByTitlePrefix(
  tx: RlsClient,
  orgId: string,
  title: string,
  actor: KnowledgeActor,
): Promise<KnowledgeDocumentRow | null> {
  const wantedTokens = runningDocTitleTokens(title)
  // Floor: ≥3 SIGNIFICANT tokens so a short/generic title never captures an unrelated doc.
  if (wantedTokens.size < 3) return null
  try {
    const rows = extractRows<DocumentDbRow>(
      await tx.execute(drizzleSql`
        SELECT * FROM ${knowledgeRel("documents")}
        WHERE org_id = ${orgId}::uuid
          AND document_scope = 'organization'
          AND archived_at IS NULL
        ORDER BY created_at ASC
      `),
    )
    const matches: KnowledgeDocumentRow[] = []
    for (const r of rows) {
      const row = rowFromDb(r)
      const existingTokens = runningDocTitleTokens(row.title)
      // Skip the EXACT same normalized title (the exact-match guard's job) — only catch VARIANTS here.
      if (normalizeRunningDocTitle(row.title) === normalizeRunningDocTitle(title)) continue
      // wanted significant tokens ⊆ existing significant tokens (order-independent), sharing ≥3 — i.e. the
      // create is a re-ordering/shortening/date-stamping of THIS existing running doc, with no extra
      // distinctive token of its own. One-directional: an existing doc whose tokens are a subset of the
      // wanted (the wanted is the BIGGER, genuinely-distinct title) is NOT a match.
      const subset = [...wantedTokens].every((t) => existingTokens.has(t))
      if (subset && wantedTokens.size >= 3) {
        // Only a doc the actor can UPDATE is a redirect target.
        try {
          const shareRole = await loadDocumentShareRole(tx, row.id, actor)
          assertCanWriteDocumentRow(row, actor, shareRole)
          matches.push(row)
        } catch {
          // not writable — skip
        }
      }
    }
    // UNAMBIGUOUS only: redirect iff EXACTLY ONE writable running-doc containment match. Two+ candidates means
    // the shortened title is genuinely ambiguous → fall back to a normal create rather than guess.
    return matches.length === 1 ? matches[0] : null
  } catch {
    return null
  }
}

/** True when a doc TITLE reads as a running competitor/firmware/release WATCH or DIGEST doc — the shape the
 *  agent (under parallel load) sometimes re-creates as a SCRATCH duplicate during the planning conversation
 *  ("Competitor Release History", "Competitor Digest", "…Release Log") instead of reusing the ONE seeded
 *  running watch doc. Requires a 'watch family' word (watch/digest/log/history/tracker/monitor) AND a
 *  watch-DOMAIN word (competitor/firmware/feature/release/changelog/news/blog/price/spec), so a generic doc
 *  (meeting notes, a KB article, a runbook) never matches. Pure. Exported for the regression test. */
export function isRunningWatchOrDigestTitle(title: string): boolean {
  const t = title.toLowerCase()
  const family = /\b(watch|digest|log|history|tracker|monitor|round[\s-]?up|bulletin)\b/.test(t)
  const domain =
    /\b(competitor|competitive|firmware|feature|release|releases|changelog|news|blog|price|sku|spec)\b/.test(
      t,
    )
  return family && domain
}

/**
 * CONVERSATION-PHASE DUPLICATE-WATCH-DOC GUARD (BL-275, competitor-firmware-news-watch parallel fail). The
 * agent, under parallel CPU load, sometimes creates a SECOND watch/digest doc ("Competitor Release History")
 * during the PLANNING conversation — a non-routine create (no routineId) the routine-bound redirect can NOT
 * catch — while the SEEDED running watch doc is the one the tick correctly maintains. The knowledge block
 * then shows TWO watch docs and the rubric's "no second watch doc" criterion fails. When a NEW create's
 * title reads as a running watch/digest doc (isRunningWatchOrDigestTitle) AND the org already has EXACTLY ONE
 * writable non-archived ORG doc whose title also reads as a running watch/digest doc, redirect the create
 * onto THAT one doc — collapsing the would-be duplicate into the single running doc. DELIBERATELY narrow: it
 * fires ONLY when BOTH the new title AND a UNIQUE existing doc carry the watch/digest signal, so a genuinely
 * distinct doc (meeting notes, a KB article) is never merged, and an org with two rival watch docs (ambiguous)
 * falls through to a normal create. Returns the single match, else null. Never throws.
 */
export async function findUniqueOrgRunningWatchDoc(
  tx: RlsClient,
  orgId: string,
  newTitle: string,
  actor: KnowledgeActor,
): Promise<KnowledgeDocumentRow | null> {
  if (!isRunningWatchOrDigestTitle(newTitle)) return null
  try {
    const rows = extractRows<DocumentDbRow>(
      await tx.execute(drizzleSql`
        SELECT * FROM ${knowledgeRel("documents")}
        WHERE org_id = ${orgId}::uuid
          AND document_scope = 'organization'
          AND archived_at IS NULL
        ORDER BY created_at ASC
      `),
    )
    const matches: KnowledgeDocumentRow[] = []
    for (const r of rows) {
      const row = rowFromDb(r)
      if (!isRunningWatchOrDigestTitle(row.title)) continue
      // Skip the EXACT same normalized title — that's the exact-match guard's job (and an exact re-create is
      // already an update there); here we collapse a DIFFERENTLY-titled watch/digest duplicate.
      if (normalizeRunningDocTitle(row.title) === normalizeRunningDocTitle(newTitle)) continue
      try {
        const shareRole = await loadDocumentShareRole(tx, row.id, actor)
        assertCanWriteDocumentRow(row, actor, shareRole)
        matches.push(row)
      } catch {
        // not writable — skip
      }
    }
    // UNAMBIGUOUS only: collapse iff EXACTLY ONE writable running watch/digest doc exists.
    return matches.length === 1 ? matches[0] : null
  } catch {
    return null
  }
}

export async function listKnowledgeDocuments(
  tx: RlsClient,
  actor: KnowledgeActor,
  opts: { limit?: number; includeArchived?: boolean; unfiled?: boolean } = {},
): Promise<KnowledgeDocumentRow[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
  const includeArchived = opts.includeArchived ?? false
  // Unfiled = org-scope documents not in any collection. Personal-scope
  // documents cannot belong to a collection by validation, so excluding
  // them keeps "Unfiled" semantically about *org* knowledge that needs
  // filing. Personal docs surface under the __personal_notes__ tree node.
  const unfiledClause = opts.unfiled
    ? drizzleSql`AND d.document_scope = 'organization'
        AND NOT EXISTS (
          SELECT 1 FROM ${knowledgeRel("collection_memberships")} m
          WHERE m.target_id = d.id AND m.target_type = 'document'
        )`
    : drizzleSql``
  const rows = extractRows<DocumentDbRow>(
    await tx.execute(drizzleSql`
      SELECT d.* FROM ${knowledgeRel("documents")} d
      WHERE d.org_id = ${actor.orgId}::uuid
        ${includeArchived ? drizzleSql`` : drizzleSql`AND d.archived_at IS NULL`}
        ${unfiledClause}
      ORDER BY d.updated_at DESC
      LIMIT ${limit}
    `),
  )
  return rows.map(rowFromDb)
}

// ---------------------------------------------------------------------------
// Generic ACL search primitive — denormalized acl_user_ids / acl_role_ids
// ---------------------------------------------------------------------------
//
// Mirrors the participant_ids pattern: the search indexer (a generic, kernel
// primitive with no "knowledge" literals) reads these columns via the
// manifest's `permissionFields.aclFields` declaration to build a MeiliSearch
// filter that matches `knowledge_documents_select` exactly. `org_wide` is a
// GENERATED STORED column (0008) recomputed by Postgres from document_scope +
// org_access; `acl_user_ids`/`acl_role_ids` are plain JSONB maintained HERE,
// at every write point that can change owner/creator/shares, via this single
// helper so there is exactly one implementation of the recompute logic.
//
// Elevates to liaison_admin for the UPDATE (mirrors attachQueueEvent's
// SET LOCAL ROLE pattern in db/queue-event.ts). The RLS `knowledge_documents_
// update` policy requires knowledge:documents:update/:admin scope — but a
// create-only actor (e.g. a `:create`-only role) is fully authorized to
// populate the ACL of the row IT JUST INSERTED; the RLS write gate is a
// human-facing "can this actor edit doc content" check, not a gate on this
// internal denormalization the service performs after every already-
// authorized write (assertCanWriteDocumentRow gates update/setDocumentSharing;
// create's own INSERT policy gates create). try/finally guarantees the role
// is restored even if the UPDATE throws, so a later statement in the same
// transaction never runs unexpectedly privileged.
async function recomputeDocumentAcl(tx: RlsClient, documentId: string): Promise<void> {
  await recomputeSearchAcl(tx, KNOWLEDGE_RESOURCE, documentId)
}

/** The sink name this module writes, for the explicit-argument error message. */
const KNOWLEDGE_SINK = "app_knowledge.documents"

/** A `text[]` literal built from a JS array, with no comma-splitting games. */
function textArraySql(values: string[]) {
  return drizzleSql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`
}

/**
 * The document's tag after this write: the union of what it already carried and
 * what this turn contributes. An update NEVER narrows an existing tag — the
 * body still quotes what the earlier turn read into it, so a later low-scope
 * edit must not widen who can see it.
 */
function unionRequiredScopesSql(values: string[]) {
  return drizzleSql`required_scopes = ARRAY(SELECT DISTINCT s FROM unnest(required_scopes || ${textArraySql(values)}) AS s ORDER BY s)`
}

/**
 * D5: `requiredScopes` is a MANDATORY argument on both document write paths —
 * the turn's accumulated scopes for an agent write, an explicit `[]` for a
 * human, CLI or seed write that reads nothing scoped into the document. The
 * column has no default (migration 0065), so a writer that forgets it fails
 * loudly rather than publishing a scoped document to the whole org.
 */
export async function createKnowledgeDocument(
  tx: RlsClient,
  input: KnowledgeCreateDocument,
  actor: KnowledgeActor,
  requiredScopes: string[],
): Promise<KnowledgeDocumentRow> {
  assertExplicitRequiredScopes(requiredScopes, KNOWLEDGE_SINK)
  if (!scope(actor, "knowledge:documents:create") && !scope(actor, "knowledge:documents:admin")) {
    forbidden("Forbidden to create Knowledge document")
  }
  // ⛔ ROUTINE-BOUND running doc redirect (BL-275, competitor-firmware-news-watch duplicate-doc fail). When
  // this create runs inside a routine TICK whose prompt binds a running watch doc, redirect it onto THAT doc
  // as an UPDATE — title- AND scope-independent — so a flash-lite tick that invents a separate "…Log" / "…
  // Watch Doc" title (which the same-title guard below misses) never spawns a duplicate running doc. THIS
  // lives in the service so the HOST knowledge_create path (which the tick calls, bypassing the rpc-bridge
  // redirect) gets it too. Best-effort: null (not a tick / no binding / not writable) → a normal create.
  const boundRunningDoc = await findRoutineBoundRunningDoc(tx, actor.orgId, actor)
  if (boundRunningDoc) {
    return updateKnowledgeDocument(
      tx,
      {
        id: boundRunningDoc.id,
        revision: boundRunningDoc.revision,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      } as KnowledgeUpdateDocument,
      actor,
      requiredScopes,
    )
  }
  const parsed = validateCreateInput(input)

  let ownerUserId: string
  let participantIds: string[] | null
  let team: string[]
  let sensitivity: string | null
  let orgAccess: "none" | "viewer" | "editor"
  let editScope: string | null

  if (parsed.documentScope === "personal") {
    ownerUserId = actor.userId
    participantIds = [actor.userId]
    team = []
    sensitivity = null
    // Personal docs are owner-gated regardless of org_access; 'none' for tidiness.
    orgAccess = "none"
    // Scoped edit is an org-doc concept only — a personal doc's write gate is
    // owner-only regardless (see assertCanWriteDocumentRow's personal branch).
    editScope = null
  } else {
    ownerUserId = parsed.ownerUserId ?? actor.userId
    if (
      ownerUserId !== actor.userId &&
      !scope(actor, "knowledge:documents:assign-owner") &&
      !scope(actor, "knowledge:documents:admin")
    ) {
      forbidden("Forbidden to assign Knowledge document owner")
    }
    participantIds = null
    team = parsed.team ?? []
    sensitivity = parsed.sensitivity ?? "internal"
    assertCanSetDimensions({ team, sensitivity }, actor)
    // Sensitivity is a POLICY INPUT that drives the org_access DEFAULT;
    // sharing (org_access + user/role shares) remains the sole enforcement
    // plane. Confidential/restricted docs default to org-invisible ('none')
    // so classifying a doc sensitive doesn't also require a separate manual
    // step to lock down broad access — the owner/sharer must opt IN via an
    // explicit share or orgAccess. Any explicit parsed.orgAccess always wins.
    orgAccess =
      parsed.orgAccess ??
      (sensitivity === "confidential" || sensitivity === "restricted" ? "none" : "editor")
    editScope = parsed.editScope ?? null
  }

  const id = randomUUID()
  const reviewStatus = parsed.verifyNow ? "verified" : "unverified"

  // Use the caller's RLS-bound transaction directly. A nested
  // `tx.transaction(...)` SAVEPOINT can drop the parent transaction's
  // `set_config(..., true)` LOCAL bindings depending on driver/pool
  // semantics, which manifests as spurious RLS denials. The outer
  // `withRlsContext` already provides transactional isolation.
  await tx.execute(drizzleSql`
    INSERT INTO ${knowledgeRel("documents")}
      (id, org_id, title, summary, body, document_scope, owner_user_id, participant_ids,
       team, sensitivity, review_status, verified_by, verified_at, review_due_at,
       revision, created_by, org_access, edit_scope, required_scopes)
    VALUES (
      ${id}::uuid,
      ${actor.orgId}::uuid,
      ${parsed.title},
      ${parsed.summary ?? null},
      ${parsed.body ?? ""},
      ${parsed.documentScope},
      ${ownerUserId}::uuid,
      ${participantIds === null ? null : JSON.stringify(participantIds)}::jsonb,
      ${JSON.stringify(team)}::jsonb,
      ${sensitivity},
      ${reviewStatus},
      ${parsed.verifyNow ? actor.userId : null}::uuid,
      ${parsed.verifyNow ? drizzleSql`now()` : drizzleSql`NULL`},
      ${parsed.reviewDueAt ?? null},
      1,
      ${actor.userId}::uuid,
      ${orgAccess},
      ${editScope},
      ${textArraySql(requiredScopes)}
    )
  `)
  // acl_user_ids starts as [owner, createdBy] deduped (no shares yet on a
  // freshly-created doc) — recomputeDocumentAcl derives exactly that from the
  // row just inserted, keeping one implementation for every write point.
  await recomputeDocumentAcl(tx, id)
  await tx.queueEvent({
    app: "knowledge",
    entity: "document",
    action: "create",
    entityId: id,
    data: { id, documentScope: parsed.documentScope },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })

  // IC-5: honor collectionIds / tagNames in the same transaction
  if (parsed.collectionIds && parsed.collectionIds.length > 0) {
    for (const collectionId of parsed.collectionIds) {
      await tx.execute(drizzleSql`
        INSERT INTO ${knowledgeRel("collection_memberships")}
          (id, org_id, collection_id, target_type, target_id, created_by)
        VALUES (gen_random_uuid(), ${actor.orgId}::uuid, ${collectionId}::uuid,
                'document', ${id}::uuid, ${actor.userId}::uuid)
        ON CONFLICT (org_id, collection_id, target_type, target_id) DO NOTHING
      `)
    }
  }
  if (parsed.tagNames && parsed.tagNames.length > 0) {
    for (const rawName of parsed.tagNames) {
      const name = rawName.trim()
      if (!name) continue
      const normalized = name.toLowerCase().replace(/\s+/g, " ")
      // Upsert tag (idempotent on (org_id, normalized_name))
      const tagRows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO ${knowledgeRel("tags")} (id, org_id, name, normalized_name)
          VALUES (gen_random_uuid(), ${actor.orgId}::uuid, ${name}, ${normalized})
          ON CONFLICT (org_id, normalized_name) DO UPDATE SET updated_at = now()
          RETURNING id
        `),
      )
      const tagId = tagRows[0]?.id
      if (!tagId) continue
      await tx.execute(drizzleSql`
        INSERT INTO ${knowledgeRel("taggings")}
          (id, org_id, tag_id, target_type, target_id, created_by)
        VALUES (gen_random_uuid(), ${actor.orgId}::uuid, ${tagId}::uuid,
                'document', ${id}::uuid, ${actor.userId}::uuid)
        ON CONFLICT (org_id, tag_id, target_type, target_id) DO NOTHING
      `)
    }
  }

  const row = await loadKnowledgeDocument(tx, id, actor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge document not found after insert")
  return row
}

export async function updateKnowledgeDocument(
  tx: RlsClient,
  input: KnowledgeUpdateDocument & { id?: string },
  actor: KnowledgeActor,
  requiredScopes: string[],
): Promise<KnowledgeDocumentRow> {
  assertExplicitRequiredScopes(requiredScopes, KNOWLEDGE_SINK)
  const parsed = validateUpdateInput(input)
  // Run inside the caller-provided RLS transaction directly (see
  // createKnowledgeDocument for rationale).
  const row = await loadKnowledgeDocument(tx, parsed.id, actor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")

  // H-2 read-only: synced documents are owned by an external source.
  // Reject any service-layer edit; the DB-level synced_revision CHECK is
  // the second-line guard against raw-SQL bypass.
  if (row.syncedSourceId) {
    throw new KnowledgeError(
      "FORBIDDEN",
      "Synced documents are read-only; edit the source file in the upstream system",
    )
  }

  const updateShareRole = await loadDocumentShareRole(tx, row.id, actor)
  assertCanWriteDocumentRow(row, actor, updateShareRole)
  if (row.revision !== parsed.revision)
    throw new KnowledgeError("REVISION_CONFLICT", "Revision conflict")

  if (
    parsed.ownerUserId &&
    parsed.ownerUserId !== row.ownerUserId &&
    !scope(actor, "knowledge:documents:assign-owner") &&
    !scope(actor, "knowledge:documents:admin")
  ) {
    forbidden("Forbidden to reassign Knowledge document owner")
  }

  // Only require dimension authority when the patch ACTUALLY changes team or
  // sensitivity to a different value. A no-op (the field is absent, or present
  // but equal to the current value — e.g. a schema default echoing the row's
  // existing sensitivity) must NOT trigger the check: access is governed by the
  // sharing model (org_access + shares + edit_scope), not the team/sensitivity
  // dimensions, so a legitimate editor (owner, org 'editor', C-Level scope, or
  // editor-share) who holds no dimension grant must still be able to edit body/
  // title/summary. Before this, `parsed.sensitivity !== undefined` fired on every
  // edit and demanded a sensitivity dimension grant, 404-ing non-admin C-Level
  // editors (who carry no dimension grants) on docs defaulted to 'internal'.
  const changingTeam =
    parsed.team !== undefined &&
    JSON.stringify([...parsed.team].sort()) !== JSON.stringify([...row.team].sort())
  const changingSensitivity =
    parsed.sensitivity !== undefined && parsed.sensitivity !== row.sensitivity
  if ((changingTeam || changingSensitivity) && row.documentScope === "organization") {
    // Authority over both old and new values of whichever dimension is changing.
    assertCanSetDimensions({ team: row.team, sensitivity: row.sensitivity }, actor)
    assertCanSetDimensions(
      { team: parsed.team ?? row.team, sensitivity: parsed.sensitivity ?? row.sensitivity },
      actor,
    )
  }

  // Build dynamic SET clause
  const sets: ReturnType<typeof drizzleSql>[] = []
  if (parsed.title !== undefined) sets.push(drizzleSql`title = ${parsed.title}`)
  if (parsed.summary !== undefined) sets.push(drizzleSql`summary = ${parsed.summary}`)
  if (parsed.body !== undefined) sets.push(drizzleSql`body = ${parsed.body}`)
  if (parsed.ownerUserId !== undefined)
    sets.push(drizzleSql`owner_user_id = ${parsed.ownerUserId}::uuid`)
  if (parsed.team !== undefined) sets.push(drizzleSql`team = ${JSON.stringify(parsed.team)}::jsonb`)
  if (parsed.sensitivity !== undefined) sets.push(drizzleSql`sensitivity = ${parsed.sensitivity}`)
  if (parsed.orgAccess !== undefined) {
    sets.push(drizzleSql`org_access = ${parsed.orgAccess}`)
  } else if (
    changingSensitivity &&
    (parsed.sensitivity === "confidential" || parsed.sensitivity === "restricted") &&
    row.documentScope === "organization" &&
    (row.orgAccess === "viewer" || row.orgAccess === "editor")
  ) {
    // Auto-tighten (BINDING): reclassifying an org doc TO confidential/
    // restricted with no explicit orgAccess in the same patch must not leave
    // it org-wide readable just because it was created before this policy
    // (or classified less sensitively). Explicit deliberate shares (per-user/
    // per-role) are untouched — only the broad org_access dial is closed.
    sets.push(drizzleSql`org_access = 'none'`)
  }
  // editScope is nullable-clearable: an explicit `null` in the patch clears the scoped-edit
  // gate, so this checks `!== undefined` (not truthiness) same as the other nullable fields.
  if (parsed.editScope !== undefined) sets.push(drizzleSql`edit_scope = ${parsed.editScope}`)
  if (parsed.reviewDueAt !== undefined) sets.push(drizzleSql`review_due_at = ${parsed.reviewDueAt}`)

  // shouldResetVerification needs the merged shape
  const merged = { ...row, ...mapPatchForReview(parsed) }
  let reviewStatus: string | undefined
  if (shouldResetVerification(row, merged)) reviewStatus = "needs_review"
  if (parsed.verifyNow) reviewStatus = "verified"
  if (reviewStatus !== undefined) sets.push(drizzleSql`review_status = ${reviewStatus}`)
  if (parsed.verifyNow) {
    sets.push(drizzleSql`verified_by = ${actor.userId}::uuid`)
    sets.push(drizzleSql`verified_at = now()`)
  }
  sets.push(drizzleSql`updated_by = ${actor.userId}::uuid`)
  sets.push(drizzleSql`updated_at = now()`)
  sets.push(drizzleSql`revision = revision + 1`)
  // D5: the writing turn's scopes join the document's tag. Union, never
  // replace: an empty assertion (a human edit) leaves an existing tag intact.
  sets.push(unionRequiredScopesSql(requiredScopes))

  const setSql = sets.reduce<ReturnType<typeof drizzleSql> | null>(
    (acc, frag) => (acc === null ? frag : drizzleSql`${acc}, ${frag}`),
    null,
  )
  if (setSql) {
    // ATOMIC compare-and-swap (U5.2, calls-connector concurrency): the JS-side
    // `row.revision !== parsed.revision` check above is a SELECT-then-compare —
    // under READ COMMITTED two concurrent updates can BOTH read the same
    // revision, both pass the compare, and the second silently overwrites the
    // first's write while both report success (a lost update; surfaced by the
    // calls webhook's concurrent-append test, the first codepath in the estate
    // to exercise this under real concurrent load). `AND revision =
    // ${parsed.revision}` makes the revision check part of the UPDATE itself:
    // the second writer's UPDATE (which blocks on the first's row lock, then
    // re-evaluates its WHERE against the committed row) matches zero rows and
    // surfaces as REVISION_CONFLICT for the caller to re-read and retry.
    const updateResult = await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("documents")}
      SET ${setSql}
      WHERE id = ${parsed.id}::uuid AND org_id = ${actor.orgId}::uuid
        AND revision = ${parsed.revision}
      RETURNING id
    `)
    // ⛔ NO SILENT NO-OP (BL-277). The service-layer authz (assertCanWriteDocumentRow + the revision
    // check) passed above, so this UPDATE MUST touch exactly one row. If RLS (the UPDATE USING policy)
    // disagrees with the service authz — as it did before this fix, when the RLS policy was owner-only
    // while the service allowed any member to update a shared ORG doc — the UPDATE silently matches ZERO
    // rows and postgres returns success. The old code then reloaded the UNCHANGED row and returned it as
    // "updated", so a knowledge.update CLAIMED to land while writing nothing (the firmware-keep-fresh
    // routine tick's troubleshooting-doc body never persisted; the tick honestly believed it succeeded).
    // Fail LOUDLY instead so any future service-vs-RLS authz drift surfaces as a real error in the tool
    // result, never a swallowed no-op. RETURNING id makes the affected-row count deterministic.
    if (extractRows(updateResult).length === 0) {
      // Zero rows now has TWO possible causes — disambiguate by re-reading the
      // revision: if it moved, this is the concurrent-writer race (the CAS
      // doing its job) → REVISION_CONFLICT so callers retry; only a still-
      // matching revision means the write was blocked by RLS (BL-277's case).
      const fresh = await loadKnowledgeDocument(tx, parsed.id, actor)
      if (fresh && fresh.revision !== parsed.revision) {
        throw new KnowledgeError("REVISION_CONFLICT", "Revision conflict")
      }
      throw new KnowledgeError(
        "FORBIDDEN",
        "Knowledge document update did not persist — the write was blocked at the row-security layer " +
          "despite passing the service authorization check (a service-vs-RLS policy mismatch). The " +
          "document was not modified.",
      )
    }
  }

  // Owner reassignment changes who is implicitly on the ACL (recomputed from
  // owner_user_id/created_by/document_shares) — recompute so search's
  // acl_user_ids never lags a changed owner.
  if (parsed.ownerUserId !== undefined && parsed.ownerUserId !== row.ownerUserId) {
    await recomputeDocumentAcl(tx, parsed.id)
  }

  await tx.queueEvent({
    app: "knowledge",
    entity: "document",
    action: "update",
    entityId: parsed.id,
    data: { id: parsed.id },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })

  const updated = await loadKnowledgeDocument(tx, parsed.id, actor)
  if (!updated) throw new KnowledgeError("NOT_FOUND", "Knowledge document missing after update")
  return updated
}

function mapPatchForReview(
  parsed: KnowledgeUpdateDocument & { id: string },
): Partial<KnowledgeDocumentRow> {
  const out: Partial<KnowledgeDocumentRow> = {}
  if (parsed.title !== undefined) out.title = parsed.title
  if (parsed.summary !== undefined) out.summary = parsed.summary
  if (parsed.body !== undefined) out.body = parsed.body
  if (parsed.ownerUserId !== undefined) out.ownerUserId = parsed.ownerUserId
  if (parsed.team !== undefined) out.team = parsed.team
  if (parsed.sensitivity !== undefined) out.sensitivity = parsed.sensitivity
  return out
}

export async function archiveKnowledgeDocument(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<KnowledgeDocumentRow> {
  if (!scope(actor, "knowledge:documents:archive") && !scope(actor, "knowledge:documents:admin")) {
    forbidden("Forbidden to archive Knowledge document")
  }
  // Load with includeArchived so an ALREADY-archived doc resolves (a normal read
  // filters archived_at IS NULL). This makes re-archiving an already-archived doc
  // an idempotent no-op instead of a spurious NOT_FOUND — the dedupe/consolidation
  // flow archives several originals in one turn and a weak model may double-call
  // archive on the same id; that must not surface a tool error. Symmetric with
  // restoreKnowledgeDocument (IC-7).
  const archivedActor = { ...actor, includeArchived: true }
  const row = await loadKnowledgeDocument(tx, id, archivedActor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
  const archiveShareRole = await loadDocumentShareRole(tx, row.id, actor)
  assertCanWriteDocumentRow(row, archivedActor, archiveShareRole)
  // Only flip + emit the event when the doc is actually ACTIVE — re-archiving an
  // already-archived doc is a no-op (no second `archive` event), mirroring restore.
  const updateResult = await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel("documents")}
    SET archived_at = now(), updated_by = ${actor.userId}::uuid, updated_at = now()
    WHERE id = ${id}::uuid
      AND org_id = ${actor.orgId}::uuid
      AND archived_at IS NULL
    RETURNING id
  `)
  const archived = extractRows<{ id: string }>(updateResult).length > 0
  if (archived) {
    await tx.queueEvent({
      app: "knowledge",
      entity: "document",
      action: "archive",
      entityId: id,
      data: { id },
      actorId: actor.userId,
      actorType: "user",
      orgId: actor.orgId,
    })
  }
  const updated = await loadKnowledgeDocument(tx, id, archivedActor)
  if (!updated) throw new KnowledgeError("NOT_FOUND", "Knowledge document missing after archive")
  return updated
}

export async function restoreKnowledgeDocument(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<KnowledgeDocumentRow> {
  if (!scope(actor, "knowledge:documents:archive") && !scope(actor, "knowledge:documents:admin")) {
    forbidden("Forbidden to restore Knowledge document")
  }
  const archivedActor = { ...actor, includeArchived: true }
  const row = await loadKnowledgeDocument(tx, id, archivedActor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
  const restoreShareRole = await loadDocumentShareRole(tx, row.id, actor)
  assertCanWriteDocumentRow(row, archivedActor, restoreShareRole)
  // IC-7: only emit a restore event when we actually un-archive a row. Calling
  // restore on an already-active document is a no-op — otherwise every retry
  // (or double-click) would emit a spurious `restore` event downstream.
  const updateResult = await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel("documents")}
    SET archived_at = NULL, updated_by = ${actor.userId}::uuid, updated_at = now()
    WHERE id = ${id}::uuid
      AND org_id = ${actor.orgId}::uuid
      AND archived_at IS NOT NULL
    RETURNING id
  `)
  const restored = extractRows<{ id: string }>(updateResult).length > 0
  if (restored) {
    await tx.queueEvent({
      app: "knowledge",
      entity: "document",
      action: "restore",
      entityId: id,
      data: { id },
      actorId: actor.userId,
      actorType: "user",
      orgId: actor.orgId,
    })
  }
  const updated = await loadKnowledgeDocument(tx, id, actor)
  if (!updated) throw new KnowledgeError("NOT_FOUND", "Knowledge document missing after restore")
  return updated
}

export async function verifyKnowledgeDocument(
  tx: RlsClient,
  id: string,
  revision: number,
  actor: KnowledgeActor,
): Promise<KnowledgeDocumentRow> {
  // Verification flips review state only: it writes no content, so it
  // contributes no scopes and the union leaves the document's tag alone.
  return updateKnowledgeDocument(tx, { id, revision, verifyNow: true }, actor, [])
}

// ---------------------------------------------------------------------------
// Document sharing (Google-Drive-style) — org_access + per-user document_shares
// ---------------------------------------------------------------------------

export interface DocumentShareEntry {
  userId: string
  role: "viewer" | "editor"
}

export interface DocumentRoleShareEntry {
  roleId: string
  role: "viewer" | "editor"
}

export interface DocumentSharingState {
  orgAccess: "none" | "viewer" | "editor"
  /**
   * Scoped edit: when set, editing the doc additionally requires the caller to hold
   * this EXACT scope (e.g. "clevel") — see assertCanWriteDocumentRow and the
   * `has_exact_scope` RLS predicate. `null` = no scoped-edit gate. Superseded by
   * role shares for the UI, kept for backward-compat.
   */
  editScope: string | null
  shares: DocumentShareEntry[]
  /**
   * Per-ROLE ACL. `undefined` on WRITE = leave role shares unchanged; on READ
   * this is always populated (possibly empty).
   */
  roleShares?: DocumentRoleShareEntry[]
}

/**
 * Read the current sharing state (org_access + explicit per-user shares) for a
 * document. Requires READ access — mirrors the Drive "who can see this" surface,
 * which any reader (not just the owner) may inspect.
 */
export async function getDocumentSharing(
  tx: RlsClient,
  documentId: string,
  actor: KnowledgeActor,
): Promise<DocumentSharingState> {
  const row = await loadKnowledgeDocument(tx, documentId, actor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
  const shareRole = await loadDocumentShareRole(tx, documentId, actor)
  assertCanReadDocumentRow(row, actor, shareRole)
  const grants = await listGrants(tx, KNOWLEDGE_RESOURCE, documentId)
  return {
    orgAccess: row.orgAccess,
    editScope: row.editScope,
    shares: grants.users,
    roleShares: grants.roles,
  }
}

/**
 * Replace the sharing state for a document: set `org_access` and REPLACE the
 * document_shares roster with exactly the given entries (delete rows not present,
 * upsert the rest). Requires WRITE access on the document.
 */
export async function setDocumentSharing(
  tx: RlsClient,
  documentId: string,
  input: DocumentSharingState,
  actor: KnowledgeActor,
): Promise<DocumentSharingState> {
  const row = await loadKnowledgeDocument(tx, documentId, actor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
  const shareRole = await loadDocumentShareRole(tx, documentId, actor)
  assertCanWriteDocumentRow(row, actor, shareRole)

  await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel("documents")}
    SET org_access = ${input.orgAccess}, edit_scope = ${input.editScope},
        updated_by = ${actor.userId}::uuid, updated_at = now()
    WHERE id = ${documentId}::uuid AND org_id = ${actor.orgId}::uuid
  `)

  // The per-user roster is always replaced; role shares only when given
  // (`undefined` = leave unchanged, backward-compat). One generic replacement
  // (modules/sharing) also refreshes the search ACL projection.
  const desiredUsers = new Map<string, "viewer" | "editor">()
  for (const share of input.shares) desiredUsers.set(share.userId, share.role)
  const userIds = [...desiredUsers.keys()]
  const desiredRoles = new Map<string, "viewer" | "editor">()
  for (const rs of input.roleShares ?? []) desiredRoles.set(rs.roleId, rs.role)
  const roleShareCount = input.roleShares !== undefined ? desiredRoles.size : 0
  await replaceGrants(
    tx,
    { orgId: actor.orgId, userId: actor.userId },
    KNOWLEDGE_RESOURCE,
    documentId,
    {
      users: [...desiredUsers].map(([userId, role]) => ({ userId, role })),
      ...(input.roleShares !== undefined
        ? { roles: [...desiredRoles].map(([roleId, role]) => ({ roleId, role })) }
        : {}),
    },
  )

  await tx.queueEvent({
    app: "knowledge",
    entity: "document",
    action: "share",
    entityId: documentId,
    data: {
      id: documentId,
      orgAccess: input.orgAccess,
      shareCount: userIds.length,
      roleShareCount,
    },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })

  const grants = await listGrants(tx, KNOWLEDGE_RESOURCE, documentId)
  return {
    orgAccess: input.orgAccess,
    editScope: input.editScope,
    shares: grants.users,
    roleShares: grants.roles,
  }
}

/**
 * Search-time guard for the local Knowledge adapter: keep only `document` /
 * `source_link` hits whose row still exists, is not archived, and is visible
 * on `tx`. The Meili index is eventually consistent (a lagging or failed delete
 * job, a stale index restored from backup), and every hit it returns for an
 * archived or deleted row is one the agent then opens and gets `not_found` on.
 *
 * With a `reader`, a document hit is also kept only when that reader passes
 * the very read check `knowledge_get` and the document route run
 * (`assertCanReadDocumentRow` with the reader's user and role shares). Search
 * then never names a document its reader cannot open: no title leaks through
 * an index whose ACL projection lags or differs from the sharing rules, and
 * every hit opens by id. One query per entity type over just the returned ids,
 * plus one share lookup per document only the sharing can open; order is kept.
 */
export async function dropArchivedKnowledgeHits<T extends { sourceEntityId: string; type: string }>(
  tx: RlsClient,
  orgId: string,
  hits: T[],
  reader?: KnowledgeActor,
): Promise<T[]> {
  const live = new Set<string>()
  for (const [type, table] of [
    ["document", "documents"],
    ["source_link", "source_links"],
  ] as const) {
    const ids = hits
      .filter((h) => h.type === type && isUuid(h.sourceEntityId))
      .map((h) => h.sourceEntityId)
    if (ids.length === 0) continue
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${knowledgeRel(table)}
        WHERE org_id = ${orgId}::uuid
          AND archived_at IS NULL
          AND id IN (${uuidList(ids)})
      `),
    )
    for (const r of rows) live.add(`${type}:${r.id}`)
  }
  const liveDocIds = hits
    .filter((h) => h.type === "document" && live.has(`document:${h.sourceEntityId}`))
    .map((h) => h.sourceEntityId)
  if (reader && liveDocIds.length > 0) {
    const docs = extractRows<DocumentDbRow>(
      await tx.execute(drizzleSql`
        SELECT * FROM ${knowledgeRel("documents")}
        WHERE org_id = ${orgId}::uuid AND id IN (${uuidList(liveDocIds)})
      `),
    )
    for (const r of docs) {
      if (!(await canReadDocument(tx, rowFromDb(r), reader))) live.delete(`document:${r.id}`)
    }
  }
  return hits.filter(
    (h) =>
      (h.type !== "document" && h.type !== "source_link") ||
      live.has(`${h.type}:${h.sourceEntityId}`),
  )
}

function uuidList(ids: string[]) {
  return drizzleSql.join(
    ids.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )
}

/** The read check `get` runs, as a boolean; the share lookup only when the sharing decides. */
async function canReadDocument(
  tx: RlsClient,
  row: KnowledgeDocumentRow,
  actor: KnowledgeActor,
): Promise<boolean> {
  const readable = (shareRole: "viewer" | "editor" | null): boolean => {
    try {
      assertCanReadDocumentRow(row, actor, shareRole)
      return true
    } catch (err) {
      if (err instanceof KnowledgeError) return false
      throw err
    }
  }
  if (readable(null)) return true
  return readable(await loadDocumentShareRole(tx, row.id, actor))
}
