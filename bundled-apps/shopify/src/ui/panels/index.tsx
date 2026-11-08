// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B13 — Detail panel components for every Shopify entity (spec §3.8 + §11.3).
//
// Phase 16.6 — Each panel calls the corresponding read tool via
// `app.invokeTool` from `@liaison/host` (kernel writes `window.__liaisonHost`
// at boot; `app.invokeTool` pre-binds the plugin name via
// `__LIAISON_APP_NAME__` substituted at freeze time). Tests install a mock
// host on `globalThis.__liaisonHost` and set `globalThis.__LIAISON_TEST_APP_NAME`.
//
// Each panel:
//   - Calls its read tool on open via `app.invokeTool(<entity>_read, { id })`.
//     Owned by SolidJS through `createResource` for natural re-renders.
//   - Renders rich entity-specific content per spec §3.9 (line items /
//     fulfillments / refunds / returns / tags / variants / inventory / etc.)
//     — not just a deep-link stub. (C5 fix.)
//   - Renders an "Open in Shopify ↗" external-link anchor built from the
//     manifest `views.detail.<entity>.externalLink.urlTemplate`.
//
// Styling: Tailwind tokens (kernel design system, dark-mode tuned). The
// kernel's theme.css `@source "../../../../bundled-apps/**/src/**/*.{tsx,ts}"`
// directive scans this file so the JIT emits the classes used here.
import { For, Show, type Component } from "solid-js"
import { app } from "@liaison/host"
import { type DetailEntity, renderDetailUrl, shopSubdomain } from "./url-template"
import {
  Chip,
  KeyValueRow,
  PanelHeader,
  PanelLoading,
  PanelShell,
  Section,
  StatusPill,
  useShopDomain,
} from "../primitives"
import { onOutsideLinkClick } from "../external-link"

interface BasePanelProps {
  // `shop` is an optional fallback supplied by the host (DetailTab). The host
  // does not know the real store subdomain, so each panel resolves the live
  // `connection.shopDomain` itself via the bridge and only falls back to this
  // prop when the probe hasn't resolved yet.
  shop?: string
  id: string
}

interface RefundPanelProps extends BasePanelProps {
  // Deep-linked refunds may arrive without their parent order id; the external
  // link degrades gracefully when it's absent (see renderUrlTemplate).
  orderId?: string
}

// ─────────────────────────────────────────────────────────────────────────
// useResolvedShop — prefer the live store subdomain (from the bridge) over the
// host-supplied fallback prop. Returns the `{{shop}}` subdomain the admin URL
// templates expect, never the literal app name "shopify".
// ─────────────────────────────────────────────────────────────────────────
function useResolvedShop(props: BasePanelProps): () => string {
  const shopDomain = useShopDomain()
  return () => shopSubdomain(shopDomain()) ?? shopSubdomain(props.shop) ?? props.shop ?? ""
}

// ─────────────────────────────────────────────────────────────────────────
//  Shared primitives — imported from `../primitives`. ExternalLink is the
//  one panel-specific helper that stays here (it depends on the
//  `renderDetailUrl` template, which is detail-tab-only).
// ─────────────────────────────────────────────────────────────────────────

// `shop` is passed as an accessor (not a resolved string) because the store
// subdomain is resolved asynchronously via the bridge (`useShopDomain`). The
// href is therefore derived reactively: while the shop is still unknown the
// link is omitted entirely rather than rendered against an empty / wrong
// domain — so a deep-linked panel never emits `https://shopify.myshopify.com`
// or crashes on a missing `{{shop}}` (CLUSTER 7.1).
function ExternalLink(props: {
  entity: DetailEntity
  shop: () => string
  id: string
  orderId?: string
  label?: string
}) {
  const href = () => {
    const shop = props.shop()
    if (!shop) return null
    return renderDetailUrl(props.entity, { shop, id: props.id, orderId: props.orderId })
  }
  return (
    <Show when={href()}>
      {(h) => (
        <div class="mt-auto pt-3">
          <a
            class="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition hover:border-accent-border hover:bg-accent-subtle hover:text-accent"
            data-testid="open-in-shopify"
            href={h()}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => onOutsideLinkClick(e, h())}
          >
            {props.label ?? "Open in Shopify"}
            <span aria-hidden="true">↗</span>
          </a>
        </div>
      )}
    </Show>
  )
}

