// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Declared data store collections: what may be read outside the app that owns
// a collection (the agent's data tools, dashboard blocks, search).
//
//  - An installed app declares collections in its manifest
//    (`store.collections.<name>: {readScope, searchable?, agentReadable?}`,
//    validated with the manifest, @liaison/app-sdk app-store.ts); registration
//    keeps them in `appStoreDeclarationsRegistry`.
//  - The agent's own namespace (`agent`) declares every collection implicitly,
//    with a fixed declaration: readScope `kernel:data:read`, searchable on
//    `title`/`summary`, agent-readable.
//  - An undeclared collection is reachable by its own app through `ctx.store`
//    only: these helpers return null for it, and every outside reader refuses
//    it. Outside readers also check `agentReadable` and `readScope` themselves.

import { appStoreDeclarationsRegistry } from "~/modules/apps/app-registries"
import { AGENT_STORE_APP, COLLECTION_RE } from "~/modules/data-store/service"

export interface DeclaredCollection {
  app: string
  collection: string
  /** The scope a reader must hold. */
  readScope: string
  /** Indexed for search, or null. */
  searchable: { labelField: string; fields: string[] } | null
  /** The agent's data tools and dashboard blocks may read it. */
  agentReadable: boolean
}

/** The fixed declaration of every collection in the agent's namespace. */
export const AGENT_COLLECTION_DECLARATION: Readonly<
  Omit<DeclaredCollection, "app" | "collection">
> = Object.freeze({
  readScope: "kernel:data:read",
  searchable: Object.freeze({ labelField: "title", fields: ["title", "summary"] }),
  agentReadable: true,
})

function agentCollection(collection: string): DeclaredCollection {
  const { searchable } = AGENT_COLLECTION_DECLARATION
  return {
    app: AGENT_STORE_APP,
    collection,
    readScope: AGENT_COLLECTION_DECLARATION.readScope,
    searchable: searchable
      ? { labelField: searchable.labelField, fields: [...searchable.fields] }
      : null,
    agentReadable: true,
  }
}

/**
 * The declaration of `app`'s `collection` in `orgId`, or null when the app is
 * not registered there or does not declare it. Any valid collection name of
 * the agent namespace is declared.
 */
export function getDeclaredCollection(
  orgId: string,
  app: string,
  collection: string,
): DeclaredCollection | null {
  if (typeof collection !== "string" || !COLLECTION_RE.test(collection)) return null
  if (app === AGENT_STORE_APP) return agentCollection(collection)
  const decl = appStoreDeclarationsRegistry.get([orgId, app])?.[collection]
  if (!decl) return null
  return {
    app,
    collection,
    readScope: decl.readScope,
    searchable: decl.searchable
      ? { labelField: decl.searchable.labelField, fields: [...decl.searchable.fields] }
      : null,
    agentReadable: decl.agentReadable === true,
  }
}

/**
 * The collections installed apps declare in `orgId` (one app's when `app` is
 * given), sorted by app then collection. The agent namespace declares its
 * collections implicitly, so it lists none here: list its collections from
 * the store itself (service.ts listCollections) and describe each with
 * `getDeclaredCollection`.
 */
export function listDeclaredCollections(orgId: string, app?: string): DeclaredCollection[] {
  const out: DeclaredCollection[] = []
  const add = (appName: string, collections: Readonly<Record<string, unknown>>) => {
    for (const name of Object.keys(collections)) {
      const decl = getDeclaredCollection(orgId, appName, name)
      if (decl) out.push(decl)
    }
  }
  if (app !== undefined) {
    if (app === AGENT_STORE_APP) return []
    const collections = appStoreDeclarationsRegistry.get([orgId, app])
    if (collections) add(app, collections)
  } else {
    for (const [[, appName], collections] of appStoreDeclarationsRegistry.entriesOf(orgId)) {
      add(appName, collections)
    }
  }
  return out.sort((a, b) =>
    a.app === b.app ? a.collection.localeCompare(b.collection) : a.app.localeCompare(b.app),
  )
}
