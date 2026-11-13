// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import {
  recordAgentKnowledgePointers,
  recordAgentKnowledgePointersForDocument,
} from "~/modules/agent/knowledge/knowledge-pointers"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import {
  bridgeKnowledgeActorInput,
  extractRoutineBoundDocId,
} from "~/modules/apps/sandbox/bridge/shared"

/**
 * DETERMINISTIC ROUTINE-BOUND RUNNING DOC (BL-275, dealer-price-watch-weekly duplicate-doc fail). When a
 * knowledge_create runs inside a ROUTINE TICK whose authored prompt carries the binding directive
 * (create_routine injects "MAINTAIN THIS EXISTING RUNNING DOC … id <UUID>" when the org has a unique
 * running doc the watch is about), return THAT bound doc — so the tick's create is redirected onto the one
 * running doc even when a flash-lite tick invents a wholly-unrelated findings-doc title that no
 * title-similarity guard can catch. Returns the writable bound doc, else null (not a tick / no directive /
 * doc gone / not writable). Best-effort + read-only: any error → null (never blocks the create).
 */
async function findRoutineBoundRunningDoc(
  tx: RlsClient,
  orgId: string,
  actor: unknown,
  /**
   * The routine-tick id, CAPTURED at bridge construction (in-frame). Prefer this over `currentRunContext()`
   * — an untrusted sandbox app (knowledge) calls this redirect from a WORKER-POOL callback where the
   * routine-tick ALS frame is LOST, so reading `currentRunContext()` here returns undefined and the redirect
   * bypasses → a duplicate watch doc lands (the forensic-confirmed competitor-firmware-news-watch root
   * cause). Falls back to the ALS frame for host-side callers that still run in-frame.
   */
  capturedRoutineId?: string,
): Promise<{ id: string; title: string; revision: number } | null> {
  const routineId = capturedRoutineId ?? currentRunContext()?.routineId
  if (!routineId) return null
  try {
    // ⛔ SCHEMA-PREFIX (BL-275, competitor-firmware-news-watch run-2 fail). Use schemaRef("kernel") — NOT a
    // hardcoded "kernel".routines. In a chaos WORLD the routine tick runs with SCHEMA_PREFIX set, so a
    // hardcoded "kernel".routines reads the EMPTY base schema, finds no routine prompt → no bound-doc
    // directive is parsed → the tick's knowledge_create is NOT redirected onto the running doc and a
    // duplicate doc is created (the run-2 fail). schemaRef resolves the prefixed schema in chaos and the
    // bare "kernel" in prod (prefix empty).
    const promptRows = extractRows<{ prompt: string | null }>(
      await tx.execute(
        drizzleSql`SELECT prompt FROM ${drizzleSql.raw(`"${schemaRef("kernel")}"`)}.routines WHERE id = ${routineId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`,
      ),
    )
    const boundId = extractRoutineBoundDocId(promptRows[0]?.prompt)
    if (!boundId) return null
    const { loadKnowledgeDocument, loadDocumentShareRole, assertCanWriteDocumentRow } =
      await import("~/apps/knowledge/service")
    const doc = await loadKnowledgeDocument(tx as never, boundId, actor as never)
    if (!doc) return null
    // Only redirect onto a doc the tick's actor may UPDATE — else fall through to a normal create.
    const shareRole = await loadDocumentShareRole(tx, doc.id, actor as never)
    assertCanWriteDocumentRow(doc as never, actor as never, shareRole)
    return { id: doc.id, title: doc.title, revision: doc.revision }
  } catch {
    return null
  }
}

/**
 * PERIOD-SNAPSHOT DISCLAIMER INJECTION (claire-routine-monthend-close-pack, l710 server-side discrimination).
 * Inside a routine TICK whose authored prompt is the PERIOD-SNAPSHOT shape (lists a prior period's invoices
 * GROUPED by VAT treatment AND saves a Knowledge snapshot doc — the audit-trail close pack), the persisted
 * snapshot doc IS the load-bearing deliverable and MUST carry the bounded/non-authoritative-listing caveat
 * (there is no server-side VAT/period aggregate, so the per-treatment subtotals are in-context page-bounded
 * approximations, not an authoritative VAT total). A create_routine STEER asks the conductor to bake that
 * caveat into the routine prompt + the saved doc body — but the flash-lite TICK that renders the body is
 * pinned and VARIES on whether it actually writes the caveat INTO the doc body (a 3× gate's run-2 failed:
 * the doc body presented uncaveated "Group Total" sums as a definitive aggregate — the partial-honesty FAIL).
 * The robust fix (the l710 doctrine: move the discrimination off the flash-lite-pinned tick) is to PREPEND
 * the verbatim disclaimer to the doc body server-side when a period-snapshot tick's create omits it — so the
 * persisted deliverable is ALWAYS honestly framed regardless of tick variance. Only fires inside a routine
 * tick (capturedRoutineId present) whose prompt is the period-snapshot shape AND whose body lacks a caveat;
 * a tick that already wrote the caveat is left untouched (no double-prepend). Returns the body to persist.
 */
