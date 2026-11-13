// SPDX-License-Identifier: FSL-1.1-ALv2
// Knowledge handlers: a core app's server module (modules/apps/core/registry.ts).
// Every handler the manifest names is a named export `(params, ctx)`, imported
// and called in the API process with a typed host ctx (modules/apps/core/ctx.ts):
// the run's bridge methods, called directly. Each handler dispatches to a
// `knowledge_*` host method, which sets up the RLS context and calls the
// service layer.

import { csvCell } from "@liaison/shared"
import type { CoreCtx } from "~/modules/apps/core/ctx"

export interface KnowledgeMethods {
  knowledge_search: (paramsJson: string) => Promise<string>
  knowledge_get: (paramsJson: string) => Promise<string>
  knowledge_find_by_title: (paramsJson: string) => Promise<string>
  knowledge_create: (paramsJson: string) => Promise<string>
  knowledge_create_validate: (paramsJson: string) => Promise<string>
  knowledge_update: (paramsJson: string) => Promise<string>
  knowledge_update_validate: (paramsJson: string) => Promise<string>
  knowledge_archive: (paramsJson: string) => Promise<string>
  knowledge_restore: (paramsJson: string) => Promise<string>
  knowledge_attentionItems: (paramsJson: string) => Promise<string>
  knowledge_verify: (paramsJson: string) => Promise<string>
  knowledge_addFolderSource: (paramsJson: string) => Promise<string>
  /** The settings page's synced sources: op list | archive | run_now (bridge knowledge-curation.ts). */
  knowledge_syncedSources: (op: string, paramsJson: string) => Promise<string>
  knowledge_source_link_create: (paramsJson: string) => Promise<string>
  knowledge_collection_create: (paramsJson: string) => Promise<string>
  knowledge_collection_update: (paramsJson: string) => Promise<string>
  knowledge_collection_delete: (paramsJson: string) => Promise<string>
  knowledge_add_to_collection: (paramsJson: string) => Promise<string>
  knowledge_remove_from_collection: (paramsJson: string) => Promise<string>
  db_findMany: (entity: string, optsJson: string) => Promise<string>
  /** The declared cross-app caller ONLY when the kernel recognises this exact dispatch as an
   *  ingestion path (the caller declares it in cross_app_calls and the pair is a kernel
   *  ingestion); "" for everything else, a direct call included. */
  getIngestionCallerApp?: () => string | Promise<string>
  /** K6 handler-conditional gating: park this call behind a human approval. */
  requestApproval?: (inputJson: string) => Promise<string>
}

/** `ctx.approval` is the K6 post-approval re-entry signal (null on a first entry). */
type KnowledgeCtx = CoreCtx<KnowledgeMethods>

// ── Org-wide write gating (handler-conditional, tighten-only) ─────────────────
//
// Product default: a write that lands on an ORGANIZATION-scoped Knowledge
// document (the whole org reads it — policies, processes, prices) is gated
// behind a human approval; a PERSONAL note stays ungated. Decided here (not a
// static manifest `gated: true`) because the scope is only known from the
// params (create) or the target document (update/archive). Tighten-only with
// respect to org policies: the kernel's approval-policy composition can still
// escalate further, and this built-in gate can never be loosened by it.

