// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { recordAgentKnowledgePointers } from "~/modules/agent/knowledge/knowledge-pointers"
import { readOnlyRunBlockedError } from "~/modules/agent/runtime/read-only-run"
import { UNDECLARED_WRITE_TARGET } from "~/modules/agent/scopes/scope-taint"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { bridgeKnowledgeActorInput } from "~/modules/apps/sandbox/bridge/shared"

/** Knowledge curation: collections, verification, folder sources, source links and attention items. */
/**
 * `add_folder_source` on an app that declares a knowledge source kind: the
 * app's own handler syncs it (app-sources.ts). With a `ref` (a folder of the
 * app's provider) the source is that folder (config `{ ref }`); the same app,
 * kind, owner and ref reuse their source (reactivated when archived), so its
 * documents keep their identities. The first pass runs on the sync schedule,
 * not inside this call.
 */
async function addAppSource(input: {
  txDb: unknown
  orgId: string
  actor: import("~/apps/knowledge/service").KnowledgeActor
  source: string
  kinds: Array<{ kind: string; title: string }>
  scope: "personal" | "organization"
  params: {
    kind?: string
    ref?: string
    displayName?: string
    defaultSensitivity?: string
    oneShot?: boolean
  }
}): Promise<Record<string, unknown>> {
  const { txDb, orgId, actor, source, kinds, scope, params: p } = input
  const folderRef = p.ref ?? null
  if (p.oneShot && !folderRef) {
    throw new Error(
      `invalid_params: ${source} syncs through its own source on a schedule; oneShot is for folder sources`,
    )
  }
  // A folder (`ref`) goes to the app's `folder` kind unless a kind is named.
  const chosen = p.kind
    ? kinds.find((k) => k.kind === p.kind)
    : kinds.length === 1
      ? kinds[0]
      : folderRef
        ? (kinds.find((k) => k.kind === "folder") ?? null)
        : null
  if (!chosen) {
    throw new Error(`invalid_params: kind required, one of ${kinds.map((k) => k.kind).join(", ")}`)
  }
  const { knowledgeRel } = await import("~/apps/knowledge/schema-refs")
  const owner = scope === "organization" ? null : actor.userId
  const config: Record<string, unknown> = folderRef ? { ref: folderRef } : {}
  const [existing] = extractRows<{ id: string; last_sync_status: string | null }>(
    await (txDb as { execute: (q: unknown) => Promise<unknown> }).execute(drizzleSql`
      SELECT id, last_sync_status FROM ${knowledgeRel("synced_sources")}
      WHERE org_id = ${orgId}::uuid AND app_name = ${source} AND source_kind = ${chosen.kind}
        AND COALESCE(source_config, '{}'::jsonb) = ${JSON.stringify(config)}::jsonb
        AND owner_user_id IS NOT DISTINCT FROM ${owner}::uuid
        AND (${folderRef}::text IS NULL OR folder_ref = ${folderRef})
      ORDER BY archived_at IS NULL DESC, created_at DESC
      LIMIT 1
    `),
  )
  if (existing) {
    const { reactivateSyncedSource } = await import("~/apps/knowledge/synced-sources")
    await reactivateSyncedSource(orgId, existing.id)
    return {
      sourceId: existing.id,
      syncedSourceId: existing.id,
      source,
      kind: chosen.kind,
      lastSyncStatus: existing.last_sync_status ?? "idle",
      oneShot: false,
      documentsCreated: 0,
    }
  }
  const { createSyncedSource } = await import("~/apps/knowledge/synced-sources")
  const created = await createSyncedSource(
    txDb as never,
    {
      appName: source,
      sourceKind: chosen.kind,
      sourceConfig: config,
      folderRef: folderRef ?? `app-source:${chosen.kind}`,
      displayName: p.displayName ?? (folderRef ? `${chosen.title} ${folderRef}` : chosen.title),
      scope,
      syncIntervalSeconds: 3600,
      defaultSensitivity:
        scope === "organization" ? ((p.defaultSensitivity as never) ?? "internal") : null,
    },
    actor,
  )
  return {
    sourceId: created.id,
    syncedSourceId: created.id,
    source,
    kind: chosen.kind,
    lastSyncStatus: created.lastSyncStatus,
    oneShot: false,
    documentsCreated: 0,
    ...(p.oneShot
      ? {
          note: "This source syncs through the app on a schedule, from its first pass on: its documents arrive within minutes. Archive the source to stop it.",
        }
      : {}),
  }
}

