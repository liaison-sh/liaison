// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's data store tools over modules/data-store/service.ts, registered
// once per org from agent/tools/kernel-tools.ts.
//
//  - Reads (data_collections_list, data_query, data_get; kernel:data:read)
//    reach DECLARED, agent-readable collections only (declared.ts), and each
//    under its collection's own read scope, checked here against the caller's
//    scopes: an undeclared collection, or one whose scope the caller lacks,
//    answers exactly like a missing one. The agent's own namespace (`agent`) is
//    declared implicitly, under kernel:data:read. What a read returns is outside
//    content an app or a person wrote (`taintSource`), and it taints the turn
//    with the collection's read scope, so the turn cannot then write it where
//    people lacking that scope read.
//  - Writes (data_set, data_update, data_delete; kernel:data:write) reach the
//    agent's own namespace only: they take no app, and refuse one.
//  - Every write is indexed for search by the service (search.ts).

import { z } from "zod"
import type { RlsClient } from "~/db"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { toolRegistry } from "~/modules/apps/app-registries"
import {
  type DeclaredCollection,
  getDeclaredCollection,
  listDeclaredCollections,
} from "~/modules/data-store/declared"
import {
  AGENT_STORE_APP,
  DataStoreError,
  deleteDocument,
  getDocument,
  listCollections,
  MAX_QUERY_LIMIT,
  queryDocuments,
  type StoreCaller,
  type StoreQuery,
  setDocument,
  updateDocument,
} from "~/modules/data-store/service"
// Loaded with the tools so every process that sets up an org registers the
// store's search resolver and rebuild source (search.ts), whoever flushes.
import "~/modules/data-store/search"
import { hasScope } from "~/modules/permissions/permissions"

/** The table the write tools write, for scope taint (scope-taint.ts consequence 4). */
export const SINK_KERNEL_APP_DOCUMENTS = "kernel.app_documents"
export const DATA_READ_SCOPE = "kernel:data:read"
export const DATA_WRITE_SCOPE = "kernel:data:write"

export interface DataToolContext {
  orgId: string
  userId: string
  db: RlsClient
  scopes?: string[]
}

export type DataToolError = { error: { code: string; message: string } }

function refusal(code: string, message: string): DataToolError {
  return { error: { code, message } }
}

function fromStoreError(err: unknown): DataToolError {
  if (err instanceof DataStoreError) return refusal(err.code, err.message)
  throw err
}

function notReadable(app: string, collection: string): DataToolError {
  return refusal(
    "not_found",
    `No readable collection '${collection}' in app '${app}'. Call data_collections_list for the collections you can read.`,
  )
}

/** The declaration when the caller may read it from a tool, else null. */
function readableCollection(
  ctx: DataToolContext,
  app: string,
  collection: string,
): DeclaredCollection | null {
  const decl = getDeclaredCollection(ctx.orgId, app, collection)
  if (!decl?.agentReadable) return null
  return hasScope(decl.readScope, ctx.scopes ?? []) ? decl : null
}

/** What a read returns taints the turn with the collection's read scope. */
function recordReadTaint(decl: DeclaredCollection): void {
  currentRunContext()?.turnScopeAccumulator?.recordInjected([decl.readScope])
}