async function maybePrependPeriodSnapshotDisclaimer(
  tx: RlsClient,
  orgId: string,
  capturedRoutineId: string | undefined,
  body: string | null | undefined,
): Promise<string | null | undefined> {
  const routineId = capturedRoutineId ?? currentRunContext()?.routineId
  if (!routineId) return body
  try {
    const {
      isPeriodSnapshotRoutinePrompt,
      bodyHasNonAuthoritativeCaveat,
      PERIOD_SNAPSHOT_DISCLAIMER,
    } = await import("~/modules/agent/tools/skills-routines-tools")
    // Already honest? leave the tick's own caveat in place (no double-prepend).
    if (typeof body === "string" && bodyHasNonAuthoritativeCaveat(body)) return body
    // The routine prompt lives in kernel.routines — a KERNEL table the SANDBOXED knowledge app's RLS-scoped
    // `tx` CANNOT read (its app actor holds no kernel scope), so an app-tx SELECT returns 0 rows (the
    // forensic-confirmed root cause: rowCount=0 even with no org filter → isPeriodSnapshot always false →
    // the injection never fired). Read the prompt via the PRIVILEGED db (the same path the bridge uses for
    // its other kernel reads — approval bookkeeping, ticket-account loads), org-scoped, so the
    // period-snapshot detection actually sees the authored prompt.
    const { withPrivilegedDb } = await import("~/db/privileged")
    const prompt = await withPrivilegedDb(orgId, "period-snapshot-disclaimer", async (ptx) => {
      const rows = extractRows<{ prompt: string | null }>(
        await ptx.execute(
          drizzleSql`SELECT prompt FROM ${drizzleSql.raw(`"${schemaRef("kernel")}"`)}.routines WHERE id = ${routineId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`,
        ),
      )
      return rows[0]?.prompt ?? null
    })
    if (!isPeriodSnapshotRoutinePrompt(prompt)) return body
    // Prepend the verbatim disclaimer so the SAVED doc body is honestly framed even if the tick omitted it.
    const existing = typeof body === "string" ? body : ""
    return existing ? `${PERIOD_SNAPSHOT_DISCLAIMER}\n\n${existing}` : PERIOD_SNAPSHOT_DISCLAIMER
  } catch {
    // Best-effort honesty enrichment — never block a legitimate create on the disclaimer lookup.
    return body
  }
}

/**
 * Ready-to-paste entity-mention tag for a Knowledge document — the SAME wire
 * format the compose bar serializes (`@[Label](app:entityType:id)`), so an
 * agent that drops it verbatim into a reply gets a clickable mention pill that
 * opens the document tab. The label escapes `\` and `]` per the frontend
 * mention tokenizer (`(?:[^\]\\]|\\.)+`).
 */
function knowledgeMentionTag(title: string | undefined, id: string): string {
  const label = (title && title.trim() ? title : "Knowledge document").replace(
    /[\\\]]/g,
    (m) => `\\${m}`,
  )
  return `@[${label}](knowledge:document:${id})`
}

/**
 * Attached to a `knowledge_search` result that found nothing. A fixed string
 * (never per-query text) so every model reads the same instruction.
 */
export const KNOWLEDGE_SEARCH_NO_HITS_NOTE =
  "No document matched these words. Search matches the words a document contains, so a question asked in one language does not find documents written in another. Before you say the knowledge base has nothing on this, search again with the key terms translated into English (the usual language of company documents, e.g. 'gross margin Q3' for 'marge brute T3'), then with fewer or other keywords (a synonym, the document's likely title). Still answer the user in their own language."

/**
 * PLACEMENT + ACCESS GUARD for a Knowledge create — shared by `knowledge_create`
 * (execution) and `knowledge_create_validate` (STAGING). A gated org-scoped
 * create parks a human approval BEFORE the handler runs, so running these
 * checks only at execution time meant a create missing its collection or its
 * access classification failed IN THE APPROVER'S HANDS: the human is shown a
 * card, clicks approve, and gets "must be explicitly access-classified" for data
 * only the agent could have supplied. A gated call whose required data is absent
 * must be REFUSED AT STAGING, never queued for a human to discover. Reads only
 * (collection lookups) — safe to run twice.
 *
 * Mutates `params` (strips collectionId/shareWithRoles, which are bridge-level
 * concepts the service-layer create does not know) — pass a COPY when validating.
 */
export type KnowledgeCreatePlacement = {
  collectionId: string
  collectionName: string
  roleShares: Array<{ roleId: string; role: "viewer" | "editor" }>
}
export async function validateKnowledgeCreatePlacement(args: {
  txDb: unknown
  params: Record<string, unknown>
  actor: import("~/apps/knowledge/service").KnowledgeActor
  wantScope: unknown
  /** bridgeOptions.callerApp — set only for a K4 cross_app_calls dispatch. */
  callerApp: string | undefined
  appName: string
}): Promise<
  { error: { code: string; message: string } } | { placement: KnowledgeCreatePlacement | null }
