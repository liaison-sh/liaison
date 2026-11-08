// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify Home — the landing tab when the operator clicks the Shopify activity
// bar entry. Two stacked sections inside the kernel's scrollable tab content
// area:
//
//   ATTENTION  — items that need a human: low inventory, unfulfilled orders
//                past SLA, pending returns. Categories with zero items are
//                hidden entirely so the page stays calm. Each row leads with
//                a tiny tone-colored bar (red/amber) so the eye picks it up
//                without the design relying on icons.
//
//   RECENT     — last 20 orders. Tabular numerals, calm hairline rows. The
//   ORDERS       section header carries an "Open in Shopify ↗" anchor so
//                the operator can pivot to the Shopify admin if the kernel
//                doesn't expose the lever they need.
//
// All data flows through the host bridge (`app.invokeTool`). Loading + empty
// states stay tertiary-toned so they recede into the layout rather than
// shouting.
import { type Component } from "solid-js"
import { app } from "@liaison/host"
import { adminResourceId } from "./panels/url-template"
import { formatHoursHuman, formatShopifyMoney, statusLabel } from "./list-helpers"
import { CardTable } from "@liaison/app-ui/card-table"
import { Chip, Empty, For, Section, Show, StatusPill } from "./primitives"
import { onOutsideLinkClick, openOutside } from "./external-link"

interface ConnectionSnapshot {
  shopDomain: string | null
}

interface AttentionLowInventoryItem {
  variantId: string
  productId: string
  productTitle: string
  variantTitle?: string | null
  sku?: string | null
  inventoryQuantity: number
  threshold: number
  location?: string | null
}

interface AttentionUnfulfilledOrderItem {
  orderId: string
  name: string
  customer?: { displayName?: string | null; email?: string | null } | null
  placedAt: string
  hoursSincePlaced: number
  totalPrice?: { amount?: string; currencyCode?: string } | null
}

interface AttentionPendingReturnItem {
  returnId: string
  orderName: string
  reason?: string | null
  requestedAt: string
}

interface AttentionBundle {
  lowInventory: AttentionLowInventoryItem[]
  unfulfilledOrders: AttentionUnfulfilledOrderItem[]
  pendingReturns: AttentionPendingReturnItem[]
}

interface RecentOrderRow {
  id: string
  name: string
  customer?: { displayName?: string | null; email?: string | null } | null
  market?: string | null
  totalPrice?: { amount?: string; currencyCode?: string } | null
  fulfillmentStatus?: string | null
  placedAt?: string | null
}

interface RecentOrdersBundle {
  orders: RecentOrderRow[]
}

interface HomeBundle {
  connection: ConnectionSnapshot
  attention: AttentionBundle
  recentOrders: RecentOrdersBundle
}

function relativeTime(iso?: string | null): string {
  if (!iso) return ""
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ""
  const diff = Date.now() - t
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return "1d"
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  return `${weeks}w`
}

// Build a Shopify admin deep link, or `null` when the shop domain is unknown —
// callers must NOT render a link in that case. The previous `?? "admin"`
// fallback produced the broken `https://admin/admin/orders` (a bare "admin"
// host) whenever the domain was missing (e.g. a connected-but-uninitialised
// install with no install_metadata). Normalise away any scheme/path so a stored
// `https://x.myshopify.com/…` can't double up.
function shopifyAdminUrl(shopDomain: string | null | undefined, path = ""): string | null {
  const host = shopDomain
    ?.trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
  if (!host) return null
  return `https://${host}/admin${path}`
}