function agentCaller(ctx: DataToolContext): StoreCaller {
  return { orgId: ctx.orgId, app: AGENT_STORE_APP, userId: ctx.userId }
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

export interface CollectionListing {
  app: string
  collection: string
  docs: number
  /** The field shown as a document's name in search, and the fields searched. */
  searchable: { labelField: string; fields: string[] } | null
}

export async function handleDataCollectionsList(
  params: { app?: string },
  ctx: DataToolContext,
): Promise<{ collections: CollectionListing[] } | DataToolError> {
  try {
    const usage = await listCollections(ctx.db, { orgId: ctx.orgId, app: params.app })
    const docsOf = new Map(usage.map((u) => [`${u.app}\0${u.collection}`, u.docs]))
    const out: CollectionListing[] = []
    const add = (decl: DeclaredCollection | null) => {
      if (!decl?.agentReadable || !hasScope(decl.readScope, ctx.scopes ?? [])) return
      out.push({
        app: decl.app,
        collection: decl.collection,
        docs: docsOf.get(`${decl.app}\0${decl.collection}`) ?? 0,
        searchable: decl.searchable,
      })
    }
    for (const decl of listDeclaredCollections(ctx.orgId, params.app)) add(decl)
    if (params.app === undefined || params.app === AGENT_STORE_APP) {
      for (const u of usage) {
        if (u.app === AGENT_STORE_APP) add(getDeclaredCollection(ctx.orgId, u.app, u.collection))
      }
    }
    return { collections: out }
  } catch (err) {
    return fromStoreError(err)
  }
}

export async function handleDataQuery(
  params: { app: string; collection: string; query?: StoreQuery },
  ctx: DataToolContext,
): Promise<Awaited<ReturnType<typeof queryDocuments>> | DataToolError> {
  const decl = readableCollection(ctx, params.app, params.collection)
  if (!decl) return notReadable(params.app, params.collection)
  try {
    const caller: StoreCaller = { orgId: ctx.orgId, app: decl.app, userId: ctx.userId }
    const res = await queryDocuments(ctx.db, caller, decl.collection, params.query ?? {})
    recordReadTaint(decl)
    return res
  } catch (err) {
    return fromStoreError(err)
  }
}

export async function handleDataGet(
  params: { app: string; collection: string; id: string },
  ctx: DataToolContext,
): Promise<{ document: Awaited<ReturnType<typeof getDocument>> } | DataToolError> {
  const decl = readableCollection(ctx, params.app, params.collection)
  if (!decl) return notReadable(params.app, params.collection)
  try {
    const caller: StoreCaller = { orgId: ctx.orgId, app: decl.app, userId: ctx.userId }
    const document = await getDocument(ctx.db, caller, decl.collection, params.id)
    recordReadTaint(decl)
    return { document }
  } catch (err) {
    return fromStoreError(err)
  }
}

/** A write naming an app is refused: the agent writes its own namespace only. */
function refuseOtherApp(params: { app?: unknown }): DataToolError | null {
  if (params.app === undefined || params.app === AGENT_STORE_APP) return null
  return refusal(
    "not_allowed",
    `The data tools write only the agent's own collections (app '${AGENT_STORE_APP}'); an app's collections are written by that app.`,
  )
}

export async function handleDataSet(
  params: { app?: string; collection: string; id: string; data: unknown; ifVersion?: number },
  ctx: DataToolContext,
) {
  const refused = refuseOtherApp(params)
  if (refused) return refused
  try {
    const document = await setDocument(
      ctx.db,
      agentCaller(ctx),
      params.collection,
      params.id,
      params.data,
      { ifVersion: params.ifVersion },
    )
    return { document }
  } catch (err) {
    return fromStoreError(err)
  }
}

export async function handleDataUpdate(
  params: { app?: string; collection: string; id: string; patch: unknown; ifVersion?: number },
  ctx: DataToolContext,
) {
  const refused = refuseOtherApp(params)
  if (refused) return refused
  try {
    const document = await updateDocument(
      ctx.db,
      agentCaller(ctx),
      params.collection,
      params.id,
      params.patch,
      { ifVersion: params.ifVersion },
    )
    return { document }
  } catch (err) {
    return fromStoreError(err)
  }
}

export async function handleDataDelete(
  params: { app?: string; collection: string; id: string; ifVersion?: number },
  ctx: DataToolContext,
) {
  const refused = refuseOtherApp(params)
  if (refused) return refused
  try {
    return await deleteDocument(ctx.db, agentCaller(ctx), params.collection, params.id, {
      ifVersion: params.ifVersion,
    })
  } catch (err) {
    return fromStoreError(err)
  }
}

/* -------------------------------------------------------------------------- */
/* Params                                                                     */
/* -------------------------------------------------------------------------- */

const appParam = z
  .string()
  .min(1)
  .describe(
    `The app that owns the collection, from data_collections_list ('${AGENT_STORE_APP}' for your own).`,
  )
const collectionParam = z
  .string()
  .min(1)
  .describe("Collection name: lowercase letters, digits and _, e.g. 'customer_notes'.")
const idParam = z.string().min(1).max(200).describe("The document's id within the collection.")
const ifVersionParam = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    "Optional: the version you last read. The write is refused with version_conflict if the document changed since; 0 means it must not exist yet.",
  )

const queryParam = z
  .object({
    where: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Filters on top-level fields: {"status": "open"}, {"status": {"in": ["open", "late"]}}, {"total": {"gte": 100}}.',
      ),
    orderBy: z
      .object({ field: z.string(), dir: z.enum(["asc", "desc"]).optional() })
      .optional()
      .describe('Sort, e.g. {"field": "updated_at", "dir": "desc"}.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_QUERY_LIMIT)
      .optional()
      .describe("Page size, default 50."),
    cursor: z.string().optional().describe("nextCursor of the previous page."),
  })
  .describe("Optional filter, sort and page.")