> {
  const { txDb, params, actor, wantScope, callerApp, appName } = args
  // PLACEMENT + ACCESS GUARD — EVERY agent-created document must be
  // deliberately FILED into a collection (personal docs included: a path,
  // never free-floating), and an ORG document must additionally be
  // ACCESS-CLASSIFIED (an explicit sensitivity, plus explicit role shares
  // when confidential/restricted). Without this every agent-authored doc
  // landed free-floating (no collection) and org-wide EDITABLE (the
  // silent 'internal' default) — including a high-value finance analysis.
  // Errors are RETURNED (not thrown) and carry the data the agent needs
  // to retry correctly. The running-doc redirects above bypass this on
  // purpose: they UPDATE an existing, already-placed document.
  const isOrgCreate = wantScope === "organization" || wantScope === undefined
  // CROSS-APP CONNECTOR EXEMPTION (U5.8, caught live on the phase-5 staging gate):
  // the placement guard below exists for AGENT-authored documents (an LLM leaving
  // free-floating, unclassified docs). An app-to-app create dispatched through the
  // K4 cross_app_calls contract (bridgeOptions.callerApp set by execute-tool.ts) is
  // a CONNECTOR writing its own deterministic state — e.g. the calls app's per-call
  // 'Appel — <callRef>' transcript docs, filed by title+tag convention per its
  // design — already doubly authorized (install-approved manifest declaration +
  // the verifier's explicit knowledge:documents:* scope grant, which deliberately
  // excludes collections:manage). Forcing the guard here 503'd every transcript
  // ingest ("collections_scope_required"). The guard still applies to every direct
  // user/agent/MCP create (callerApp undefined).
  const isCrossAppConnectorCreate =
    typeof callerApp === "string" && callerApp.length > 0 && callerApp !== appName
  let placement: {
    collectionId: string
    collectionName: string
    roleShares: Array<{ roleId: string; role: "viewer" | "editor" }>
  } | null = null
  if (!isCrossAppConnectorCreate) {
    const { listKnowledgeCollections, loadCollection } = await import(
      "~/apps/knowledge/collections"
    )
    const { hasScope } = await import("~/modules/permissions/permissions")
    if (
      !hasScope("knowledge:collections:manage", actor.scopes) &&
      !hasScope("knowledge:documents:admin", actor.scopes)
    ) {
      return {
        error: {
          code: "collections_scope_required",
          message:
            "Creating a Knowledge document requires filing it into a collection, " +
            "which needs the knowledge:collections:manage scope this caller lacks. Ask an admin " +
            "to grant it.",
        },
      }
    }
    const describeCollections = async (): Promise<string> => {
      const cols = await listKnowledgeCollections(txDb as never, actor)
      return cols.length > 0
        ? `Existing collections: ${cols.map((c) => `"${c.name}" (id ${c.id})`).join(", ")}.`
        : 'No collections exist yet — create one first with collection_create (e.g. "Finance", "Support", "Engineering").'
    }
    const collectionId = typeof params.collectionId === "string" ? params.collectionId : ""
    if (!collectionId) {
      return {
        error: {
          code: "collection_required",
          message:
            "Knowledge documents must be filed into a collection — pass collectionId " +
            `(pick the best-fitting existing collection, or create one). ${await describeCollections()}`,
        },
      }
    }
    const collection = await loadCollection(txDb as never, collectionId, actor)
    if (!collection || collection.archivedAt) {
      return {
        error: {
          code: "collection_not_found",
          message: `No active collection with id ${collectionId}. ${await describeCollections()}`,
        },
      }
    }
    placement = { collectionId, collectionName: collection.name, roleShares: [] }
    delete params.collectionId
  }
  // Access-classification gate: also agent-only (see the connector exemption
  // above) — a connector's deterministic docs take the service-layer defaults.
  if (isOrgCreate && !isCrossAppConnectorCreate) {
    const sensitivityParam = typeof params.sensitivity === "string" ? params.sensitivity : ""
    if (!sensitivityParam) {
      return {
        error: {
          code: "sensitivity_required",
          message:
            "Organization Knowledge documents must be explicitly access-classified — pass " +
            "sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'. Commercially " +
            "sensitive material (pricing, margins, revenue/finance analyses, contract terms) is " +
            "'confidential' or tighter; 'internal'/'public' documents are readable AND editable " +
            "org-wide by default.",
        },
      }
    }
    const rawShares = Array.isArray(params.shareWithRoles) ? params.shareWithRoles : []
    const roleShares: Array<{ roleId: string; role: "viewer" | "editor" }> = []
    for (const entry of rawShares) {
      const e = entry as { roleId?: unknown; access?: unknown }
      if (
        typeof e.roleId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(e.roleId) ||
        (e.access !== "viewer" && e.access !== "editor")
      ) {
        return {
          error: {
            code: "invalid_share",
            message:
              "Each shareWithRoles entry must be { roleId: <uuid from the kernel roles_list tool>, " +
              "access: 'viewer' | 'editor' }.",
          },
        }
      }
      roleShares.push({ roleId: e.roleId, role: e.access })
    }
    if (
      (sensitivityParam === "confidential" || sensitivityParam === "restricted") &&
      roleShares.length === 0
    ) {
      return {
        error: {
          code: "access_rules_required",
          message:
            "A confidential/restricted document is invisible to everyone except its owner until " +
            "shared. Pass shareWithRoles: [{ roleId, access: 'viewer' | 'editor' }] naming who may " +
            "access it — call the kernel roles_list tool to find the right role (e.g. a C-Level / " +
            "executive role for finance or pricing figures).",
        },
      }
    }
    if (placement) placement.roleShares = roleShares
    // shareWithRoles is a bridge-level concept; strip it before the
    // service-layer create (its zod schema does not know it).
    delete params.shareWithRoles
  }
  return { placement }
}

