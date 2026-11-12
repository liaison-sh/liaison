// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: metafields (set, delete).

import type { AppContext } from "@liaison/app-sdk"
import { makeMutationError, resolveMutationInput, runMutation } from "./shared"

// ─────────────────────────────────────────────────────────────────────────
//  Metafields — set, delete (C6)
// ─────────────────────────────────────────────────────────────────────────

const METAFIELDS_SET = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value type ownerType }
      userErrors { field message }
    }
  }
`
export async function metafields_set(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  const metafields = (params.metafields as Record<string, unknown>[] | undefined) ?? []
  if (metafields.length === 0)
    throw makeMutationError("BAD_PARAM", "metafields is required (non-empty array)")
  return runMutation(ctx, {
    query: METAFIELDS_SET,
    variables: { metafields },
    dataKey: "metafieldsSet",
    eventEntity: "metafield",
    eventAction: "set",
    entityIdPath: "metafields.0.id",
  })
}

// API 2026-01 removed the single `metafieldDelete(input: MetafieldDeleteInput!)`; the replacement
// `metafieldsDelete(metafields: [MetafieldIdentifierInput!])` identifies each metafield by
// (ownerId, namespace, key) — NOT a metafield id. The tool accepts either a `metafields` array or a
// single {ownerId, namespace, key}.
const METAFIELDS_DELETE = `
  mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { ownerId namespace key }
      userErrors { field message }
    }
  }
`
export async function metafields_delete(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  const input = resolveMutationInput(params)
  const identifiers = Array.isArray(input.metafields)
    ? (input.metafields as Array<Record<string, unknown>>)
    : [
        {
          ownerId: input.ownerId ?? params.ownerId,
          namespace: input.namespace ?? params.namespace,
          key: input.key ?? params.key,
        },
      ]
  const first = identifiers[0]
  if (!first?.ownerId || !first?.namespace || !first?.key) {
    throw makeMutationError(
      "BAD_PARAM",
      "ownerId, namespace, and key are required to delete a metafield",
    )
  }
  return runMutation(ctx, {
    query: METAFIELDS_DELETE,
    variables: { metafields: identifiers },
    dataKey: "metafieldsDelete",
    eventEntity: "metafield",
    eventAction: "deleted",
    entityIdOverride: String(first.ownerId),
  })
}