export const DataToolParams = {
  collectionsList: z.object({
    app: z.string().min(1).optional().describe("Only this app's collections."),
  }),
  query: z.object({ app: appParam, collection: collectionParam, query: queryParam.optional() }),
  get: z.object({ app: appParam, collection: collectionParam, id: idParam }),
  // Strict: an `app` key is an attempt at another app's collection, refused outright.
  set: z
    .object({
      collection: collectionParam,
      id: idParam,
      data: z
        .record(z.string(), z.unknown())
        .describe(
          "The whole document, a JSON object (up to 256 KiB). A 'title' and a 'summary' field make it findable in search.",
        ),
      ifVersion: ifVersionParam,
    })
    .strict(),
  update: z
    .object({
      collection: collectionParam,
      id: idParam,
      patch: z
        .record(z.string(), z.unknown())
        .describe("Fields to change; other fields stay as they are."),
      ifVersion: ifVersionParam,
    })
    .strict(),
  delete: z
    .object({ collection: collectionParam, id: idParam, ifVersion: ifVersionParam })
    .strict(),
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

type Handler = (params: unknown, ctx: any) => Promise<unknown>

/** Registers the kernel's data store tools for `orgId`. */
export function registerDataStoreTools(orgId: string): void {
  const readKeywords = ["data", "records", "collection", "store", "données", "enregistrements"]
  // Not "remember" or "note": those belong to the memory tools.
  const writeKeywords = ["collection", "records", "store", "tracker", "données"]

  toolRegistry.set([orgId, "kernel", "data_collections_list"], {
    appName: "kernel",
    name: "data_collections_list",
    deferLoading: true,
    readOnly: true,
    description:
      "List the data collections you can read: records apps keep (e.g. synced orders) and your own saved collections (app 'agent'), with document counts. Call it before data_query or data_get.",
    searchKeywords: readKeywords,
    requiredScopes: [DATA_READ_SCOPE],
    params: DataToolParams.collectionsList,
    handler: handleDataCollectionsList as Handler,
  })

  toolRegistry.set([orgId, "kernel", "data_query"], {
    appName: "kernel",
    name: "data_query",
    deferLoading: true,
    readOnly: true,
    taintSource: true,
    description:
      "Read documents of one data collection, filtered, sorted and paged. Returns {items: [{id, data, version, updatedAt}], nextCursor}. App and collection come from data_collections_list.",
    searchKeywords: [...readKeywords, "query", "filter", "list"],
    requiredScopes: [DATA_READ_SCOPE],
    params: DataToolParams.query,
    handler: handleDataQuery as Handler,
  })

  toolRegistry.set([orgId, "kernel", "data_get"], {
    appName: "kernel",
    name: "data_get",
    deferLoading: true,
    readOnly: true,
    taintSource: true,
    description:
      "Read one document of a data collection by id. Returns {document: {id, data, version, updatedAt}} or {document: null}.",
    searchKeywords: readKeywords,
    requiredScopes: [DATA_READ_SCOPE],
    params: DataToolParams.get,
    handler: handleDataGet as Handler,
  })

  // Each write declares its fields in place (no shared spread): the reference generator reads a
  // tool's scopes from its own literal.
  toolRegistry.set([orgId, "kernel", "data_set"], {
    appName: "kernel",
    name: "data_set",
    deferLoading: true,
    searchKeywords: writeKeywords,
    requiredScopes: [DATA_WRITE_SCOPE],
    writesToTable: SINK_KERNEL_APP_DOCUMENTS,
    sinkReadScope: DATA_READ_SCOPE,
    description:
      "Save a document in one of your own data collections (created on first write), replacing it if the id exists. For structured records you keep for the org: a tracker, a list, notes per customer. Teammates with data access can read it.",
    params: DataToolParams.set,
    handler: handleDataSet as Handler,
  })

  toolRegistry.set([orgId, "kernel", "data_update"], {
    appName: "kernel",
    name: "data_update",
    deferLoading: true,
    searchKeywords: writeKeywords,
    requiredScopes: [DATA_WRITE_SCOPE],
    writesToTable: SINK_KERNEL_APP_DOCUMENTS,
    sinkReadScope: DATA_READ_SCOPE,
    description:
      "Change some fields of an existing document in one of your own data collections; the other fields stay.",
    params: DataToolParams.update,
    handler: handleDataUpdate as Handler,
  })

  toolRegistry.set([orgId, "kernel", "data_delete"], {
    appName: "kernel",
    name: "data_delete",
    deferLoading: true,
    searchKeywords: writeKeywords,
    requiredScopes: [DATA_WRITE_SCOPE],
    writesToTable: SINK_KERNEL_APP_DOCUMENTS,
    sinkReadScope: DATA_READ_SCOPE,
    description: "Delete a document from one of your own data collections. Returns {deleted}.",
    params: DataToolParams.delete,
    handler: handleDataDelete as Handler,
  })
}