function truncateForCard(v: unknown, max = 140): string {
  const s = typeof v === "string" ? v : ""
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** The target document's scope, via the knowledge_get bridge; null when the
 *  document cannot be read (the real handler then fails with its own
 *  readable not_found — gating an unreadable target would only stage a
 *  doomed approval). */
async function documentScopeOf(
  ctx: KnowledgeCtx,
  id: unknown,
): Promise<"personal" | "organization" | null> {
  if (typeof id !== "string" || id === "") return null
  try {
    const res = JSON.parse(await ctx.knowledge_get(JSON.stringify({ id }))) as {
      status?: string
      document?: { document_scope?: string; title?: string }
    }
    const s = res?.document?.document_scope
    return s === "personal" || s === "organization" ? s : null
  } catch {
    return null
  }
}

/**
 * Stage the approval and return the pending envelope the agent reports, or
 * `null` when the kernel granted it inline: a person's own call made by someone
 * holding the deciding scope never parks (approvals are for agents), so the
 * caller carries on and writes.
 */
async function parkForApproval(
  ctx: KnowledgeCtx,
  input: {
    tool_name: string
    summary: string
    lines: string[]
    payload: unknown
    editable_fields?: string[]
  },
): Promise<unknown | null> {
  if (!ctx.requestApproval) {
    // Defensive: without the bridge the gate cannot be enforced here — fail
    // CLOSED (never silently write org knowledge ungated).
    throw new Error(
      `${input.tool_name} requires approval for organization-scoped documents, but no approval channel is available in this execution context.`,
    )
  }
  const res = JSON.parse(
    await ctx.requestApproval(
      JSON.stringify({
        tool_name: input.tool_name,
        summary: input.summary,
        summary_detail: { lines: input.lines },
        current_payload: input.payload,
        ...(input.editable_fields ? { editable_fields: input.editable_fields } : {}),
      }),
    ),
  ) as { approval_id: string | null; auto_approved?: true }
  if (res.auto_approved === true) return null
  return {
    status: "pending_approval",
    approval_id: res.approval_id,
    note: "Organization-wide knowledge writes require a human approval. Report this as pending, never as done.",
  }
}

const KNOWLEDGE_EXPORT_COLUMNS: Array<[string, string]> = [
  ["id", "id"],
  ["title", "title"],
  ["summary", "summary"],
  ["scope", "scope"],
  ["status", "status"],
  ["ownerUserId", "owner_user_id"],
  ["createdAt", "created_at"],
]

export async function exportKnowledge(params: unknown, ctx: KnowledgeCtx): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>
  const format = p.format ?? "json"
  const dateRange = p.dateRange as { from?: string; to?: string } | undefined
  const rows: Array<Record<string, unknown>> = []
  for (let offset = 0; ; offset += 1000) {
    const page: Array<Record<string, unknown>> = JSON.parse(
      await ctx.db_findMany(
        "documents",
        JSON.stringify({ orderBy: { createdAt: "asc" }, limit: 1000, offset }),
      ),
    )
    rows.push(...page)
    if (page.length < 1000) break
  }
  const fromT = dateRange?.from ? Date.parse(dateRange.from) : Number.NEGATIVE_INFINITY
  const toT = dateRange?.to ? Date.parse(dateRange.to) : Number.POSITIVE_INFINITY
  const ranged =
    dateRange?.from || dateRange?.to
      ? rows.filter((r) => {
          const t = Date.parse(String(r.created_at ?? ""))
          return t >= fromT && t <= toT
        })
      : rows
  const projected = ranged.map((row) => {
    const out: Record<string, string> = {}
    for (const [outKey, dbKey] of KNOWLEDGE_EXPORT_COLUMNS) {
      const v = row[dbKey]
      out[outKey] = v === null || v === undefined ? "" : String(v)
    }
    return out
  })
  if (format === "csv") {
    const header = KNOWLEDGE_EXPORT_COLUMNS.map(([k]) => k).join(",")
    const body = projected
      .map((r) => KNOWLEDGE_EXPORT_COLUMNS.map(([k]) => csvCell(r[k])).join(","))
      .join("\n")
    return body ? `${header}\n${body}\n` : `${header}\n`
  }
  return projected
}

export async function search(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_search(JSON.stringify(params ?? {})))
}

export async function get(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_get(JSON.stringify(params ?? {})))
}

// find_by_title (U5.8) — DB-backed exact-title lookup, no search index. See
// agent-tools.ts's handleKnowledgeFindByTitle for the read-authorization contract.
export async function find_by_title(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_find_by_title(JSON.stringify(params ?? {})))
}

/** The caller app when the KERNEL recognises this dispatch as an ingestion path, "" otherwise.
 *  Awaited: the bridge may answer it synchronously or not. Fails closed: a bridge that does not answer it gates the create
 *  exactly as an agent-initiated one. */