/**
 * Resource hook: call the entity's read tool via the host bridge. Treat the
 * resource value as Record<string, unknown> with no narrowing — per-panel
 * code reads named fields.
 */
function usePanelData(
  toolName: string,
  props: BasePanelProps,
  extraArgs: Record<string, unknown> = {},
) {
  const [data] = app.createResource<Record<string, unknown>>(() =>
    app.invokeTool<Record<string, unknown>>(toolName, { id: props.id, ...extraArgs }),
  )
  return data
}

// ─────────────────────────────────────────────────────────────────────────
//  Order line items — orders themselves have NO in-app detail panel (order
//  clicks open the Shopify admin page directly; the admin view is strictly
//  richer than anything we rendered here). The line-item shape survives
//  because DraftOrderPanel renders the same projection.
// ─────────────────────────────────────────────────────────────────────────
interface OrderLineItem {
  id?: string
  title?: string
  quantity?: number
  priceSet?: { amount?: string; currencyCode?: string }
  variant?: { id?: string | null; title?: string | null; sku?: string | null }
}

// ─────────────────────────────────────────────────────────────────────────
//  Customer
// ─────────────────────────────────────────────────────────────────────────
interface CustomerOrderRow {
  id?: string
  name?: string
  totalPrice?: { amount?: string; currencyCode?: string }
  market?: string | null
}

