// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B12 — Periodic reconcile-customers job (24h drift backstop).
//
// Samples up to 50 of THIS app's externally-linked kernel contacts via the
// sandbox kernel-read affordance (`ctx.listContactsByExternalId`), refetches
// each from Shopify, and:
//   - present  → re-resolve via `ctx.resolveContact` (kernel re-derives the
//     diff and updates the row),
//   - missing-in-Shopify → emit `customer:deleted` + clear this app's entry in
//     `kernel.contacts.external_ids` via `ctx.resolveContact({ clear: true })`
//     (the contact row itself is preserved, matching customers/delete webhook).
//
// Why the bridge affordance, not `ctx.db.findMany("kernel.contacts")`:
// `kernel.contacts` is not one of the app's declared tables, so `ctx.db`
// resolves the literal key to `app_shopify."kernel.contacts"` and the sandbox
// `validateEntity` guard throws on the first statement. The reconcile leg was
// dead in production until the kernel exposed `listContactsByExternalId`
// (cluster 6). Likewise the clear path must go through `resolveContact`, not a
// raw `db.update("kernel.contacts")` which the sandbox also rejects.
//
// Per-contact errors are swallowed (logged) so a transient Shopify failure on
// one row does not abort the whole sample.
import type { AppContext } from "@liaison/app-sdk"
import { emitEvent } from "../lib/emit"
import { getShopifyClient } from "../lib/get-client"
import { type KernelContactRef, listContactsByExternalId } from "../lib/kernel-contacts"

const SAMPLE_SIZE = 50

const CUSTOMER_QUERY = `
  query CustomerById($id: ID!) {
    customer(id: $id) {
      id email firstName lastName
    }
  }
`

interface ShopifyCustomer {
  id?: string
  email?: string | null
  firstName?: string | null
  lastName?: string | null
}

function gid(shopifyId: string): string {
  return shopifyId.startsWith("gid://") ? shopifyId : `gid://shopify/Customer/${shopifyId}`
}

function fullName(c: ShopifyCustomer): string | undefined {
  const parts = [c.firstName, c.lastName].filter((x) => x && x.length > 0)
  return parts.length > 0 ? parts.join(" ") : undefined
}

export async function reconcileCustomersJob(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ processed: number; deleted: number }> {
  // Page through the kernel contact list, but cap the total sample at
  // SAMPLE_SIZE so one cron tick does not fan out unboundedly.
  const eligible: KernelContactRef[] = []
  let cursor: string | null = null
  while (eligible.length < SAMPLE_SIZE) {
    const page = await listContactsByExternalId(ctx, SAMPLE_SIZE - eligible.length, cursor)
    for (const c of page.contacts) {
      if (c.externalId) eligible.push(c)
    }
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  if (eligible.length === 0) return { processed: 0, deleted: 0 }

  const client = await getShopifyClient(ctx)
  let processed = 0
  let deleted = 0

  for (const contact of eligible) {
    const shopifyId = contact.externalId
    if (!shopifyId) continue
    try {
      const data = await client.query<{ customer?: ShopifyCustomer | null }>(CUSTOMER_QUERY, {
        id: gid(shopifyId),
      })
      const cust = data.customer
      if (cust && cust.id) {
        await ctx.resolveContact({
          email: cust.email ?? undefined,
          name: fullName(cust),
          externalId: shopifyId,
        })
        processed++
      } else {
        // Missing in Shopify — clear this app's external-id linkage via the
        // kernel `resolveContact({ clear: true })` path (the contact row is
        // preserved), then emit the canonical `customer:deleted` event.
        await ctx.resolveContact({ externalId: shopifyId, clear: true })
        await emitEvent(ctx, {
          entity: "customer",
          action: "deleted",
          entityId: contact.id,
          data: { contactId: contact.id, shopifyId },
        })
        deleted++
      }
    } catch (err) {
      ctx.logger.warn(`[reconcile-customers] contact=${contact.id}: ${(err as Error).message}`)
      // continue
    }
  }

  return { processed, deleted }
}