async function ingestionCallerOf(ctx: KnowledgeCtx): Promise<string> {
  if (typeof ctx.getIngestionCallerApp !== "function") return ""
  try {
    const v = await ctx.getIngestionCallerApp()
    return typeof v === "string" ? v : ""
  } catch {
    return ""
  }
}

export async function create(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  const p = params ?? {}
  // Org-scoped create (documentScope omitted defaults to organization in the
  // bridge) is gated; a personal note stays ungated.
  //
  // CONNECTOR INGESTION IS NOT AN AGENT DECISION. An app-to-app create
  // dispatched through the K4 cross_app_calls contract (a webhook ingestion,
  // e.g. the calls connector's per-call transcript document) is a machine write
  // path: there is no agent proposing it and no human watching the turn, so an
  // approval raised here is never seen and the sender retries forever. Human
  // review still happens, one step later: the bridge files a connector-created
  // document into the knowledge review queue unverified, and knowledge:verify
  // promotes it. An agent-initiated create keeps the gate exactly as before.
  //
  // FX22 F6: the skip asks for an INGESTION, not merely for a caller app. Any
  // declared cross-app call used to buy it, and only the registry's own contents
  // kept that to one path; the kernel now answers with the caller only when this
  // exact dispatch is a recognised ingestion (declared by the caller AND listed
  // in the kernel's ingestion paths), so the exemption cannot widen behind a new
  // declaration nobody re-read.
  const ingestionCaller = await ingestionCallerOf(ctx)
  if (!ctx.approval && !ingestionCaller && p.documentScope !== "personal") {
    // NEVER park an approval for a call that cannot execute. The placement +
    // access guard (collection filed, org doc access-classified, confidential /
    // restricted doc shared with named roles) used to run only AFTER the human
    // approved, so a create missing that data failed in the APPROVER'S hands
    // with an error only the agent could fix. Validate first and hand the
    // structured error back to the agent instead of queueing a doomed card.
    const validation = JSON.parse(await ctx.knowledge_create_validate(JSON.stringify(p))) as {
      error?: { code: string; message: string }
    }
    if (validation.error) return { error: validation.error }
    const parked = await parkForApproval(ctx, {
      tool_name: "knowledge:create",
      summary: `Create organization knowledge document: ${truncateForCard(p.title) || "(untitled)"}`,
      lines: [
        `Title: ${truncateForCard(p.title) || "(untitled)"}`,
        ...(typeof p.summary === "string" && p.summary
          ? [`Summary: ${truncateForCard(p.summary)}`]
          : []),
        ...(typeof p.body === "string" && p.body ? [`Body: ${truncateForCard(p.body)}`] : []),
        "Scope: organization (visible to the whole org)",
      ],
      payload: p,
      editable_fields: ["title", "body"],
    })
    if (parked !== null) return parked
  }
  return JSON.parse(await ctx.knowledge_create(JSON.stringify(p)))
}

export async function update(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  const p = params ?? {}
  if (!ctx.approval) {
    const scope = await documentScopeOf(ctx, p.id)
    if (scope === "organization") {
      // NEVER park an approval for a call that cannot execute. The update
      // guards (document exists, not a read-only synced doc, caller may write
      // it, revision still current) used to run only AFTER the human approved,
      // so the approver met the error instead of the agent.
      const validation = JSON.parse(await ctx.knowledge_update_validate(JSON.stringify(p))) as {
        error?: { code: string; message: string }
      }
      if (validation.error) return { error: validation.error }
      const parked = await parkForApproval(ctx, {
        tool_name: "knowledge:update",
        summary: `Update organization knowledge document: ${truncateForCard(p.title) || String(p.id ?? "")}`,
        lines: [
          `Document: ${String(p.id ?? "")}`,
          ...(typeof p.title === "string" && p.title
            ? [`New title: ${truncateForCard(p.title)}`]
            : []),
          ...(typeof p.body === "string" && p.body ? [`New body: ${truncateForCard(p.body)}`] : []),
          "Scope: organization (visible to the whole org)",
        ],
        payload: p,
        editable_fields: ["title", "body"],
      })
      if (parked !== null) return parked
    }
  }
  return JSON.parse(await ctx.knowledge_update(JSON.stringify(p)))
}