export const CustomerPanel: Component<BasePanelProps> = (props) => {
  const data = usePanelData("customers_get", props)
  const shop = useResolvedShop(props)
  return (
    <PanelShell testid="customer-panel">
      <Show when={data()} fallback={<PanelLoading testid="customer-panel-loading" />}>
        {(_d) => {
          const d = _d() as Record<string, unknown>
          const orders = (d.orders as CustomerOrderRow[] | undefined) ?? []
          const tags = ((d.tags as string | undefined) ?? "")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
          return (
            <>
              <PanelHeader
                title={(d.displayName as string) ?? (d.email as string) ?? `Customer ${props.id}`}
                subtitle={d.email ? String(d.email) : null}
                market={(d.market as string | null | undefined) ?? null}
                currency={(d.currency as string | null | undefined) ?? null}
              />

              <Show when={tags.length > 0}>
                <div data-testid="customer-tags" class="flex flex-wrap gap-1.5">
                  <For each={tags}>{(t) => <Chip tone="accent">{t}</Chip>}</For>
                </div>
              </Show>

              <Show when={d.note}>
                <Section title="Note">
                  <p
                    data-testid="customer-note"
                    class="rounded-md border border-border bg-surface px-3 py-2 text-xs italic text-text-secondary"
                  >
                    {String(d.note)}
                  </p>
                </Section>
              </Show>

              <Show when={orders.length > 0}>
                <Section title={`Recent orders (${orders.length})`}>
                  <ul
                    data-testid="customer-orders"
                    class="flex flex-col divide-y divide-border-subtle rounded-md border border-border bg-surface"
                  >
                    <For each={orders}>
                      {(o) => (
                        <li class="flex items-baseline justify-between gap-3 px-3 py-2 text-xs">
                          <div class="min-w-0">
                            <p class="truncate font-mono text-text">{o.name ?? o.id}</p>
                            <Show when={o.market}>
                              <p class="mt-0.5 text-[11px] text-text-tertiary">{o.market}</p>
                            </Show>
                          </div>
                          <Show when={o.totalPrice?.amount}>
                            <span class="shrink-0 font-mono text-text">
                              {o.totalPrice?.amount}{" "}
                              <span class="text-text-tertiary">{o.totalPrice?.currencyCode}</span>
                            </span>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Section>
              </Show>

              <ExternalLink entity="customer" shop={shop} id={props.id} />
            </>
          )
        }}
      </Show>
    </PanelShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────
//  Product
// ─────────────────────────────────────────────────────────────────────────
interface ProductVariant {
  id?: string
  sku?: string | null
  title?: string | null
  price?: string
  inventoryQuantity?: number
  market?: string | null
}

interface ProductMedia {
  url?: string
  alt?: string | null
}

interface ProductMarketPrice {
  market: string
  amount: string
  currencyCode?: string
}

export const ProductPanel: Component<BasePanelProps> = (props) => {
  const data = usePanelData("products_get", props)
  const shop = useResolvedShop(props)
  return (
    <PanelShell testid="product-panel">
      <Show when={data()} fallback={<PanelLoading testid="product-panel-loading" />}>
        {(_d) => {
          const d = _d() as Record<string, unknown>
          const variants = (d.variants as ProductVariant[] | undefined) ?? []
          const media = (d.media as ProductMedia[] | undefined) ?? []
          const marketPrices = (d.marketPrices as ProductMarketPrice[] | undefined) ?? []
          return (
            <>
              <PanelHeader
                title={(d.title as string) ?? `Product ${props.id}`}
                market={(d.market as string | null | undefined) ?? null}
                currency={(d.currency as string | null | undefined) ?? null}
                status={(d.status as string | undefined) ?? null}
              />

              <Show when={media.length > 0}>
                <div
                  data-testid="product-media"
                  class="grid grid-cols-3 gap-1.5"
                >
                  <For each={media}>
                    {(m) => (
                      <div class="aspect-square overflow-hidden rounded-md border border-border bg-surface">
                        <img src={m.url} alt={m.alt ?? ""} class="h-full w-full object-cover" />
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={marketPrices.length > 0}>
                <Section title="Pricing by market">
                  <ul
                    data-testid="product-market-prices"
                    class="flex flex-col divide-y divide-border-subtle rounded-md border border-border bg-surface"
                  >
                    <For each={marketPrices}>
                      {(p) => (
                        <li class="flex items-baseline justify-between gap-3 px-3 py-2 text-xs">
                          <Chip>{p.market}</Chip>
                          <span class="font-mono text-text">
                            {p.amount} <span class="text-text-tertiary">{p.currencyCode}</span>
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Section>
              </Show>

              <Show when={variants.length > 0}>
                <Section title={`Variants (${variants.length})`}>
                  <ul
                    data-testid="product-variants"
                    class="flex flex-col divide-y divide-border-subtle rounded-md border border-border bg-surface"
                  >
                    <For each={variants}>
                      {(v) => (
                        <li class="flex items-baseline justify-between gap-3 px-3 py-2 text-xs">
                          <div class="min-w-0">
                            <p class="truncate text-text">{v.title ?? v.sku ?? v.id}</p>
                            <Show when={v.inventoryQuantity != null}>
                              <p class="mt-0.5 text-[11px] text-text-tertiary">
                                stock {v.inventoryQuantity}
                              </p>
                            </Show>
                          </div>
                          <span class="shrink-0 font-mono text-text">{v.price}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Section>
              </Show>

              <ExternalLink entity="product" shop={shop} id={props.id} />
            </>
          )
        }}
      </Show>
    </PanelShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────
//  Draft order
// ─────────────────────────────────────────────────────────────────────────
export const DraftOrderPanel: Component<BasePanelProps> = (props) => {
  const data = usePanelData("draft_orders_get", props)
  const shop = useResolvedShop(props)
  return (
    <PanelShell testid="draft-order-panel">
      <Show when={data()} fallback={<PanelLoading testid="draft-order-panel-loading" />}>
        {(_d) => {
          const d = _d() as Record<string, unknown>
          const lineItems = (d.lineItems as OrderLineItem[] | undefined) ?? []
          const total = d.totalPrice as { amount?: string; currencyCode?: string } | undefined
          return (
            <>
              <PanelHeader
                title={`Draft ${(d.name as string) ?? `#${props.id}`}`}
                market={(d.market as string | null | undefined) ?? null}
                currency={total?.currencyCode ?? null}
                status={(d.status as string | undefined) ?? null}
              />

              <Show when={total?.amount}>
                <div
                  data-testid="draft-total"
                  class="rounded-md border border-border bg-surface p-3"
                >
                  <KeyValueRow
                    label="Total"
                    value={
                      <span class="font-mono text-sm">
                        {total?.amount}{" "}
                        <span class="text-text-tertiary">{total?.currencyCode}</span>
                      </span>
                    }
                  />
                </div>
              </Show>

              <Show when={lineItems.length > 0}>
                <Section title={`Line items (${lineItems.length})`}>
                  <ul
                    data-testid="draft-line-items"
                    class="flex flex-col divide-y divide-border-subtle rounded-md border border-border bg-surface"
                  >
                    <For each={lineItems}>
                      {(li) => (
                        <li class="flex items-baseline justify-between gap-3 px-3 py-2 text-xs">
                          <span class="truncate text-text">
                            <span class="text-text-tertiary">{li.quantity ?? 1} ×</span>{" "}
                            {li.title ?? "Item"}
                          </span>
                          <Show when={li.priceSet?.amount}>
                            <span class="shrink-0 font-mono text-text">
                              {li.priceSet?.amount}{" "}
                              <span class="text-text-tertiary">{li.priceSet?.currencyCode}</span>
                            </span>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Section>
              </Show>

              <ExternalLink entity="draftOrder" shop={shop} id={props.id} />
            </>
          )
        }}
      </Show>
    </PanelShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────
//  Return
// ─────────────────────────────────────────────────────────────────────────
interface ReturnLine {
  id?: string
  quantity?: number
  reason?: string | null
  title?: string | null
}

export const ReturnPanel: Component<BasePanelProps> = (props) => {
  const data = usePanelData("returns_get", props)
  const shop = useResolvedShop(props)
  return (
    <PanelShell testid="return-panel">
      <Show when={data()} fallback={<PanelLoading testid="return-panel-loading" />}>
        {(_d) => {
          const d = _d() as Record<string, unknown>
          const lines = (d.returnLineItems as ReturnLine[] | undefined) ?? []
          return (
            <>
              <PanelHeader
                title={`Return ${(d.name as string) ?? props.id}`}
                market={(d.market as string | null | undefined) ?? null}
                status={(d.status as string | undefined) ?? null}
              />
              <Show when={d.orderName}>
                <p data-testid="return-order-ref" class="text-xs text-text-secondary">
                  on order <span class="font-mono text-text">{String(d.orderName)}</span>
                </p>
              </Show>

              <Show when={lines.length > 0}>
                <Section title={`Items (${lines.length})`}>
                  <ul
                    data-testid="return-line-items"
                    class="flex flex-col divide-y divide-border-subtle rounded-md border border-border bg-surface"
                  >
                    <For each={lines}>
                      {(l) => (
                        <li class="flex items-baseline justify-between gap-3 px-3 py-2 text-xs">
                          <span class="truncate text-text">
                            <span class="text-text-tertiary">{l.quantity ?? 1} ×</span>{" "}
                            {l.title ?? l.id}
                          </span>
                          <Show when={l.reason}>
                            <Chip tone="warning">{l.reason}</Chip>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Section>
              </Show>

              <ExternalLink entity="return" shop={shop} id={props.id} />
            </>
          )
        }}
      </Show>
    </PanelShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────
//  Refund
// ─────────────────────────────────────────────────────────────────────────
interface RefundTransaction {
  amount?: string
  currency?: string
  kind?: string
}

interface RefundLine {
  id?: string
  quantity?: number
  restocked?: boolean
  title?: string | null
}

export const RefundPanel: Component<RefundPanelProps> = (props) => {
  const data = usePanelData("refunds_get", props, { orderId: props.orderId })
  const shop = useResolvedShop(props)
  return (
    <PanelShell testid="refund-panel">
      <Show when={data()} fallback={<PanelLoading testid="refund-panel-loading" />}>
        {(_d) => {
          const d = _d() as Record<string, unknown>
          const txns = (d.transactions as RefundTransaction[] | undefined) ?? []
          const lines = (d.refundLineItems as RefundLine[] | undefined) ?? []
          const total = d.totalPrice as { amount?: string; currencyCode?: string } | undefined
          return (
            <>
              <PanelHeader
                title={`Refund ${props.id}`}
                subtitle={props.orderId ? `on order ${props.orderId}` : null}
                market={(d.market as string | null | undefined) ?? null}
                currency={total?.currencyCode ?? null}
              />

              <Show when={total?.amount}>
                <div
                  data-testid="refund-total"
                  class="rounded-md border border-warning-border bg-warning-glow p-3"
                >
                  <KeyValueRow
                    label="Total refunded"
                    value={
                      <span class="font-mono text-sm text-warning">
                        {total?.amount}{" "}
                        <span class="text-text-tertiary">{total?.currencyCode}</span>
                      </span>
                    }
                  />
                </div>
              </Show>

              <Show when={d.note}>
                <Section title="Note">
                  <p
                    data-testid="refund-note"
                    class="rounded-md border border-border bg-surface px-3 py-2 text-xs italic text-text-secondary"
                  >
                    {String(d.note)}
                  </p>
                </Section>
              </Show>

              <Show when={txns.length > 0}>
                <Section title="Transactions">
                  <ul
                    data-testid="refund-transactions"
                    class="flex flex-col divide-y divide-border-subtle rounded-md border border-border bg-surface"
                  >
                    <For each={txns}>
                      {(t) => (
                        <li class="flex items-baseline justify-between gap-3 px-3 py-2 text-xs">
                          <Chip>{t.kind ?? "payment"}</Chip>
                          <span class="font-mono text-text">
                            {t.amount} <span class="text-text-tertiary">{t.currency}</span>
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Section>
              </Show>

              <Show when={lines.length > 0}>
                <Section title={`Line items (${lines.length})`}>
                  <ul
                    data-testid="refund-line-items"
                    class="flex flex-col divide-y divide-border-subtle rounded-md border border-border bg-surface"
                  >
                    <For each={lines}>
                      {(l) => (
                        <li class="flex items-baseline justify-between gap-3 px-3 py-2 text-xs">
                          <span class="truncate text-text">
                            <span class="text-text-tertiary">{l.quantity ?? 1} ×</span>{" "}
                            {l.title ?? l.id}
                          </span>
                          <Show when={l.restocked}>
                            <Chip tone="success">restocked</Chip>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Section>
              </Show>

              <ExternalLink
                entity="refund"
                shop={shop}
                id={props.id}
                orderId={props.orderId}
              />
            </>
          )
        }}
      </Show>
    </PanelShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────
//  Market
// ─────────────────────────────────────────────────────────────────────────
interface MarketRegion {
  code?: string
  name?: string
}

export const MarketPanel: Component<BasePanelProps> = (props) => {
  const data = usePanelData("markets_get", props)
  const shop = useResolvedShop(props)
  return (
    <PanelShell testid="market-panel">
      <Show when={data()} fallback={<PanelLoading testid="market-panel-loading" />}>
        {(_d) => {
          const d = _d() as Record<string, unknown>
          const regions = (d.regions as MarketRegion[] | undefined) ?? []
          return (
            <>
              <PanelHeader
                title={(d.name as string) ?? `Market ${props.id}`}
                currency={(d.currency as string | null | undefined) ?? null}
                status={
                  (d.enabled as boolean | undefined) === false ? "disabled" : "active"
                }
              />

              <Show when={regions.length > 0}>
                <Section title={`Regions (${regions.length})`}>
                  <ul
                    data-testid="market-regions"
                    class="flex flex-wrap gap-1.5"
                  >
                    <For each={regions}>
                      {(r) => (
                        <li>
                          <Chip>
                            <span class="font-mono text-[10px]">{r.code}</span>
                            <span class="ml-1.5 text-text">{r.name}</span>
                          </Chip>
                        </li>
                      )}
                    </For>
                  </ul>
                </Section>
              </Show>

              <ExternalLink entity="market" shop={shop} id={props.id} />
            </>
          )
        }}
      </Show>
    </PanelShell>
  )
}
