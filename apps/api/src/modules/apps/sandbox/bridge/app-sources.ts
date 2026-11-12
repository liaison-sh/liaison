// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `knowledge_appSource(paramsJson)`: an app's own knowledge sources (the kinds
 * its manifest declares, `knowledgeSources`), for the app's own code. Ops:
 *
 *  - `get` `{ kind, ref, scope, account? }`: one source, or null;
 *  - `ensure` `{ kind, ref, config, scope, account?, displayName, syncIntervalSeconds? }`:
 *    the source, created (with the actor's Knowledge rights, createSyncedSource)
 *    or reactivated when archived, recording the account it syncs through;
 *  - `list`: the app's active sources the run may see (the organization's and
 *    the acting person's own);
 *  - `sync` `{ id }`: sync one of them now;
 *  - `purgeAccount` `{ connectionId }`: delete what the app's sources synced
 *    through a DISCONNECTED account of the app (account-sources-purge.ts reads
 *    owner, account and state from the kernel row).
 *
 * Every op is pinned to the calling app: another app's sources are never seen.
 * `get` and `list` are `knowledge_appSource`; the writes (`ensure`, `sync`,
 * `purgeAccount`) are `knowledge_appSourceWrite`, refused in a read-only run.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { typedError } from "~/modules/apps/sandbox/bridge/secret-free"
import { bridgeKnowledgeActorInput } from "~/modules/apps/sandbox/bridge/shared"

interface SourceRow {
  id: string
  source_kind: string | null
  folder_ref: string
  source_config: unknown
  owner_user_id: string | null
  source_account: string | null
  last_sync_status: string
  last_sync_at: Date | string | null
  last_error: string | null
  documents: number | string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REF_RE = /^[A-Za-z0-9:_-]{1,256}$/

function view(r: SourceRow) {
  const config =
    typeof r.source_config === "string" ? (JSON.parse(r.source_config) as unknown) : r.source_config
  return {
    id: r.id,
    kind: r.source_kind ?? "",
    ref: r.folder_ref,
    config: config && typeof config === "object" && !Array.isArray(config) ? config : {},
    ownerUserId: r.owner_user_id,
    sourceAccount: r.source_account,
    lastSyncStatus: r.last_sync_status,
    lastSyncAt:
      r.last_sync_at instanceof Date ? r.last_sync_at.toISOString() : (r.last_sync_at ?? null),
    lastError: r.last_error,
    documents: Number(r.documents),
  }
}

export function createAppSourceMethods(ctx: BridgeContext): Record<string, any> {
  const { appName, orgId, userId, actorType } = ctx
  const person = actorType === "user" && UUID_RE.test(userId) ? userId : null
  const bad = (message: string) =>
    typedError(400, "invalid_params", `knowledge_appSource: ${message}`)

  async function rows(where: ReturnType<typeof drizzleSql>): Promise<SourceRow[]> {
    const [{ withPrivilegedDb }, { knowledgeRel }] = await Promise.all([
      import("~/db/privileged"),
      import("~/apps/knowledge/schema-refs"),
    ])
    return withPrivilegedDb(orgId, `app-sources:${appName}`, async (tx) =>
      extractRows<SourceRow>(
        await tx.execute(drizzleSql`
          SELECT s.id::text AS id, s.source_kind, s.folder_ref, s.source_config,
                 s.owner_user_id::text AS owner_user_id, s.source_account, s.last_sync_status,
                 s.last_sync_at, s.last_error,
                 (SELECT count(*) FROM ${knowledgeRel("documents")} d
                   WHERE d.synced_source_id = s.id AND d.archived_at IS NULL) AS documents
          FROM ${knowledgeRel("synced_sources")} s
          WHERE s.org_id = ${orgId}::uuid AND s.app_name = ${appName}
            AND (s.owner_user_id IS NULL OR s.owner_user_id = ${person}::uuid)
            AND ${where}
          ORDER BY s.archived_at IS NULL DESC, s.created_at DESC
        `),
      ),
    )
  }

  function declaredKind(kind: unknown): string {
    if (typeof kind !== "string" || !kind) throw bad("kind is required")
    return kind
  }

  function ownerOf(scope: unknown): string | null {
    if (scope === "organization") return null
    if (scope !== "personal") throw bad('scope is "personal" or "organization"')
    if (!person)
      throw typedError(403, "forbidden", "knowledge_appSource: a personal source needs a person")
    return person
  }

  async function find(p: Record<string, unknown>, includeArchived: boolean) {
    const kind = declaredKind(p.kind)
    if (typeof p.ref !== "string" || !REF_RE.test(p.ref)) throw bad("ref is required")
    const owner = ownerOf(p.scope)
    const account = typeof p.account === "string" ? p.account : null
    const found = await rows(drizzleSql`s.source_kind = ${kind} AND s.folder_ref = ${p.ref}
      AND s.owner_user_id IS NOT DISTINCT FROM ${owner}::uuid
      AND (${account}::text IS NULL OR lower(s.source_account) = lower(${account}))
      ${includeArchived ? drizzleSql`` : drizzleSql`AND s.archived_at IS NULL`}`)
    return found[0] ?? null
  }

  const run = async (paramsJson: string, writes: boolean): Promise<string> => {
    const p = JSON.parse(paramsJson || "{}") as Record<string, unknown>
    const write = p.op === "ensure" || p.op === "sync" || p.op === "purgeAccount"
    if (write !== writes) {
      throw bad(`op ${String(p.op)} goes through knowledge_appSource${write ? "Write" : ""}`)
    }
    switch (p.op) {
      case "get": {
        const row = await find(p, false)
        return JSON.stringify(row ? view(row) : null)
      }
      case "list":
        return JSON.stringify((await rows(drizzleSql`s.archived_at IS NULL`)).map(view))
      case "ensure": {
        const existing = await find(p, true)
        const { reactivateSyncedSource, createSyncedSource } = await import(
          "~/apps/knowledge/synced-sources"
        )
        if (existing) {
          await reactivateSyncedSource(orgId, existing.id)
          return JSON.stringify(view({ ...existing, last_sync_status: "idle" }))
        }
        const { knowledgeActorFromContext } = await import("~/apps/knowledge/service")
        const actor = knowledgeActorFromContext(bridgeKnowledgeActorInput(ctx))
        const scope = p.scope === "organization" ? "organization" : "personal"
        const created = await createSyncedSource(
          ctx.txDb as never,
          {
            appName,
            sourceKind: declaredKind(p.kind),
            sourceConfig:
              p.config && typeof p.config === "object" && !Array.isArray(p.config)
                ? (p.config as Record<string, unknown>)
                : {},
            folderRef: p.ref as string,
            displayName:
              typeof p.displayName === "string" && p.displayName ? p.displayName : appName,
            syncIntervalSeconds:
              typeof p.syncIntervalSeconds === "number" ? p.syncIntervalSeconds : 3600,
            scope,
            ...(scope === "organization" ? { defaultSensitivity: "internal" } : {}),
          },
          actor,
        )
        if (typeof p.account === "string" && p.account) {
          const [{ withPrivilegedDb }, { knowledgeRel }] = await Promise.all([
            import("~/db/privileged"),
            import("~/apps/knowledge/schema-refs"),
          ])
          await withPrivilegedDb(orgId, "app-source-account", (tx) =>
            tx.execute(drizzleSql`
                UPDATE ${knowledgeRel("synced_sources")} SET source_account = ${p.account as string}
                WHERE id = ${created.id}::uuid AND org_id = ${orgId}::uuid
              `),
          )
        }
        const [row] = await rows(drizzleSql`s.id = ${created.id}::uuid`)
        return JSON.stringify(row ? view(row) : null)
      }
      case "sync": {
        if (typeof p.id !== "string" || !UUID_RE.test(p.id)) throw bad("id is required")
        const [row] = await rows(drizzleSql`s.id = ${p.id}::uuid AND s.archived_at IS NULL`)
        if (!row)
          throw typedError(404, "not_found", "knowledge_appSource: no such source of this app")
        const { enqueueAppJob } = await import("~/infra/jobs/jobs")
        try {
          await enqueueAppJob(
            "knowledge",
            "sync-source",
            { sourceId: row.id, trigger: "force-on-open", enqueuedBy: person ?? "system" },
            { jobId: `sync:${row.id}` },
          )
          return JSON.stringify({ id: row.id, enqueued: true })
        } catch (err) {
          // The source is due: the scheduler's next tick syncs it.
          const [{ withPrivilegedDb }, { knowledgeRel }, { appsLogger }] = await Promise.all([
            import("~/db/privileged"),
            import("~/apps/knowledge/schema-refs"),
            import("~/lib/logger"),
          ])
          appsLogger.warn(
            { err, orgId, app: appName, sourceId: row.id },
            "app source: sync enqueue failed",
          )
          await withPrivilegedDb(orgId, "app-source-due", (tx) =>
            tx.execute(drizzleSql`
                UPDATE ${knowledgeRel("synced_sources")} SET last_sync_at = NULL, updated_at = now()
                WHERE id = ${row.id}::uuid AND org_id = ${orgId}::uuid
              `),
          )
          return JSON.stringify({ id: row.id, enqueued: false, due: true })
        }
      }
      case "purgeAccount": {
        if (typeof p.connectionId !== "string" || !UUID_RE.test(p.connectionId)) {
          throw bad("connectionId is required")
        }
        const { purgeDisconnectedAccount } = await import("~/apps/knowledge/account-sources-purge")
        return JSON.stringify(await purgeDisconnectedAccount(orgId, appName, p.connectionId))
      }
      default:
        throw bad(`unknown op ${String(p.op)}`)
    }
  }
  return {
    knowledge_appSource: async (paramsJson: string) => run(paramsJson, false),
    knowledge_appSourceWrite: async (paramsJson: string) => run(paramsJson, true),
  }
}