// ─────────────────────────────────────────────────────────────────────────
// AttentionRow — a single attention item. The tone-colored leading bar is
// the design's strongest semantic affordance: red for stock-out risk,
// amber for late fulfillment, muted for awaiting-action returns. The row
// itself stays neutral so a long list reads as a calm column with periodic
// urgency cues rather than a wall of color.
// ─────────────────────────────────────────────────────────────────────────
function AttentionRow(props: {
  tone: "danger" | "warning" | "muted"
  title: string
  meta?: string | null
  trailing?: string | null
  href?: string | null
}) {
  const bar =
    props.tone === "danger"
      ? "bg-error"
      : props.tone === "warning"
        ? "bg-warning"
        : "bg-border-strong"
  // Absolute hrefs (the Shopify admin — orders have no in-app detail view)
  // open in a new browser tab through the host (a framed screen has no popups);
  // app-relative ones stay in-app.
  const isExternal = () => Boolean(props.href?.startsWith("http"))
  return (
    <a
      href={props.href ?? "#"}
      target={isExternal() ? "_blank" : undefined}
      rel={isExternal() ? "noopener noreferrer" : undefined}
      class="group grid grid-cols-[2px_1fr_auto] items-center gap-3 rounded-md border border-border-subtle bg-surface px-3 py-2 transition-colors hover:border-border hover:bg-surface-hover"
      onClick={(e) => {
        if (!props.href) e.preventDefault()
        else if (isExternal()) onOutsideLinkClick(e, props.href)
      }}
    >
      <span class={`h-full min-h-[1.5rem] w-[2px] rounded-full ${bar}`} aria-hidden="true" />
      <span class="min-w-0">
        <span class="block truncate text-[13px] text-text">{props.title}</span>
        <Show when={props.meta}>
          <span class="mt-0.5 block truncate text-[11px] text-text-tertiary">{props.meta}</span>
        </Show>
      </span>
      <Show when={props.trailing}>
        <span class="font-mono text-[11px] tabular-nums text-text-tertiary">{props.trailing}</span>
      </Show>
    </a>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// AttentionCategory — section grouping with a soft hairline divider above.
// Renders nothing when the category is empty (per the brief).
// ─────────────────────────────────────────────────────────────────────────
function AttentionCategory(props: {
  title: string
  count: number
  testid?: string
  children: any
}) {
  return (
    <Show when={props.count > 0}>
      <div data-testid={props.testid} class="flex flex-col gap-1.5">
        <div class="flex items-baseline justify-between">
          <h3 class="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
            {props.title}
          </h3>
          <span class="font-mono text-[11px] tabular-nums text-text-tertiary">{props.count}</span>
        </div>
        <div class="flex flex-col gap-1">{props.children}</div>
      </div>
    </Show>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// RecentOrdersTable — last 20 orders. Five columns: order # | customer |
// market | total | status. Row click opens the Shopify admin order page in a
// new browser tab (there is no in-app order detail view — the admin page is
// strictly richer). The header is a thin uppercase eyebrow with a discreet
// external-Shopify anchor on the right.
// ─────────────────────────────────────────────────────────────────────────
function RecentOrdersTable(props: { orders: RecentOrderRow[]; shopDomain: string | null }) {
  function openOrderUrl(id: string): string | null {
    return shopifyAdminUrl(props.shopDomain, `/orders/${adminResourceId(id)}`)
  }
  return (
    <div class="overflow-hidden rounded-md border border-border bg-surface">
      <div class="flex items-baseline justify-between border-b border-border-subtle px-4 py-3">
        <div class="flex items-baseline gap-2">
          <h2 class="text-sm font-medium text-text">Recent orders</h2>
          <span class="font-mono text-[11px] tabular-nums text-text-tertiary">
            {props.orders.length}
          </span>
        </div>
        <Show when={shopifyAdminUrl(props.shopDomain, "/orders")}>
          {(href) => (
            <a
              href={href()}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => onOutsideLinkClick(e, href())}
              data-testid="home-open-shopify-orders"
              class="rounded-sm px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
            >
              Open in Shopify ↗
            </a>
          )}
        </Show>
      </div>

      <Show
        when={props.orders.length > 0}
        fallback={<Empty testid="recent-orders-empty">No orders yet.</Empty>}
      >
        <CardTable
          rows={props.orders}
          rowKey={(o) => o.id}
          rowTestid={(o) => `home-recent-order-row-${o.id}`}
          columns={[
            {
              key: "order",
              header: "Order",
              role: "anchor",
              cell: (o) => o.name,
            },
            {
              key: "customer",
              header: "Customer",
              role: "secondary",
              cell: (o) => (
                <span class="block truncate text-text">
                  {o.customer?.displayName ?? o.customer?.email ?? (
                    <span class="text-text-tertiary">guest</span>
                  )}
                </span>
              ),
            },
            {
              key: "total",
              header: "Total",
              role: "meta",
              align: "right",
              numeric: true,
              cell: (o) => (
                <Show
                  when={o.totalPrice?.amount}
                  fallback={<span class="text-text-tertiary">-</span>}
                >
                  {o.totalPrice?.amount}
                  <span class="ml-1 text-text-tertiary">{o.totalPrice?.currencyCode}</span>
                </Show>
              ),
            },
            {
              key: "status",
              header: "Status",
              role: "meta",
              cell: (o) => (
                <Show when={o.fulfillmentStatus} fallback={<Chip>{statusLabel("unfulfilled")}</Chip>}>
                  <StatusPill status={o.fulfillmentStatus ?? null} />
                </Show>
              ),
            },
            {
              key: "when",
              header: "When",
              role: "meta",
              align: "right",
              cell: (o) => (
                <span class="font-mono text-[11px] tabular-nums text-text-tertiary">
                  {relativeTime(o.placedAt)}
                </span>
              ),
            },
          ]}
          onRowClick={(o) => {
            const href = openOrderUrl(o.id)
            openOutside(href)
          }}
        />
      </Show>
    </div>
  )
}

function HomeSkeleton() {
  return (
    <div class="flex flex-col gap-6" aria-hidden="true">
      <div class="h-16 animate-pulse rounded-md border border-border bg-surface" />
      <div class="h-48 animate-pulse rounded-md border border-border bg-surface" />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ShopifyHome — exposed via manifest `views.tabTypes.home.component`.
// ─────────────────────────────────────────────────────────────────────────
export const ShopifyHome: Component = () => {
  const [bundle] = app.createResource<HomeBundle>(() =>
    app.invokeTool<HomeBundle>("home_load", {}),
  )

  const shopDomain = () => bundle()?.connection.shopDomain ?? null
  const totalAttention = () => {
    const a = bundle()?.attention
    if (!a) return 0
    return a.lowInventory.length + a.unfulfilledOrders.length + a.pendingReturns.length
  }

  return (
    <section
      data-testid="shopify-home"
      class="flex min-h-full flex-col gap-6 bg-bg p-6 text-sm text-text"
    >
      <header class="flex items-baseline justify-between">
        <div class="flex flex-col gap-0.5">
          <h1 class="text-base font-semibold text-text">Shopify</h1>
          <p class="text-[12px] text-text-secondary">
            <Show
              when={shopDomain()}
              fallback={<span class="text-text-tertiary">Not connected.</span>}
            >
              {shopDomain()}
            </Show>
          </p>
        </div>
        <Show when={shopifyAdminUrl(shopDomain())}>
          {(href) => (
            <a
              href={href()}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => onOutsideLinkClick(e, href())}
              data-testid="home-open-shopify-admin"
              class="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-accent-border hover:bg-accent-subtle hover:text-accent"
            >
              Open admin ↗
            </a>
          )}
        </Show>
      </header>

      <Show when={bundle()} fallback={<HomeSkeleton />}>
        {(b) => (
          <>
            {/* Attention */}
            <Section title={`Attention ${totalAttention() > 0 ? `(${totalAttention()})` : ""}`}>
              <Show
                when={totalAttention() > 0}
                fallback={
                  <Empty testid="attention-empty">
                    Nothing needs your attention right now.
                  </Empty>
                }
              >
                <div class="flex flex-col gap-4">
                  <AttentionCategory
                    title="Low inventory"
                    count={b().attention.lowInventory.length}
                    testid="attention-low-inventory"
                  >
                    <For each={b().attention.lowInventory}>
                      {(item) => (
                        <AttentionRow
                          tone="danger"
                          title={`${item.productTitle}${item.variantTitle ? `: ${item.variantTitle}` : ""}`}
                          meta={[item.sku, item.location].filter(Boolean).join(" · ")}
                          trailing={`${item.inventoryQuantity}/${item.threshold}`}
                          href={`/detail/shopify/product/${encodeURIComponent(item.productId)}`}
                        />
                      )}
                    </For>
                  </AttentionCategory>

                  <AttentionCategory
                    title="Unfulfilled past SLA"
                    count={b().attention.unfulfilledOrders.length}
                    testid="attention-unfulfilled"
                  >
                    <For each={b().attention.unfulfilledOrders}>
                      {(o) => (
                        <AttentionRow
                          tone="warning"
                          title={`${o.name}${o.customer?.displayName ? `: ${o.customer.displayName}` : ""}`}
                          meta={
                            o.totalPrice?.amount
                              ? `${formatShopifyMoney(o.totalPrice.amount, o.totalPrice.currencyCode)} ${o.totalPrice.currencyCode ?? ""}`.trim()
                              : null
                          }
                          trailing={formatHoursHuman(o.hoursSincePlaced)}
                          href={shopifyAdminUrl(shopDomain(), `/orders/${adminResourceId(o.orderId)}`)}
                        />
                      )}
                    </For>
                  </AttentionCategory>

                  <AttentionCategory
                    title="Pending returns"
                    count={b().attention.pendingReturns.length}
                    testid="attention-returns"
                  >
                    <For each={b().attention.pendingReturns}>
                      {(r) => (
                        <AttentionRow
                          tone="muted"
                          title={`${r.orderName}${r.reason ? `: ${r.reason.replace(/_/g, " ")}` : ""}`}
                          meta={null}
                          trailing={relativeTime(r.requestedAt)}
                          href={`/detail/shopify/return/${encodeURIComponent(r.returnId)}`}
                        />
                      )}
                    </For>
                  </AttentionCategory>
                </div>
              </Show>
            </Section>

            {/* Recent orders */}
            <RecentOrdersTable orders={b().recentOrders.orders} shopDomain={shopDomain()} />
          </>
        )}
      </Show>
    </section>
  )
}
