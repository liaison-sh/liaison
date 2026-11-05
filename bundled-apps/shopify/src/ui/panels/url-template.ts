// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B13 — Detail-panel deep-link URL templater (spec §3.8 + §10.9).
//
// Each detail entity declares an `externalLink.urlTemplate` in
// `app.manifest.json#views.detail.<entity>`. This helper performs the
// `{{var}}` substitution. The single helper here is the production code path
// consumed by every panel; the per-entity tests in `url-template.test.ts`
// satisfy spec validation §10.9 ("a unit test in the app suite generates the
// expected admin URL for each detail-entity type").
//
// The templates supported per entity are also embedded in this file as a
// pure constant — the manifest stays the source of truth at runtime, but
// having the table here means a regression in either side (panel or
// manifest) bites at unit-test time.

export const DETAIL_ENTITY_URL_TEMPLATES = {
  order: "https://{{shop}}.myshopify.com/admin/orders/{{id}}",
  customer: "https://{{shop}}.myshopify.com/admin/customers/{{id}}",
  product: "https://{{shop}}.myshopify.com/admin/products/{{id}}",
  draftOrder: "https://{{shop}}.myshopify.com/admin/draft_orders/{{id}}",
  return: "https://{{shop}}.myshopify.com/admin/returns/{{id}}",
  refund: "https://{{shop}}.myshopify.com/admin/orders/{{orderId}}#refund-{{id}}",
  market: "https://{{shop}}.myshopify.com/admin/settings/markets/{{id}}",
} as const

export type DetailEntity = keyof typeof DETAIL_ENTITY_URL_TEMPLATES

export interface TemplateVars {
  shop: string
  id: string
  orderId?: string
}

/**
 * Reduce a stored connection shop domain to the `{{shop}}` subdomain the
 * admin URL templates expect. The kernel persists the full myshopify domain
 * (`acme.myshopify.com`); the templates already append `.myshopify.com`, so we
 * strip it (and any stray scheme / path) to avoid `acme.myshopify.com.myshopify.com`.
 * Returns `null` when no domain is known so callers can fall back / hide links.
 */
export function shopSubdomain(shopDomain: string | null | undefined): string | null {
  if (!shopDomain) return null
  const host = shopDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
  if (!host) return null
  return host.replace(/\.myshopify\.com$/i, "")
}

/**
 * Substitute `{{var}}` placeholders. A missing required variable throws —
 * surfacing template bugs rather than emitting `https://{{shop}}…` links —
 * EXCEPT for the optional `orderId`, which a refund detail link may legitimately
 * lack (deep-linked without its parent order). When `orderId` is absent the
 * refund template degrades to the order-agnostic refund admin path rather than
 * crashing the whole panel render.
 */
export function renderUrlTemplate(template: string, vars: TemplateVars): string {
  // Tolerate a missing orderId by collapsing the order-scoped fragment so the
  // link still points at a real (if less specific) admin page.
  const safeTemplate =
    vars.orderId === undefined || vars.orderId === ""
      ? template
          .replace("orders/{{orderId}}", "refunds")
          .replace("#refund-{{id}}", "/{{id}}")
      : template
  return safeTemplate.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = (vars as unknown as Record<string, string | undefined>)[key]
    if (v === undefined || v === "") {
      throw new Error(`url-template: missing variable "${key}"`)
    }
    return v
  })
}

/** Convenience: render the canonical template for the given entity. */
export function renderDetailUrl(entity: DetailEntity, vars: TemplateVars): string {
  return renderUrlTemplate(DETAIL_ENTITY_URL_TEMPLATES[entity], vars)
}

/**
 * Entity ids flow through the UI as GIDs (`gid://shopify/Order/123`), but the
 * admin URL templates want the trailing numeric id. Non-GID ids pass through
 * untouched.
 */
export function adminResourceId(id: string): string {
  const m = id.match(/^gid:\/\/shopify\/\w+\/(\d+)$/)
  return m?.[1] ?? id
}

/**
 * Shopify-admin order URL for the given stored connection domain + order id
 * (GID or numeric). Orders have NO in-app detail page — every order click in
 * the app opens the real Shopify admin order page in a new browser tab; this
 * is the single URL builder for those clicks. Returns null while the shop
 * domain is still unknown so callers can render a dead row rather than a
 * wrong-domain link.
 */
export function adminOrderUrl(shopDomain: string | null | undefined, id: string): string | null {
  const shop = shopSubdomain(shopDomain)
  if (!shop) return null
  return renderDetailUrl("order", { shop, id: adminResourceId(id) })
}