/** The knowledge app surface: search, read and document writes. */
export function createKnowledgeMethods(ctx: BridgeContext): Record<string, any> {
  const {
    appName,
    approvalContext,
    auditActorType,
    bridgeActingAgentId,
    bridgeOptions,
    bridgeRoutineId,
    callerScopes,
    knowledgeWriteRequiredScopes,
    orgId,
    txDb,
    userId,
  } = ctx
  // Tool results go to a model when an agent or an MCP client is the reader.
  const readerIsModel = auditActorType === "agent" || auditActorType === "mcp"
  // A read that hands the agent text a third party wrote (a document synced from an external source,
  // a remote source item, a hit that points at one) taints the turn exactly like a mail or web read:
  // an ungated outward action afterwards parks as an approval (scopes/taint.ts). Fail closed: when
  // the mark cannot be recorded the read throws rather than hand the text over unmarked.
  const taintTurnForExternalText = async (): Promise<void> => {
    const threadId = bridgeOptions?.threadId
    if (!threadId) return
    const { setTaintFlag } = await import("~/modules/agent/scopes/taint")
    await setTaintFlag(threadId, orgId)
  }
  // A short transaction of its own for one DB step. knowledge_search and
  // knowledge_get are tx-less on a session bridge (rpc-bridge.ts): they wake the
  // apps behind remote sources, never inside a transaction.
  const dbStep = <T>(fn: (tx: RlsClient) => Promise<T>): Promise<T> =>
    bridgeOptions?.withShortTx ? bridgeOptions.withShortTx(fn) : fn(txDb)
  const methods: Record<string, any> = {
    // --- Knowledge tool bridges (T13) ---
    knowledge_search: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_search is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        query?: string
        limit?: number
        sources?: string[]
        cursors?: Record<string, string>
        filters?: Record<string, unknown>
        mode?: "blended" | "per_source" | "both"
      }
      const { knowledgeActorFromContext, dropArchivedKnowledgeHits } = await import(
        "~/apps/knowledge/service"
      )
      const { federatedKnowledgeSearch, scrubSourceStatuses } = await import(
        "~/apps/knowledge/federated-search"
      )
      const { registerDefaultKnowledgeSources } = await import("~/apps/knowledge/source-registry")
      const { loadSearchPolicies } = await import("~/apps/knowledge/sources")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      // The remote sources the caller reaches: the apps that declare
      // `knowledgeItems.search`, woken for this person (source-registry.ts).
      const registry =
        bridgeOptions?.knowledgeRegistryOverride ??
        (await registerDefaultKnowledgeSources({
          orgId,
          userId,
          scopes: callerScopes ?? [],
          searchPolicy: await dbStep((tx) => loadSearchPolicies(tx)),
        }))
      // Local knowledge search: run the same Meili-backed query the HTTP
      // /knowledge/search route uses, so agent tool calls see the same docs a
      // human-driven search would. Without this the tool would only ever
      // return remote (Drive) hits and the cross-source citation contract
      // breaks (Phase 11 S4).
      const { searchLocalKnowledge } = await import("~/apps/knowledge/local-search")
      const result = await federatedKnowledgeSearch(
        {
          query: params.query ?? "",
          limit: params.limit ?? 20,
          mode: params.mode,
          sources: params.sources,
          cursors: params.cursors,
          filters: params.filters,
        },
        {
          actor,
          registry,
          localSearch: async () => {
            const q = (params.query ?? "").trim()
            if (!q) {
              return {
                hits: [],
                status: {
                  source: "knowledge",
                  state: "skipped" as const,
                  retryable: false,
                  hitCount: 0,
                },
              }
            }
            try {
              const limit = Math.min(Math.max(params.limit ?? 20, 1), 20)
              // Narrowed to Knowledge in the engine (local-search.ts), then
              // paged through the read guard: the index can lag an archive or
              // delete, so a hit whose row is archived, gone or unreadable is
              // never returned (opening it would return not_found) nor counted.
              const hits = await searchLocalKnowledge({
                actor,
                q,
                limit,
                keep: (indexed) =>
                  dbStep((tx) => dropArchivedKnowledgeHits(tx, actor.orgId, indexed, actor)),
              })
              return {
                hits,
                status: {
                  source: "knowledge",
                  state: "complete" as const,
                  retryable: false,
                  hitCount: hits.length,
                },
              }
            } catch (err) {
              return {
                hits: [],
                status: {
                  source: "knowledge",
                  state: "error" as const,
                  retryable: true,
                  message: (err as Error)?.message,
                  hitCount: 0,
                },
              }
            }
          },
        },
      )
      if (
        (result.hits as Array<{ source?: string; type?: string }>).some(
          (h) => (h.source !== undefined && h.source !== "knowledge") || h.type === "source_link",
        )
      ) {
        await taintTurnForExternalText()
      }
      // Same wire scrub as the HTTP route: a failed source's raw error text
      // (a DB error's SQL, a remote's host or token) never reaches the agent.
      return JSON.stringify({
        ...result,
        sourceStatuses: scrubSourceStatuses(result.sourceStatuses),
        // Nothing matched: the likeliest miss is a question asked in one
        // language about documents written in another (keyword search finds
        // only words the document contains). Tell the agent how to retry.
        ...(result.hits.length === 0 && (params.query ?? "").trim()
          ? { note: KNOWLEDGE_SEARCH_NO_HITS_NOTE }
          : {}),
      })
    },
    knowledge_get: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_get is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        id?: string
        source?: string
        sourceEntityId?: string
        purpose?: string
      }
      const {
        knowledgeActorFromContext,
        loadKnowledgeDocument,
        loadDocumentShareRole,
        assertCanReadDocumentRow,
      } = await import("~/apps/knowledge/service")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      if (params.id) {
        const id = params.id
        const read = await dbStep(async (tx) => {
          const row = await loadKnowledgeDocument(tx, id, actor)
          if (!row) return null
          try {
            assertCanReadDocumentRow(row, actor, await loadDocumentShareRole(tx, row.id, actor))
          } catch {
            return null
          }
          return row
        })
        if (!read) return JSON.stringify({ status: "not_found" })
        const row = read
        if (row.syncedSourceId) {
          await taintTurnForExternalText()
          // A synced document's body is the external source's text: fenced as
          // untrusted data for a model reader, as the remote branch below is.
          if (readerIsModel && typeof row.body === "string" && row.body) {
            const { wrapExternalContent } = await import("~/lib/external-content")
            return JSON.stringify({
              status: "available",
              document: { ...row, body: wrapExternalContent(row.body) },
            })
          }
        }
        return JSON.stringify({ status: "available", document: row })
      }
      if (params.source && params.sourceEntityId) {
        // Remote retrieval — fetch a linked source item's REAL content (e.g. a
        // Google Doc's exported text) so the agent can ground a Knowledge body
        // in it rather than fabricate one. Gated behind knowledge:sources:read
        // (the source-read scope, distinct from documents:read used for local
        // get). Routes through the same source registry the federated search
        // uses: the source's app resolves the item with its text (knowledgeItems.resolve).
        const { hasScope } = await import("~/modules/permissions/permissions")
        if (!hasScope("knowledge:sources:read", actor.scopes)) {
          return JSON.stringify({
            status: "forbidden",
            error: {
              code: "forbidden",
              message: "Missing knowledge:sources:read scope to fetch remote source content.",
            },
          })
        }
        const registry =
          bridgeOptions?.knowledgeRegistryOverride ??
          (await (
            await import("~/apps/knowledge/source-registry")
          ).registerDefaultKnowledgeSources({
            orgId,
            userId,
            scopes: callerScopes ?? [],
          }))
        const adapter = registry.listEnabled(actor).find((a) => a.source === params.source)
        if (!adapter || typeof adapter.fetchRemoteContent !== "function") {
          return JSON.stringify({
            status: "unsupported",
            error: {
              code: "source_unavailable",
              message: `Source '${params.source}' does not support content retrieval.`,
            },
          })
        }
        const remote = await adapter.fetchRemoteContent(
          { sourceEntityId: params.sourceEntityId },
          actor,
          params.purpose,
        )
        const content: Array<{ text: string; untrusted: boolean; chunkIndex: number }> = []
        if (remote.text) {
          await taintTurnForExternalText()
          // Remote bodies are untrusted (prompt-injection mitigation): fenced as
          // external content and flagged untrusted.
          const { wrapExternalContent } = await import("~/lib/external-content")
          content.push({ text: wrapExternalContent(remote.text), untrusted: true, chunkIndex: 0 })
        }
        return JSON.stringify({
          status: remote.status,
          citation: {
            title: remote.title,
            url: remote.url,
            source: params.source,
            sourceEntityId: params.sourceEntityId,
            modifiedAt: remote.modifiedAt,
            status: remote.status,
          },
          content,
        })
      }
      throw new Error("invalid_params")
    },
    // find_by_title (U5.8): DB-backed exact-title lookup — no search index, so no
    // Meilisearch indexing-lag window. Read-authorization mirrors knowledge_get's local-id
    // branch (loadDocumentShareRole + assertCanReadDocumentRow), applied per-candidate-row
    // inside findDocByTitle itself (best-effort scan, oldest readable match wins).
    // Exposed cross-app (calls app's cross_app_calls declares `knowledge:find_by_title`) so
    // callRef→doc resolution never rides the index that discovery-lags under replay load.
    knowledge_find_by_title: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_find_by_title is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        title?: string
        includeArchived?: boolean
      }
      const { knowledgeActorFromContext, findDocByTitle } = await import("~/apps/knowledge/service")
      const { handleKnowledgeFindByTitle } = await import("~/apps/knowledge/agent-tools")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      const result = await handleKnowledgeFindByTitle(
        { title: params.title ?? "", includeArchived: params.includeArchived },
        {
          actor,
          orgId,
          findByTitle: (title, findActor, opts) =>
            findDocByTitle(txDb as never, orgId, title, findActor, opts),
        },
      )
      return JSON.stringify(result)
    },
    /** STAGE-TIME validator for knowledge_create. Runs the placement + access
     *  guard WITHOUT writing anything, so the knowledge app can refuse an
     *  org-scoped create that is missing its collection or its access
     *  classification BEFORE it parks a human approval. Returns `{}` when the
     *  create would be accepted, `{error:{code,message}}` otherwise. */
    knowledge_create_validate: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_create_validate is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as Record<string, unknown>
      const { knowledgeActorFromContext } = await import("~/apps/knowledge/service")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      const guard = await validateKnowledgeCreatePlacement({
        txDb,
        // The guard strips bridge-level keys off what it is given; validation
        // must not mutate the params the caller is about to stage.
        params: { ...params },
        actor,
        wantScope: params.documentScope,
        callerApp: bridgeOptions?.callerApp,
        appName,
      })
      return JSON.stringify("error" in guard ? { error: guard.error } : {})
    },
    knowledge_create: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_create is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as Record<string, unknown>
      const {
        knowledgeActorFromContext,
        createKnowledgeDocument,
        findOrgDocByTitle,
        findOrgRunningDocByTitlePrefix,
        findUniqueOrgRunningWatchDoc,
      } = await import("~/apps/knowledge/service")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      // RUNNING-DOC UPSERT GUARD (BL-275, competitor-price-and-spec-watch duplicate-doc footgun). A
      // recurring watch routine that maintains ONE running doc must UPDATE it each tick — but a flash-lite
      // tick under load sometimes calls knowledge_create for a doc whose EXACT title already exists,
      // spawning a DUPLICATE running doc (the rubric's "new doc per tick" failure: two "Competitor Price &
      // SKU Watch" docs created seconds apart). When an ORG-scoped create would collide with an existing
      // NON-ARCHIVED org doc of the EXACT same title that the caller can WRITE, REDIRECT to an UPDATE of
      // that existing doc (the new body/summary land on the running doc, revision bumps) instead of
      // creating a duplicate — the correct single-running-doc semantics. The agent can still create a
      // genuinely-distinct doc by using a distinct title. Scoped to the agent knowledge_create path only.
      const wantTitle = typeof params.title === "string" ? params.title.trim() : ""
      const wantScope = params.documentScope
      // ROUTINE-BOUND running doc FIRST — UNCONDITIONAL (BL-275, the bulletproof deterministic catch). Inside
      // a routine TICK the authored prompt carries a binding directive naming the EXACT running-doc id the
      // routine maintains ("MAINTAIN THIS EXISTING RUNNING DOC … id <UUID>"). A flash-lite tick under load
      // sometimes IGNORES it and invents an unrelated title (and even a PERSONAL scope) → a duplicate doc and
      // the deliverable never lands in the running doc (competitor-firmware-news-watch fail: a second empty
      // "…New Release Watch Doc" created while the running doc stayed unchanged). So the bound-doc redirect
      // runs REGARDLESS of the create's title OR documentScope — the binding explicitly names THE doc to
      // maintain, so ANY create in that tick is the tick trying (clumsily) to write the running doc. The
      // title-similarity fallbacks below stay scoped to an org create (they key on title, not the binding).
      const boundExisting = await findRoutineBoundRunningDoc(
        txDb as never,
        orgId,
        actor,
        bridgeRoutineId,
      )
      if (boundExisting?.id) {
        const { updateKnowledgeDocument } = await import("~/apps/knowledge/service")
        const updated = await updateKnowledgeDocument(
          txDb as never,
          {
            id: boundExisting.id,
            revision: boundExisting.revision,
            ...(params.body !== undefined ? { body: params.body } : {}),
            ...(params.summary !== undefined ? { summary: params.summary } : {}),
          } as never,
          actor,
          knowledgeWriteRequiredScopes("knowledge_create"),
        )
        const updatedId = (updated as { id?: string }).id
        await recordAgentKnowledgePointersForDocument({
          orgId,
          agentId: bridgeActingAgentId,
          documentId: updatedId,
        })
        return JSON.stringify({
          ...updated,
          redirectedToUpdate: true,
          note:
            `This routine maintains ONE running Knowledge doc ("${boundExisting.title}", id ${boundExisting.id}); ` +
            `your create (titled "${wantTitle || "(untitled)"}") was applied as an UPDATE to it rather than ` +
            `creating a duplicate. Call knowledge_update on this id next time.`,
          ...(updatedId
            ? {
                resourceUrl: `/knowledge/documents/${updatedId}`,
                mentionTag: knowledgeMentionTag(boundExisting.title, updatedId),
              }
            : {}),
        })
      }
      if (wantTitle && (wantScope === "organization" || wantScope === undefined)) {
        // Exact-title match next; then the unambiguous running-doc TOKEN-SUBSET fallback (BL-275,
        // dealer-price-watch-weekly): a flash-lite tick that types a SHORTENED/RE-ORDERED title for the
        // running doc still redirects to the existing running doc instead of spawning a duplicate. The
        // fallback only fires for a UNIQUE writable one-directional (wanted-tokens ⊆ existing) match above a
        // 3-token floor, so a genuinely distinct title is never captured.
        // ⛔ CONVERSATION-PHASE DUPLICATE-WATCH-DOC GUARD (BL-275, competitor-firmware-news-watch parallel
        // fail): the agent under load creates a SECOND watch/digest doc ("Competitor Release History") during
        // PLANNING — a non-routine create the bound-doc redirect can't catch — while the seeded running watch
        // doc is the one the tick maintains, so the knowledge block shows TWO watch docs (criterion-3 fail).
        // When the new title reads as a running watch/digest doc AND exactly ONE such writable org doc exists,
        // collapse the would-be duplicate onto it. Narrow: only fires watch-title↔unique-watch-doc, so a
        // distinct doc (notes, a KB article) is never merged. Tried LAST (after exact + prefix) so a precise
        // match still wins.
        const existing =
          (await findOrgDocByTitle(txDb as never, orgId, wantTitle, actor)) ??
          (await findOrgRunningDocByTitlePrefix(txDb as never, orgId, wantTitle, actor)) ??
          (await findUniqueOrgRunningWatchDoc(txDb as never, orgId, wantTitle, actor))
        if (existing?.id) {
          const { updateKnowledgeDocument } = await import("~/apps/knowledge/service")
          const updated = await updateKnowledgeDocument(
            txDb as never,
            {
              id: existing.id,
              revision: existing.revision,
              ...(params.body !== undefined ? { body: params.body } : {}),
              ...(params.summary !== undefined ? { summary: params.summary } : {}),
            } as never,
            actor,
            knowledgeWriteRequiredScopes("knowledge_create"),
          )
          const updatedId = (updated as { id?: string }).id
          await recordAgentKnowledgePointersForDocument({
            orgId,
            agentId: bridgeActingAgentId,
            documentId: updatedId,
          })
          return JSON.stringify({
            ...updated,
            redirectedToUpdate: true,
            note:
              `An existing running Knowledge document ("${existing.title}", id ${existing.id}) already ` +
              `covers this — your create (titled "${wantTitle}") was applied as an UPDATE to it rather ` +
              `than creating a duplicate. To maintain a single running doc, call knowledge_update on this ` +
              `id (or reuse the exact title "${existing.title}") next time.`,
            ...(updatedId
              ? {
                  resourceUrl: `/knowledge/documents/${updatedId}`,
                  mentionTag: knowledgeMentionTag(existing.title, updatedId),
                }
              : {}),
          })
        }
      }
      // PLACEMENT + ACCESS GUARD - see validateKnowledgeCreatePlacement. The
      // SAME checks run at STAGING via knowledge_create_validate, so a gated org
      // create missing its collection / access classification is refused before
      // an approval is parked; this call is the execution-time backstop (and the
      // producer of the placement actually applied below).
      const guard = await validateKnowledgeCreatePlacement({
        txDb,
        params,
        actor,
        wantScope,
        callerApp: bridgeOptions?.callerApp,
        appName,
      })
      if ("error" in guard) return JSON.stringify({ error: guard.error })
      const placement = guard.placement
      // Re-derived here: the guard's own copy now lives inside
      // validateKnowledgeCreatePlacement, but the connector-ingestion branch
      // below still has to know whether this create arrived over the K4
      // cross_app_calls contract (it lands in the review queue instead of
      // passing through the agent approval gate).
      const isCrossAppConnectorCreate =
        typeof bridgeOptions?.callerApp === "string" &&
        bridgeOptions.callerApp.length > 0 &&
        bridgeOptions.callerApp !== appName
      // PERIOD-SNAPSHOT DISCLAIMER INJECTION (l710 server-side discrimination — claire-routine-monthend-
      // close-pack). Inside a period-snapshot routine tick, the persisted snapshot doc is the audit-trail
      // deliverable and MUST be framed as a bounded, non-authoritative listing; the flash-lite tick varies
      // on whether it writes that caveat into the body, so PREPEND the verbatim disclaimer server-side when
      // it omitted it — the saved deliverable is always honest regardless of tick variance. No-op outside a
      // period-snapshot tick or when the body already carries a caveat.
      const disclaimedBody = await maybePrependPeriodSnapshotDisclaimer(
        txDb as never,
        orgId,
        bridgeRoutineId,
        params.body as string | null | undefined,
      )
      if (disclaimedBody !== (params.body as unknown)) params.body = disclaimedBody
      const created = await createKnowledgeDocument(
        txDb as never,
        params as never,
        actor,
        knowledgeWriteRequiredScopes("knowledge_create"),
      )
      // File into the required collection + apply the explicit role shares —
      // in the SAME transaction as the create, so a placement failure rolls
      // the document back rather than leaving it free-floating.
      if (placement) {
        const createdRow = created as {
          id: string
          orgAccess: "none" | "viewer" | "editor"
          editScope: string | null
        }
        const { addCollectionMembership } = await import("~/apps/knowledge/collections")
        await addCollectionMembership(
          txDb as never,
          {
            collectionId: placement.collectionId,
            targetType: "document",
            targetId: createdRow.id,
          },
          actor,
        )
        if (placement.roleShares.length > 0) {
          const { setDocumentSharing } = await import("~/apps/knowledge/service")
          await setDocumentSharing(
            txDb as never,
            createdRow.id,
            {
              orgAccess: createdRow.orgAccess,
              editScope: createdRow.editScope ?? null,
              shares: [],
              roleShares: placement.roleShares,
            },
            actor,
          )
        }
      }
      // CONNECTOR INGESTION LANDS IN THE REVIEW QUEUE. A cross-app connector
      // create skips knowledge's agent approval gate (handlers.ts: a webhook
      // ingestion is a machine write path, not an agent decision), so the human
      // check happens after the write instead of before it: the document is
      // filed unverified for review exactly as a bulk folder import is
      // (review_status 'needs_review'), and knowledge:verify promotes it. The
      // review-queue read path (apps/knowledge/attention.ts) is unchanged.
      if (isCrossAppConnectorCreate) {
        const connectorCreatedId = (created as { id?: string }).id
        if (typeof connectorCreatedId === "string" && connectorCreatedId.length > 0) {
          await txDb.execute(drizzleSql`
            UPDATE ${drizzleSql.raw(schemaRef("app_knowledge"))}.documents
            SET review_status = 'needs_review', review_reason = 'agent_requested', updated_at = now()
            WHERE id = ${connectorCreatedId}::uuid AND org_id = ${orgId}::uuid
              AND review_status <> 'verified'
          `)
        }
      }
      // Surface a ready-to-use navigable reference so the agent's confirmation
      // can LINK to the new doc (the rubric/"return a link to the created doc"
      // contract) instead of a bare success sentence. `resourceUrl` is the
      // canonical Knowledge document tab route (apps/web knowledge-tabs
      // urlPattern: /knowledge/documents/:entityId); the agent echoes it as a
      // markdown link in its reply.
      const createdId = (created as { id?: string }).id
      const createdTitle = (created as { title?: string }).title ?? wantTitle
      // The agent page's Knowledge tab lists the collections THIS agent works
      // in; a create files the new document into one, so the pointer is
      // recorded here rather than left to the migration seed alone.
      await recordAgentKnowledgePointers({
        orgId,
        agentId: bridgeActingAgentId,
        collectionIds: [
          placement?.collectionId,
          ...(Array.isArray(params.collectionIds) ? (params.collectionIds as string[]) : []),
        ],
      })
      return JSON.stringify({
        ...created,
        ...(placement
          ? {
              collection: { id: placement.collectionId, name: placement.collectionName },
              ...(placement.roleShares.length > 0 ? { roleShares: placement.roleShares } : {}),
            }
          : {}),
        ...(createdId
          ? {
              resourceUrl: `/knowledge/documents/${createdId}`,
              // Ready-to-paste ENTITY TAG — dropped verbatim into the agent's
              // reply it renders as a clickable mention pill that opens the
              // document (same wire format the compose bar emits).
              mentionTag: knowledgeMentionTag(createdTitle, createdId),
            }
          : {}),
      })
    },
    /** STAGE-TIME validator for knowledge_update. knowledge:update parks a human
     *  approval for an ORG-scoped document, so its guards (document exists, not
     *  a read-only synced doc, caller may write it, revision still current) ran
     *  only AFTER the approver clicked approve: the human was handed a card and
     *  got REVISION_CONFLICT or "Synced documents are read-only" for something
     *  only the agent could fix. Read-only; returns `{}` to allow, or
     *  `{error:{code,message}}` to refuse before an approval exists. The
     *  handler keeps its own guards: revision is also a genuine race. */
    knowledge_update_validate: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_update_validate is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as Record<string, unknown> & { id?: string }
      if (!params.id || typeof params.id !== "string") {
        return JSON.stringify({
          error: { code: "invalid_params", message: "knowledge update needs the document id." },
        })
      }
      const {
        knowledgeActorFromContext,
        loadKnowledgeDocument,
        loadDocumentShareRole,
        assertCanWriteDocumentRow,
      } = await import("~/apps/knowledge/service")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      try {
        const row = await loadKnowledgeDocument(txDb as never, params.id, actor)
        if (!row) {
          return JSON.stringify({
            error: { code: "not_found", message: `No Knowledge document with id ${params.id}.` },
          })
        }
        if (row.syncedSourceId) {
          return JSON.stringify({
            error: {
              code: "synced_read_only",
              message:
                "This document is synced from an external source and is read-only here. " +
                "Edit the source file in the upstream system instead.",
            },
          })
        }
        const shareRole = await loadDocumentShareRole(txDb as never, row.id, actor)
        assertCanWriteDocumentRow(row, actor, shareRole)
        if (typeof params.revision === "number" && row.revision !== params.revision) {
          return JSON.stringify({
            error: {
              code: "revision_conflict",
              message:
                `The document has moved on (you passed revision ${params.revision}, it is now ` +
                `${row.revision}). Re-read it and rebuild your edit on the current text.`,
            },
          })
        }
      } catch (err) {
        const e = err as { code?: string; message?: string }
        return JSON.stringify({
          error: {
            code: typeof e.code === "string" ? e.code.toLowerCase() : "forbidden",
            message: e.message ?? "The update cannot be applied.",
          },
        })
      }
      return JSON.stringify({})
    },
    knowledge_update: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_update is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as Record<string, unknown> & { id?: string }
      if (!params.id || typeof params.id !== "string") throw new Error("invalid_params")
      const { knowledgeActorFromContext, updateKnowledgeDocument } = await import(
        "~/apps/knowledge/service"
      )
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      const updatedDoc = await updateKnowledgeDocument(
        txDb as never,
        params as never,
        actor,
        knowledgeWriteRequiredScopes("knowledge_update"),
      )
      const updatedDocId = (updatedDoc as { id?: string }).id
      await recordAgentKnowledgePointersForDocument({
        orgId,
        agentId: bridgeActingAgentId,
        documentId: updatedDocId,
      })
      return JSON.stringify({
        ...updatedDoc,
        ...(updatedDocId
          ? {
              resourceUrl: `/knowledge/documents/${updatedDocId}`,
              mentionTag: knowledgeMentionTag(
                (updatedDoc as { title?: string }).title,
                updatedDocId,
              ),
            }
          : {}),
      })
    },
    knowledge_archive: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_archive is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as { id?: string }
      if (!params.id || typeof params.id !== "string") throw new Error("invalid_params")
      const { knowledgeActorFromContext, archiveKnowledgeDocument } = await import(
        "~/apps/knowledge/service"
      )
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      return JSON.stringify(await archiveKnowledgeDocument(txDb as never, params.id, actor))
    },
    knowledge_restore: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_restore is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as { id?: string }
      if (!params.id || typeof params.id !== "string") throw new Error("invalid_params")
      const { knowledgeActorFromContext, restoreKnowledgeDocument } = await import(
        "~/apps/knowledge/service"
      )
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      return JSON.stringify(await restoreKnowledgeDocument(txDb as never, params.id, actor))
    },
  }
  // An agent's write to a Knowledge document during a turn that read outside text does not wait
  // for a person: it lands in the review queue unverified (review_status 'needs_review', reason
  // 'untrusted_content'), and knowledge:verify promotes it. A human-approved write and a turn
  // that read nothing outside are filed as usual; so is any write when the org switched the
  // outside-content protection off (scopes/taint.ts).
  const fileForReviewIfUntrusted = async (resultJson: string): Promise<void> => {
    const threadId = bridgeOptions?.threadId
    const agentWrite =
      readerIsModel || bridgeOptions?.origin === "in-app-agent" || bridgeOptions?.origin === "mcp"
    if (!agentWrite || approvalContext || !threadId) return
    let docId: unknown
    try {
      const parsed = JSON.parse(resultJson) as { id?: unknown; error?: unknown }
      if (parsed.error) return
      docId = parsed.id
    } catch {
      return
    }
    if (typeof docId !== "string" || docId.length === 0) return
    const { untrustedTurnNeedsApproval } = await import("~/modules/agent/scopes/taint")
    if (!(await untrustedTurnNeedsApproval(threadId, orgId))) return
    await txDb.execute(drizzleSql`
      UPDATE ${drizzleSql.raw(schemaRef("app_knowledge"))}.documents
      SET review_status = 'needs_review', review_reason = 'untrusted_content', updated_at = now()
      WHERE id = ${docId}::uuid AND org_id = ${orgId}::uuid
    `)
  }
  for (const name of ["knowledge_create", "knowledge_update"] as const) {
    const write = methods[name] as (paramsJson: string) => Promise<string>
    methods[name] = async (paramsJson: string): Promise<string> => {
      const result = await write(paramsJson)
      await fileForReviewIfUntrusted(result)
      return result
    }
  }
  return methods
}
