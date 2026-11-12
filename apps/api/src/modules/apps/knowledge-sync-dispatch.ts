// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Runs one page of an app's knowledge source sync in the app's sandbox.
//
// An app declares knowledge source kinds in its manifest (`knowledgeSources`);
// registration (runtime.ts) builds one dispatch per app with
// `makeKnowledgeSyncDispatch`, and the Knowledge sync job
// (apps/knowledge/app-sources.ts) calls it with `{ sourceId, kind, config,
// cursor }` for each page. The run is the kind's `handler` export, entry
// `knowledge-sync:<kind>`, under that row of the run-limit table: a vouched app
// runs in-process, any other in the worker pool or on Workers (runApp picks).
// Its bridge acts for the source's owner, with bridge-owned per-call
// transactions: no run holds a database transaction.

import type { BridgeManifest, KnowledgeSourceKindDecl } from "~/modules/apps/app-registries"
import { runLimits } from "~/modules/apps/run-limits"

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v)

/**
 * The kinds of a manifest's `knowledgeSources` block (already validated by the
 * manifest schema): only well-formed entries, copied, so the registry never
 * holds the manifest's own objects.
 */
export function knowledgeSourceKindsOf(decl: unknown): Record<string, KnowledgeSourceKindDecl> {
  const out: Record<string, KnowledgeSourceKindDecl> = {}
  if (!isObject(decl)) return out
  for (const [kind, raw] of Object.entries(decl)) {
    if (!isObject(raw)) continue
    const handler = raw.handler
    const title = raw.title
    if (typeof handler !== "string" || handler.length === 0) continue
    out[kind] = {
      title: typeof title === "string" && title.length > 0 ? title : kind,
      handler,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.readScope === "string" ? { readScope: raw.readScope } : {}),
      ...(isObject(raw.configSchema) ? { configSchema: structuredClone(raw.configSchema) } : {}),
      ...(typeof raw.timeoutMs === "number" ? { timeoutMs: raw.timeoutMs } : {}),
    }
  }
  return out
}

export function makeKnowledgeSyncDispatch(opts: {
  appName: string
  kinds: Record<string, KnowledgeSourceKindDecl>
  bundlePath: string
  bridgeManifest: BridgeManifest
  /** The platform vouches for the app (hasPrivilegedBridge): it may run in-process. */
  vouched: boolean
}) {
  const { appName, kinds, bundlePath, bridgeManifest, vouched } = opts
  return async (
    kind: string,
    input: { sourceId: string; kind: string; config: Json; cursor: unknown },
    tenant: { orgId: string; userId: string },
  ): Promise<unknown> => {
    const decl = kinds[kind]
    if (!decl) throw new Error(`${appName} declares no knowledge source kind "${kind}"`)
    const [{ runApp }, { createSessionRpcBridge }, { withPrivilegedDb }, { createRlsSession }] =
      await Promise.all([
        import("~/modules/apps/sandbox/run-app"),
        import("~/modules/apps/sandbox/rpc-bridge"),
        import("~/db/privileged"),
        import("~/db/rls"),
      ])
    const { loadBundle } = await import("~/modules/apps/sandbox/bundle-loader")
    // At an app day cap the page is refused (the sync records the error and
    // tries again at its next interval).
    const { assertAppRunRoom } = await import("~/modules/apps/usage/app-day-cap")
    await assertAppRunRoom({ orgId: tenant.orgId, trusted: vouched })
    const scopes = [`${appName}:*`]
    // Per-call transactions: a vouched app's on the privileged connection, any
    // other's in an RLS session as the app itself (the search handler's shape).
    const session = vouched
      ? ({
          ctx: { actorType: "system", orgId: tenant.orgId, purpose: "job" },
          run: (fn: (tx: any) => Promise<any>) =>
            withPrivilegedDb(tenant.orgId, `knowledge-sync:${appName}`, fn),
        } as never)
      : createRlsSession({
          actorType: "system",
          orgId: tenant.orgId,
          purpose: "job",
          scopes,
        })
    const bridge = createSessionRpcBridge(
      appName,
      tenant.userId,
      tenant.orgId,
      session,
      bridgeManifest as Parameters<typeof createSessionRpcBridge>[4],
      scopes,
    )
    return runApp({
      trusted: vouched,
      appName,
      orgId: tenant.orgId,
      bundlePath,
      bundleSource: await loadBundle(bundlePath),
      exportName: decl.handler,
      entry: `knowledge-sync:${kind}`,
      params: input,
      bridge,
      timeoutMs: runLimits("knowledge-sync", { declaredMs: decl.timeoutMs }).wallMs,
      priority: "background",
      // One app's syncs hold at most half the background workers, like its jobs.
      backgroundGroup: `job:${appName}`,
      appId: appName,
      holdsTx: false,
    })
  }
}