// archive — retire a Knowledge document (reversible soft-archive). Gated behind
// knowledge:documents:archive (enforced in the bridge + archiveKnowledgeDocument).
// Lets the agent cleanly retire a wrong/superseded/duplicate doc instead of
// fabricating an '[ARCHIVED]' stub.
export async function archive(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  const p = params ?? {}
  if (!ctx.approval) {
    const scope = await documentScopeOf(ctx, p.id)
    if (scope === "organization") {
      const parked = await parkForApproval(ctx, {
        tool_name: "knowledge:archive",
        summary: `Archive organization knowledge document ${String(p.id ?? "")}`,
        lines: [
          `Document: ${String(p.id ?? "")}`,
          "Archiving hides it from the whole org (reversible via restore).",
        ],
        payload: p,
      })
      if (parked !== null) return parked
    }
  }
  return JSON.parse(await ctx.knowledge_archive(JSON.stringify(p)))
}

// restore — un-archive a previously-archived document. No-op if already active.
export async function restore(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_restore(JSON.stringify(params ?? {})))
}

export async function collection_create(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_collection_create(JSON.stringify(params ?? {})))
}

export async function collection_update(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_collection_update(JSON.stringify(params ?? {})))
}

export async function collection_delete(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_collection_delete(JSON.stringify(params ?? {})))
}

export async function add_to_collection(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_add_to_collection(JSON.stringify(params ?? {})))
}

export async function remove_from_collection(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_remove_from_collection(JSON.stringify(params ?? {})))
}

export async function computeAttentionItems(
  _params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_attentionItems("{}"))
}

// review_queue — read-only surfacing of needs_review/stale/owner-missing/expired
// knowledge items. Returns `{ items }` so callers (and the I1 test) can read a
// stable shape; reuses the already-wired attention substrate.
export async function reviewQueue(
  _params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  const items = JSON.parse(await ctx.knowledge_attentionItems("{}"))
  return { items }
}

// verify — flips a document (or source link) to reviewStatus 'verified'. Gated
// behind knowledge:documents:update (enforced in the bridge + verifySourceLink).
export async function verify(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_verify(JSON.stringify(params ?? {})))
}

// add_folder_source — connect a Drive folder as a synced Knowledge source.
// oneShot:true harvests once then archives the source (one-time bulk import);
// otherwise it stays connected for recurring sync. Gated behind
// knowledge:sources:manage for organization scope (enforced in createSyncedSource).
export async function addFolderSource(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_addFolderSource(JSON.stringify(params ?? {})))
}

// source_link_create — register a LIVING source_link that POINTS at a remote
// document (a Google Drive file, etc.) without copying its content. This is the
// "track / reference / register the live doc" path: the entry stays authoritative
// externally and always reflects the current remote doc, unlike `create` which
// freezes a local document copy. Gated behind knowledge:links:create (enforced in
// the bridge + linkRemoteDocument). The remote is re-probed before the write, so
// a link can only be registered for a doc that actually exists/is visible.
export async function source_link_create(
  params: Record<string, unknown> | undefined,
  ctx: KnowledgeCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_source_link_create(JSON.stringify(params ?? {})))
}

// The settings page's synced sources list (tools synced_sources.list /
// archive / run_now), the same data and checks as /api/knowledge/synced-sources.
export async function syncedSourcesList(_params: unknown, ctx: KnowledgeCtx): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_syncedSources("list", "{}"))
}
export async function syncedSourcesArchive(params: unknown, ctx: KnowledgeCtx): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_syncedSources("archive", JSON.stringify(params ?? {})))
}
export async function syncedSourcesRunNow(params: unknown, ctx: KnowledgeCtx): Promise<unknown> {
  return JSON.parse(await ctx.knowledge_syncedSources("run_now", JSON.stringify(params ?? {})))
}
