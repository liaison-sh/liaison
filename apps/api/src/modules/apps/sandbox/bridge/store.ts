// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `ctx.store.*`: the app data store (modules/data-store/service.ts) for app
 * code, on every executor (in-process QuickJS, the worker pool, Workers).
 *
 *  - The collections are the CALLING app's: `app` is this bridge's own app
 *    name, never an argument, so no call reaches another app's collection.
 *  - Every call runs in the bridge's RLS transaction (`txDb`, one per call on
 *    the session bridge), so the database keeps orgs apart.
 *  - `store` is a structured-return group (ctx-shim.ts SHIM_RULES): object
 *    arguments arrive as JSON text and every answer is JSON text, so a missing
 *    document is `null` on every executor (an in-process `undefined` would
 *    otherwise differ from the subprocess's `null`).
 *  - A refusal is a typed error (status + `code`, bridge-rejection.ts):
 *    `version_conflict` 409, `not_found` 404, `doc_too_large` 413,
 *    `collection_full` 409, any `invalid_*` 400.
 *  - Every method is an `async` function: the executors dispatch on that kind
 *    (rpc-bridge-method-set.test.ts).
 *  - The writes (`store_set`, `store_update`, `store_delete`) are refused on a
 *    read-only run (rpc-bridge.ts READ_ONLY_REFUSED_BRIDGE_METHODS).
 */
import { isUuid } from "~/lib/uuid"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { typedError } from "~/modules/apps/sandbox/bridge/secret-free"
import {
  countDocuments,
  DataStoreError,
  type DataStoreErrorCode,
  deleteDocument,
  getDocument,
  queryDocuments,
  type StoreCaller,
  type StoreQuery,
  setDocument,
  updateDocument,
  type Where,
  type WriteOptions,
} from "~/modules/data-store/service"

const STATUS_OF: Record<DataStoreErrorCode, number> = {
  version_conflict: 409,
  not_found: 404,
  doc_too_large: 413,
  collection_full: 409,
  invalid_name: 400,
  invalid_data: 400,
  invalid_field: 400,
  invalid_query: 400,
  invalid_cursor: 400,
  // The app's query ran past the store's statement timeout: narrow it (not a retry).
  query_timeout: 408,
}

/** A JSON argument: text from the shim, or the value itself from a direct caller. */
function jsonArg(raw: unknown, what: string): unknown {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw)
  } catch {
    throw typedError(400, "invalid_data", `ctx.store: ${what} is not JSON`)
  }
}

function writeOptions(raw: unknown): WriteOptions | undefined {
  const opts = jsonArg(raw, "the options")
  if (opts === undefined) return undefined
  if (typeof opts !== "object" || Array.isArray(opts)) {
    throw typedError(400, "invalid_data", "ctx.store: the options are an object")
  }
  return opts as WriteOptions
}

async function storeCall<T>(fn: () => Promise<T>): Promise<string> {
  try {
    return JSON.stringify((await fn()) ?? null)
  } catch (err) {
    if (err instanceof DataStoreError) {
      throw typedError(STATUS_OF[err.code] ?? 400, err.code, `ctx.store: ${err.message}`)
    }
    throw err
  }
}

export function createStoreMethods(
  ctx: Pick<BridgeContext, "appName" | "orgId" | "userId" | "actorType" | "txDb">,
): {
  store_get: (collection: string, id: string) => Promise<string>
  store_set: (
    collection: string,
    id: string,
    dataJson: unknown,
    optsJson?: unknown,
  ) => Promise<string>
  store_update: (
    collection: string,
    id: string,
    patchJson: unknown,
    optsJson?: unknown,
  ) => Promise<string>
  store_delete: (collection: string, id: string, optsJson?: unknown) => Promise<string>
  store_query: (collection: string, queryJson?: unknown) => Promise<string>
  store_count: (collection: string, whereJson?: unknown) => Promise<string>
} {
  const { appName, orgId, userId, actorType } = ctx
  const caller: StoreCaller = {
    orgId,
    app: appName,
    userId: actorType !== "system" && isUuid(userId) ? userId : null,
  }
  const tx = () => {
    if (!ctx.txDb) {
      throw typedError(400, "invalid_query", "ctx.store needs an organization's run")
    }
    return ctx.txDb
  }
  return {
    store_get: async (collection, id) => storeCall(() => getDocument(tx(), caller, collection, id)),
    store_set: async (collection, id, dataJson, optsJson) =>
      storeCall(() =>
        setDocument(
          tx(),
          caller,
          collection,
          id,
          jsonArg(dataJson, "the document"),
          writeOptions(optsJson),
        ),
      ),
    store_update: async (collection, id, patchJson, optsJson) =>
      storeCall(() =>
        updateDocument(
          tx(),
          caller,
          collection,
          id,
          jsonArg(patchJson, "the patch"),
          writeOptions(optsJson),
        ),
      ),
    store_delete: async (collection, id, optsJson) =>
      storeCall(() => deleteDocument(tx(), caller, collection, id, writeOptions(optsJson))),
    store_query: async (collection, queryJson) =>
      storeCall(() =>
        queryDocuments(
          tx(),
          caller,
          collection,
          (jsonArg(queryJson, "the query") ?? {}) as StoreQuery,
        ),
      ),
    store_count: async (collection, whereJson) =>
      storeCall(() =>
        countDocuments(
          tx(),
          caller,
          collection,
          jsonArg(whereJson, "the filter") as Where | undefined,
        ),
      ),
  }
}