export function createKnowledgeCurationMethods(ctx: BridgeContext): Record<string, any> {
  const { appName, bridgeActingAgentId, bridgeOptions, callerScopes, orgId, txDb, userId } = ctx
  // A short transaction of its own for one DB step. knowledge_verify and
  // knowledge_source_link_create are tx-less on a session bridge (rpc-bridge.ts):
  // they wake the source's app to resolve the item, never inside a transaction.
  const dbStep = <T>(fn: (tx: RlsClient) => Promise<T>): Promise<T> =>
    bridgeOptions?.withShortTx ? bridgeOptions.withShortTx(fn) : fn(txDb)
  return {
    knowledge_collection_create: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_collection_create is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as Record<string, unknown>
      const { knowledgeActorFromContext } = await import("~/apps/knowledge/service")
      const { createKnowledgeCollection } = await import("~/apps/knowledge/collections")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      return JSON.stringify(await createKnowledgeCollection(txDb as never, params as never, actor))
    },
    knowledge_collection_update: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_collection_update is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as Record<string, unknown> & { id?: string }
      if (!params.id || typeof params.id !== "string") throw new Error("invalid_params")
      const { knowledgeActorFromContext } = await import("~/apps/knowledge/service")
      const { updateKnowledgeCollection } = await import("~/apps/knowledge/collections")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      const { id, ...patch } = params
      return JSON.stringify(
        await updateKnowledgeCollection(txDb as never, id as string, patch as never, actor),
      )
    },
    knowledge_collection_delete: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_collection_delete is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as { id?: string }
      if (!params.id) throw new Error("invalid_params")
      const { knowledgeActorFromContext } = await import("~/apps/knowledge/service")
      const { archiveKnowledgeCollection } = await import("~/apps/knowledge/collections")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      return JSON.stringify(await archiveKnowledgeCollection(txDb as never, params.id, actor))
    },
    knowledge_add_to_collection: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_add_to_collection is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        collectionId?: string
        documentId?: string
      }
      if (!params.collectionId || !params.documentId) throw new Error("invalid_params")
      const { knowledgeActorFromContext } = await import("~/apps/knowledge/service")
      const { addCollectionMembership } = await import("~/apps/knowledge/collections")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      const membership = await addCollectionMembership(
        txDb as never,
        {
          collectionId: params.collectionId,
          targetType: "document",
          targetId: params.documentId,
        },
        actor,
      )
      // Filing a document into a collection points this agent at it, which is
      // what the agent page's Knowledge tab lists.
      await recordAgentKnowledgePointers({
        orgId,
        agentId: bridgeActingAgentId,
        collectionIds: [params.collectionId],
      })
      return JSON.stringify(membership)
    },
    knowledge_remove_from_collection: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_remove_from_collection is only available to the knowledge app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        collectionId?: string
        documentId?: string
      }
      if (!params.collectionId || !params.documentId) throw new Error("invalid_params")
      const { knowledgeActorFromContext } = await import("~/apps/knowledge/service")
      const { removeCollectionMembership } = await import("~/apps/knowledge/collections")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      await removeCollectionMembership(
        txDb as never,
        {
          collectionId: params.collectionId,
          targetType: "document",
          targetId: params.documentId,
        },
        actor,
      )
      return JSON.stringify({ ok: true })
    },
    knowledge_attentionItems: async (_paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_attentionItems is only available to the knowledge app")
      }
      const { computeAttentionItems } = await import("~/apps/knowledge/attention")
      // Agents consume this as an itemized review queue — skip the Home-feed
      // flood aggregation so every document stays individually addressable.
      return JSON.stringify(
        await computeAttentionItems(txDb as never, orgId, userId, new Date(), {
          aggregate: false,
        }),
      )
    },
    knowledge_verify: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_verify is only available to the knowledge app")
      }
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      if (!checkScope("knowledge:documents:update", callerScopes ?? [])) {
        throw new Error("forbidden: knowledge:documents:update")
      }
      const p = JSON.parse(paramsJson || "{}") as {
        documentId?: string
        sourceLinkId?: string
      }
      const { knowledgeActorFromContext } = await import("~/apps/knowledge/service")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      // Branch 1 — source link: verifySourceLink is async, DB-backed, and
      // probes the remote via the registry. Tests inject a stub registry;
      // production builds a request-scoped real-Drive registry.
      if (p.sourceLinkId) {
        const { verifySourceLink } = await import("~/apps/knowledge/source-links")
        const registry =
          bridgeOptions?.knowledgeRegistryOverride ??
          (await (
            await import("~/apps/knowledge/source-registry")
          ).registerDefaultKnowledgeSources({
            orgId,
            userId,
            scopes: callerScopes ?? [],
          }))
        return JSON.stringify(await verifySourceLink(dbStep, p.sourceLinkId, registry, actor))
      }
      // Branch 2 — document: applyReviewTransition is PURE SYNC (no persistence),
      // so load → transform → UPDATE.
      if (!p.documentId) throw new Error("invalid_params: documentId or sourceLinkId required")
      const documentId = p.documentId
      const { applyReviewTransition } = await import("~/apps/knowledge/review")
      return dbStep(async (txDb) => {
        const row = extractRows<{
          id: string
          review_status: string | null
          review_reason: string | null
          verified_by: string | null
          verified_at: string | null
        }>(
          await txDb.execute(drizzleSql`
          SELECT id, review_status, review_reason, verified_by, verified_at
          FROM ${drizzleSql.raw(schemaRef("app_knowledge"))}.documents
          WHERE id = ${documentId}::uuid AND org_id = ${orgId}::uuid AND archived_at IS NULL
        `),
        )[0]
        if (!row) throw new Error("document not found")
        const next = applyReviewTransition(
          {
            reviewStatus: row.review_status,
            reviewReason: row.review_reason,
            verifiedBy: row.verified_by,
            verifiedAt: row.verified_at,
          },
          { kind: "verify", actorId: userId },
        )
        await txDb.execute(drizzleSql`
        UPDATE ${drizzleSql.raw(schemaRef("app_knowledge"))}.documents
        SET review_status = ${next.reviewStatus},
            review_reason = NULL,
            verified_at = ${next.verifiedAt as string},
            verified_by = ${(next.verifiedBy ?? userId) as string}::uuid,
            updated_at = now()
        WHERE id = ${documentId}::uuid AND org_id = ${orgId}::uuid
      `)
        await txDb.queueEvent({
          app: "knowledge",
          entity: "document",
          action: "update",
          entityId: documentId,
          data: { reviewStatus: next.reviewStatus },
          actorId: userId,
          actorType: "user",
          agentId: bridgeActingAgentId,
          orgId,
        })
        return JSON.stringify({
          documentId,
          reviewStatus: next.reviewStatus,
          verifiedAt: next.verifiedAt,
        })
      })
    },
    // knowledge_addFolderSource — GENERIC folder-source harvest, unified across
    // every folder-capable connector (google-drive). `source` selects
    // the connector (default "google-drive" for back-compat with callers that
    // never passed it); `ref` is that connector's folder reference — for
    // google-drive the legacy `folderId` param is still accepted as an alias for
    // `ref` (back-compat: existing callers/tests keep working byte-for-byte).
    // Resolves the adapter from the SAME request-scoped registry the HTTP route
    // uses (`registerDefaultKnowledgeSources`), so any registered, enabled,
    // folder-capable source works here with zero per-source code. A `source`
    // that is an installed app declaring a knowledge source kind (manifest
    // `knowledgeSources`, app-sources.ts, e.g. gitlab) becomes an app source of
    // that kind instead: its `ref`, when given, is the source's config `{ ref }`.
    // The settings page's synced sources list (tools synced_sources.list /
    // archive / run_now): the same reads, checks and job as GET / DELETE
    // /api/knowledge/synced-sources and POST .../:id/run-now. Refusals come
    // back as `{ error: { code } }` (forbidden, not_found), run_now reporting a
    // source the caller may not force as not_found, as the route does.
    knowledge_syncedSources: async (op: string, paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_syncedSources is only available to the knowledge app")
      }
      // Only `list` reads: archive and run now write, and a read-only run refuses them.
      if (ctx.bridgeReadOnlyRun && op !== "list") {
        throw readOnlyRunBlockedError(UNDECLARED_WRITE_TARGET, `ctx.knowledge_syncedSources(${op})`)
      }
      const { KnowledgeError, knowledgeActorFromContext } = await import("~/apps/knowledge/service")
      const sources = await import("~/apps/knowledge/synced-sources")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      const p = JSON.parse(paramsJson || "{}") as { id?: unknown }
      const id = typeof p.id === "string" ? p.id : ""
      const refusal = (code: string, message: string) =>
        JSON.stringify({ error: { code, message, retryable: false } })
      try {
        if (op === "list") {
          const rows = await sources.listSyncedSources(txDb as never, actor)
          return JSON.stringify({
            rows: rows.map((r) => ({ ...r, scope: r.ownerUserId ? "personal" : "organization" })),
          })
        }
        if (!id) return refusal("invalid_params", "id is required")
        if (op === "archive") {
          await sources.archiveSyncedSource(txDb as never, id, actor)
          return JSON.stringify({ id, archived: true })
        }
        if (op === "run_now") {
          const existing = await sources.loadSyncedSource(txDb as never, id, actor)
          if (!existing) return refusal("not_found", "Synced source not found")
          try {
            sources.assertCanForceSyncedSource(existing, actor)
          } catch {
            return refusal("not_found", "Synced source not found")
          }
          const { enqueueAppJob } = await import("~/infra/jobs/jobs")
          await enqueueAppJob(
            "knowledge",
            "sync-source",
            { sourceId: id, trigger: "force-on-open", enqueuedBy: actor.userId },
            { jobId: `sync:${id}` },
          )
          return JSON.stringify({ id, enqueued: true })
        }
        return refusal("invalid_params", `unknown synced sources operation ${op}`)
      } catch (err) {
        if (err instanceof KnowledgeError) {
          const code =
            err.code === "FORBIDDEN" ? "forbidden" : err.code === "NOT_FOUND" ? "not_found" : null
          if (code) return refusal(code, err.message)
        }
        throw err
      }
    },
    knowledge_addFolderSource: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_addFolderSource is only available to the knowledge app")
      }
      const p = JSON.parse(paramsJson || "{}") as {
        source?: string
        ref?: string
        folderId?: string
        displayName?: string
        scope?: "personal" | "organization"
        defaultSensitivity?: string
        oneShot?: boolean
        kind?: string
      }
      const source = p.source ?? "google-drive"
      // Back-compat alias: `folderId` is the pre-generalization param name,
      // still honored for google-drive (and as a plain fallback for any
      // caller that passes it without `source`). `database` is the only
      // source where `ref` may be omitted entirely (defaulted below).
      const ref = p.ref ?? p.folderId
      const { knowledgeActorFromContext } = await import("~/apps/knowledge/service")
      const { createSyncedSource, archiveSyncedSource, MIN_INTERVAL_SECONDS } = await import(
        "~/apps/knowledge/synced-sources"
      )
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      // Authorization gate, mirroring createSyncedSource — applied here so the
      // existing-source REUSE path (which bypasses createSyncedSource) is still
      // guarded: org scope needs sources:manage, personal scope needs reader.
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      const reqScope = (p.scope ?? "personal") === "organization"
      if (reqScope) {
        if (
          !checkScope("knowledge:sources:manage", callerScopes ?? []) &&
          !checkScope("knowledge:documents:admin", callerScopes ?? [])
        ) {
          throw new Error("forbidden: knowledge:sources:manage")
        }
      } else if (
        !checkScope("knowledge:documents:read", callerScopes ?? []) &&
        !checkScope("knowledge:documents:admin", callerScopes ?? [])
      ) {
        throw new Error("forbidden: knowledge:documents:read")
      }
      // Request-scoped registry — never the process-wide cached one. Tests
      // inject a stub folder adapter via knowledgeRegistryOverride.
      const registry =
        bridgeOptions?.knowledgeRegistryOverride ??
        (await (
          await import("~/apps/knowledge/source-registry")
        ).registerDefaultKnowledgeSources({
          orgId,
          userId,
          scopes: callerScopes ?? [],
        }))
      const { isFolderSourceCapable } = await import("~/apps/knowledge/source-protocol")
      const adapter = registry
        .listEnabled(actor)
        .find((a) => a.source === source && isFolderSourceCapable(a))
      const scope = p.scope ?? "personal"
      if (!adapter) {
        const { listAppSourceKinds } = await import("~/apps/knowledge/app-sources")
        const kinds = listAppSourceKinds(actor).filter((k) => k.appName === source)
        if (kinds.length === 0) {
          throw new Error(`connect the ${source} app first: source is not connected/enabled`)
        }
        return JSON.stringify(
          await addAppSource({
            txDb,
            orgId,
            actor,
            source,
            kinds,
            scope,
            params: { ...p, ...(ref ? { ref } : {}) },
          }),
        )
      }
      if (!ref) {
        throw new Error(
          "invalid_params: ref required (folderId accepted as an alias for google-drive)",
        )
      }
      const resolvedRef = ref
      // Re-ingesting the SAME folder reuses (and reactivates) the existing
      // source so the reconciler's in-source document dedupe stays effective —
      // a fresh source id would re-materialize every file as a duplicate.
      const { findSyncedSourceByFolder, reactivateSyncedSource } = await import(
        "~/apps/knowledge/synced-sources"
      )
      const existing = await findSyncedSourceByFolder(txDb as never, orgId, source, resolvedRef)
      let src: Awaited<ReturnType<typeof createSyncedSource>>
      if (existing) {
        await reactivateSyncedSource(orgId, existing.id)
        src = { ...existing, lastSyncStatus: "idle" as const }
      } else {
        src = await createSyncedSource(
          txDb as never,
          {
            appName: source,
            folderRef: resolvedRef,
            displayName: p.displayName ?? `${source} folder ${resolvedRef}`,
            scope,
            syncIntervalSeconds: p.oneShot ? MIN_INTERVAL_SECONDS : 3600,
            defaultSensitivity:
              scope === "organization" ? (p.defaultSensitivity ?? "internal") : null,
          },
          actor,
          { adapter },
        )
      }
      if (p.oneShot) {
        const { reconcileSyncedSource } = await import("~/apps/knowledge/sync-reconciler")
        const result = await reconcileSyncedSource(src, adapter)
        // Success criterion 11: every freshly-imported doc lands in the review
        // queue so a human verifies bulk-ingested content before it's trusted.
        // reconcileSyncedSource commits its document writes in its OWN
        // privileged tx, so the request-RLS `txDb` cannot see them yet — flag
        // them in a privileged tx of our own.
        const { withPrivilegedDb } = await import("~/db/privileged")
        await withPrivilegedDb(orgId, "knowledge-folder-mark-review", async (ptx) => {
          await ptx.execute(drizzleSql`
            UPDATE ${drizzleSql.raw(schemaRef("app_knowledge"))}.documents
            SET review_status = 'needs_review', review_reason = 'agent_requested', updated_at = now()
            WHERE synced_source_id = ${src.id}::uuid AND org_id = ${orgId}::uuid
              AND archived_at IS NULL AND review_status <> 'verified'
          `)
        })
        await archiveSyncedSource(txDb as never, src.id, actor)
        return JSON.stringify({
          sourceId: src.id,
          syncedSourceId: src.id,
          source,
          oneShot: true,
          archivedAfterImport: true,
          documentsCreated: result.documentsUpserted,
        })
      }
      return JSON.stringify({
        sourceId: src.id,
        syncedSourceId: src.id,
        source,
        lastSyncStatus: src.lastSyncStatus,
        oneShot: false,
        documentsCreated: 0,
      })
    },
    // knowledge_source_link_create — register a LIVING source_link that points at
    // a remote document (e.g. a Google Drive file) WITHOUT copying its content.
    // This is the "track / reference / register the live doc" path the knowledge-
    // create skill teaches (distinct from create, which freezes a local document
    // copy). Wired to the existing source-links.ts `linkRemoteDocument` backend +
    // the knowledge:links:create scope. `linkRemoteDocument` probes the remote via
    // the request-scoped registry (real Drive in production; a stub in tests) so a
    // link can only be registered for a doc that is actually visible — never a
    // fabricated pointer. It stores a POINTER (source + externalId + url), never
    // the body.
    knowledge_source_link_create: async (paramsJson: string): Promise<string> => {
      if (appName !== "knowledge") {
        throw new Error("knowledge_source_link_create is only available to the knowledge app")
      }
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      if (!checkScope("knowledge:links:create", callerScopes ?? [])) {
        throw new Error("forbidden: knowledge:links:create")
      }
      const p = JSON.parse(paramsJson || "{}") as {
        source?: string
        externalId?: string
        title?: string
        url?: string
        summary?: string
        collectionId?: string
      }
      if (!p.source || typeof p.source !== "string")
        throw new Error("invalid_params: source required (the connector id, e.g. 'google-drive')")
      if (!p.externalId || typeof p.externalId !== "string")
        throw new Error("invalid_params: externalId required (the remote file id)")
      if (!p.title || typeof p.title !== "string") throw new Error("invalid_params: title required")
      const { knowledgeActorFromContext } = await import("~/apps/knowledge/service")
      const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
      // Request-scoped registry — never the process-wide cached one. Tests inject
      // a stub Drive adapter via knowledgeRegistryOverride; production builds a
      // request-scoped real-Drive registry (same pattern as knowledge_verify's
      // source-link branch + knowledge_addFolderSource).
      const registry =
        bridgeOptions?.knowledgeRegistryOverride ??
        (await (
          await import("~/apps/knowledge/source-registry")
        ).registerDefaultKnowledgeSources({
          orgId,
          userId,
          scopes: callerScopes ?? [],
        }))
      const { linkRemoteDocument } = await import("~/apps/knowledge/source-links")
      const created = await linkRemoteDocument(
        dbStep,
        {
          source: p.source,
          externalId: p.externalId,
          title: p.title,
          url: p.url,
          summary: p.summary,
          collectionId: p.collectionId,
        },
        registry,
        actor,
      )
      // Surface a navigable reference so the agent's confirmation LINKS to the
      // registered source_link (the apps/web knowledge source-link tab route),
      // mirroring knowledge_create's resourceUrl contract.
      return JSON.stringify({
        ...created,
        kind: "source_link",
        source: p.source,
        externalId: p.externalId,
        resourceUrl: `/knowledge/source-links/${created.id}`,
      })
    },
  }
}
