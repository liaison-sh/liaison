// SPDX-License-Identifier: FSL-1.1-ALv2

import { createGitlabAdapter } from "~/apps/gitlab/adapter"
import { makeGitlabFetchers } from "~/apps/gitlab/gitlab-rest"
import { createGoogleDriveAdapter, type GoogleDriveAdapterDeps } from "~/apps/google-drive/adapter"
import { makeDriveFetchers } from "~/apps/google-drive/drive-rest"
import type { KnowledgeSourceRegistry } from "~/apps/knowledge/federated-search"
import { createKnowledgeSourceRegistry } from "~/apps/knowledge/federated-search"
import type { KnowledgeActor } from "~/apps/knowledge/service"
import {
  isFolderSourceCapable,
  type KnowledgeSourceAdapter,
} from "~/apps/knowledge/source-protocol"
import { loadSourcePolicy } from "~/apps/knowledge/sources"
import type { RlsClient } from "~/db"
import { hasScope } from "~/modules/permissions/permissions"

/**
 * The scope that lets a user READ each connected source app: the same scope that
 * gates the app's own tools. Shared with the sync worker so a source cannot be
 * mounted, searched or synced through a credential its owner may not use.
 */
export const KNOWLEDGE_SOURCE_READ_SCOPE = {
  "google-drive": "google-drive:accounts:read",
  gitlab: "gitlab:repo:read",
} as const

/**
 * Build a request-scoped registry whose Drive adapter uses the connections
 * store to resolve a short-lived OAuth token, then issues real Drive REST calls.
 * Caller passes the active RLS-bound tx + auth context; the resulting registry
 * is safe to discard at end of request — there is no shared mutable state.
 *
 * Use this in route handlers / sandbox bridges when a real Drive fan-out is
 * needed. Unit-test paths construct an explicit registry via
 * `createKnowledgeSourceRegistry()` + `.register(...)` with their own stub
 * adapters.
 */
export function registerDefaultKnowledgeSources(input: {
  tx: RlsClient
  orgId: string
  userId: string
  /**
   * The caller's effective scopes. A source adapter resolves the connected
   * account's credential on the caller's behalf, and an org-owned connection is
   * shared by everyone, so the source app's own read scope gates the adapter
   * here: a member whose role excludes the GitLab or Drive app gets no adapter
   * (search skips it, creating a synced source from it is refused).
   */
  scopes: readonly string[]
  identifier?: string
}): KnowledgeSourceRegistry {
  // The Drive connection is the manifest's `drive` key (drive-access.ts).
  const { tx, orgId, userId, scopes, identifier } = input
  // The token and the read scope come from one lookup: an organization's
  // connection reads only the shared drives an admin chose (drive-scope.ts).
  const getAccess = async () => {
    const { resolveDriveAccess } = await import("~/apps/google-drive/drive-access")
    return resolveDriveAccess(tx, orgId, userId, identifier ? { identifier } : undefined)
  }
  const getToken = async (): Promise<string> => (await getAccess()).token
  // Real Drive REST IO — fetchDrive (list), getMetadata, download, exportGoogleDoc.
  const fetchers = makeDriveFetchers(getAccess)
  // getPolicy reads the per-org source policy row so broadSearchEnabled is
  // honored on every search. Falls back to defaults when no row exists.
  const getPolicy = async () => {
    const actor = {
      orgId,
      userId,
      scopes: ["knowledge:sources:read"],
      dimensionGrants: {},
    }
    const row = await loadSourcePolicy(tx, "google-drive", actor)
    return {
      connectionMode: row.connectionMode,
      broadSearchEnabled: row.broadSearchEnabled,
    }
  }
  const registry = createKnowledgeSourceRegistry()
  if (hasScope(KNOWLEDGE_SOURCE_READ_SCOPE["google-drive"], [...scopes])) {
    registry.register(
      createGoogleDriveAdapter({
        getToken,
        ...fetchers,
        getPolicy,
      } satisfies GoogleDriveAdapterDeps),
    )
  }

  // GitLab — registered UNCONDITIONALLY (connection-absence is handled later by
  // `searchRemote` returning a `skipped`/`error` status, NOT by `listEnabled`,
  // which only filters by the explicit `filters.sources` allow-list).
  // Serves both (a) federated `knowledge:search` and (b) the create-route precheck
  // (`POST /synced-sources` → registry.find(source==='gitlab')).
  // Creds resolved via RLS tx — correct for the request context; no widening needed.
  // The connected `group` is threaded into the adapter as `resolveDefaultGroupId`
  // (resolved lazily at search time) so federated blob search is scoped to it
  // rather than falling through to the global `/search` endpoint.
  const loadGitlabCreds = async (): Promise<Record<string, string>> => {
    const { getCredentialsForConnection } = await import("~/modules/apps/connections/service")
    return getCredentialsForConnection(tx, orgId, userId, "gitlab", "gitlab")
  }
  const getGitlabToken = async (): Promise<string> => String((await loadGitlabCreds()).token)
  const gitlabClient = makeGitlabFetchers(getGitlabToken)
  const resolveGitlabGroup = async (): Promise<string | undefined> => {
    try {
      const group = (await loadGitlabCreds()).group
      return group ? String(group) : undefined
    } catch {
      // No connection / no creds — leave the group undefined; searchRemote degrades.
      return undefined
    }
  }
  if (hasScope(KNOWLEDGE_SOURCE_READ_SCOPE.gitlab, [...scopes])) {
    registry.register(
      createGitlabAdapter({ client: gitlabClient, resolveDefaultGroupId: resolveGitlabGroup }),
    )
  }

  return registry
}

/**
 * Filter a registry down to adapters that declare `listFolder` (M-2 protocol
 * extension). Used by the Knowledge synced-sources UI to populate the
 * "Choose source" picker and by the reconciler to refuse running against a
 * non-folder-capable adapter.
 */
export function listFolderCapableSources(
  registry: KnowledgeSourceRegistry,
  actor: KnowledgeActor,
): KnowledgeSourceAdapter[] {
  return registry.listEnabled(actor).filter(isFolderSourceCapable)
}
