// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The app data store (`ctx.store`): JSON documents an app keeps for its
 * organization, in named collections, keyed by id. This file holds the
 * manifest declaration (`store.collections`) and its rules; the handler-side
 * types are `StoreClient` in ./types.ts.
 *
 * An app reaches its own collections through `ctx.store`, declared or not. A
 * declaration is what lets anything else read one: the agent's data tools,
 * dashboard blocks and search read a declared collection whose
 * `agentReadable` is true, and only for a person who holds its `readScope`.
 *
 *   "store": {
 *     "collections": {
 *       "orders": {
 *         "readScope": "myapp:orders:read",
 *         "searchable": { "labelField": "title", "fields": ["title", "customer"] },
 *         "agentReadable": true
 *       }
 *     }
 *   }
 */
import { z } from "zod"

/** A collection name (the store's own rule, kernel.app_documents.collection). */
export const STORE_COLLECTION_PATTERN = /^[a-z][a-z0-9_]{0,62}$/
/** A filterable, sortable or searchable top-level key of a document. */
export const STORE_FIELD_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/
/** Fields one collection may index for search. */
export const MAX_STORE_SEARCH_FIELDS = 10

const fieldName = z
  .string()
  .regex(STORE_FIELD_PATTERN, `a field name must match ${STORE_FIELD_PATTERN.source}`)

export const storeCollectionDeclarationSchema = z
  .object({
    /** The scope a person needs to read this collection outside the app. One of the app's own scopes. */
    readScope: z.string().min(1),
    /** Indexed for search: the label shown for a hit, and the fields searched. */
    searchable: z
      .object({
        labelField: fieldName,
        fields: z.array(fieldName).min(1).max(MAX_STORE_SEARCH_FIELDS),
      })
      .strict()
      .optional(),
    /** The agent's data tools and dashboard blocks may read it (default false). */
    agentReadable: z.boolean().optional(),
  })
  .strict()

export const appStoreDeclarationSchema = z
  .object({
    collections: z.record(
      z
        .string()
        .regex(
          STORE_COLLECTION_PATTERN,
          `a collection name must match ${STORE_COLLECTION_PATTERN.source}`,
        ),
      storeCollectionDeclarationSchema,
    ),
  })
  .strict()

export type StoreCollectionDeclaration = z.infer<typeof storeCollectionDeclarationSchema>
export type AppStoreDeclaration = z.infer<typeof appStoreDeclarationSchema>

export interface StoreDeclarationOptions {
  /** Whether `scope` is one the app declares (its `scopes`, its tools' required scopes...). */
  knownScopes: (scope: string) => boolean
}

/**
 * Why a manifest's `store` declaration cannot stand: its shape, then each
 * collection's `readScope`, which must be one of the app's own declared
 * scopes (in its namespace). Empty when `store` is absent or clean.
 */
export function storeDeclarationErrors(
  manifest: { name?: unknown; store?: unknown },
  options: StoreDeclarationOptions,
): string[] {
  if (manifest.store === undefined) return []
  const parsed = appStoreDeclarationSchema.safeParse(manifest.store)
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `store.${i.path.join(".")}: ${i.message}`)
  }
  const errors: string[] = []
  const name = typeof manifest.name === "string" ? manifest.name : ""
  const prefixes = [`${name}:`, `${name.replace(/-/g, "_")}:`]
  for (const [collection, decl] of Object.entries(parsed.data.collections)) {
    const at = `store.collections.${collection}.readScope`
    if (!prefixes.some((p) => decl.readScope.startsWith(p))) {
      errors.push(`${at}: must be one of the app's own scopes (got "${decl.readScope}")`)
    } else if (!options.knownScopes(decl.readScope)) {
      errors.push(
        `${at}: "${decl.readScope}" is not a scope this app declares (in "scopes" or a tool's "requiredScopes")`,
      )
    }
  }
  return errors
}
