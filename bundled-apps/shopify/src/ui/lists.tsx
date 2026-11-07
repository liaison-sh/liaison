// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify list views — Orders / Customers / Products / Markets.
//
// Each list view is a thin wrapper around the shared `ListView` shell:
//   - Header with section title, count, and "Open in Shopify ↗" anchor
//   - Single-line search (debounced) that re-issues the search tool
//   - Calm hairline-row table; click → opens the corresponding detail tab.
//     EXCEPTION: orders have no in-app detail page (it was removed — the
//     Shopify admin order page is strictly richer); an order row click opens
//     the admin page in a new browser tab instead.
//
// Orders is the one list that isn't single-tool: it merges `orders_search`
// (every financial state, including cancelled/refunded) with
// `draft_orders_list` into one chronological table, with a segmented row of
// filter chips (All/Open/Unfulfilled/Cancelled/Refunded/Drafts) over the
// merge, plus best-effort per-row invoice links via `orders_invoice_links`.
// See the `ShopifyOrdersList` section below for the merge/filter/link logic.
//
// The other three lists call the bundle's existing read tools through
// `app.invokeTool` with no per-list custom data shape — each tool already
// returns `{ results: NormalizedHit[], nextCursor }`, and `NormalizedHit`
// carries `id / entity / title / market / currency / attributes`. The shell
// renders the right column projection per entity below.
//
// Design: same density + token palette as the Home recent-orders table so
// drilling sideways from Home into a section feels continuous, not like
// stepping into a different app.
import { createResource, createSignal, onCleanup, type Component } from "solid-js"
import { app, navigate, onEntityChange } from "@liaison/host"
import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import {
  cartMoreLabel,
  cartSummary,
  formatListDate,
  lineSkus,
  listCountLabel,
  normOrderStatus,
  ORDER_COLUMNS,
  ORDER_FILTERS,
  orderHasItemsToShip,
  orderMatchesFilter,
  orderTags,
  statusLabel,
  type ListColumn,
  type OrderFilterKey,
  type OrderLineLike,
} from "./list-helpers"
import { adminOrderUrl, adminResourceId } from "./panels/url-template"
import { Chip, Empty, For, Show, StatusPill, useShopDomain } from "./primitives"
import { onOutsideLinkClick, openOutside } from "./external-link"

// ─────────────────────────────────────────────────────────────────────────
// Shared types — the bundle's read tools return a uniform NormalizedHit.
// ─────────────────────────────────────────────────────────────────────────
interface NormalizedHit {
  id: string
  entity: string
  title: string
  market?: string | null
  currency?: string | null
  attributes?: Record<string, unknown>
}

interface SearchResult {
  results: NormalizedHit[]
  nextCursor?: string | null
}

// ─────────────────────────────────────────────────────────────────────────
// shopifyAdminUrl — same helper used in home.tsx; duplicated here so the
// lists are self-contained and don't reach across files for a one-liner.
// ─────────────────────────────────────────────────────────────────────────
// Returns `null` when the shop domain is unknown — the caller then renders NO
// link (guarding against the old `?? "admin"` bug that emitted the broken
// `https://admin/admin/orders`). Mirrors home.tsx's helper.
function shopifyAdminUrl(shopDomain: string | null | undefined, path: string): string | null {
  const host = shopDomain
    ?.trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
  if (!host) return null
  return `https://${host}/admin${path}`
}

// Shopify-admin DRAFT order URL for the given stored connection domain +
// draft order id (GID or numeric). Mirrors `adminOrderUrl` from
// `./panels/url-template` but for the `/admin/draft_orders/<id>` path — draft
// orders have their own admin route, distinct from placed orders. Returns
// null while the shop domain is still unknown so callers can render a dead
// row rather than a wrong-domain link.
function adminDraftOrderUrl(shopDomain: string | null | undefined, id: string): string | null {
  return shopifyAdminUrl(shopDomain, `/draft_orders/${adminResourceId(id)}`)
}

// Shopify search/connection read tools page in fixed windows. We request this
// many rows per list query; if the tool reports a `nextCursor` we know there
// are more rows than fit in one page and render the count as "N+".
const SEARCH_PAGE_SIZE = 50

// `useShopDomain` lives in ./primitives (backed by the coalesced `loadShopDomain`
// probe in ./list-helpers) so the home tab, list views, and detail panels all
// share ONE home_load round-trip (the N+1 the deep review flagged). `listCountLabel`
// lives in ./list-helpers too — both are imported above.

// ─────────────────────────────────────────────────────────────────────────
// ListShell — header + search + table frame.
// ─────────────────────────────────────────────────────────────────────────
function ListShell(props: {
  testid: string
  title: string
  count: string | null
  shopDomain: string | null | undefined
  shopifyPath: string
  searchPlaceholder: string
  query: string
  onQuery: (q: string) => void
  loading: boolean
  empty: boolean
  emptyMessage: string
  children: any
}) {
  return (
    <section
      data-testid={props.testid}
      class="flex min-h-full flex-col gap-4 bg-bg p-6 text-sm text-text"
    >
      {/* Title row */}
      <header class="flex items-baseline justify-between gap-3">
        <div class="flex items-baseline gap-2">
          <h1 class="text-base font-semibold text-text">{props.title}</h1>
          <Show when={props.count !== null}>
            <span class="font-mono text-[11px] tabular-nums text-text-tertiary">
              {props.count}
            </span>
          </Show>
        </div>
        <Show when={shopifyAdminUrl(props.shopDomain, props.shopifyPath)}>
          {(href) => (
            <a
              href={href()}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => onOutsideLinkClick(e, href())}
              data-testid={`${props.testid}-open-in-shopify`}
              class="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-accent-border hover:bg-accent-subtle hover:text-accent"
            >
              Open in Shopify ↗
            </a>
          )}
        </Show>
      </header>

      {/* Search */}
      <label class="flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-3 py-1.5 transition-colors focus-within:border-border focus-within:bg-elevated">
        <SearchIcon />
        <input
          type="text"
          data-testid={`${props.testid}-search`}
          placeholder={props.searchPlaceholder}
          class="w-full bg-transparent text-[12.5px] text-text outline-none placeholder:text-text-tertiary"
          value={props.query}
          onInput={(e) => props.onQuery(e.currentTarget.value)}
        />
      </label>

      {/* Body */}
      <Show
        when={!props.loading}
        fallback={<Empty testid={`${props.testid}-loading`}>Loading…</Empty>}
      >
        <Show
          when={!props.empty}
          fallback={
            <Empty testid={`${props.testid}-empty`}>{props.emptyMessage}</Empty>
          }
        >
          <div class="overflow-hidden rounded-md border border-border bg-surface">
            {props.children}
          </div>
        </Show>
      </Show>
    </section>
  )
}

function SearchIcon() {
  return (
    <svg
      class="h-3.5 w-3.5 shrink-0 text-text-tertiary"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  )
}

function openDetailUrl(entity: string, id: string): string {
  return `/detail/shopify/${entity}/${encodeURIComponent(id)}`
}

function onRowClick(href: string, e: MouseEvent): void {
  if (e.metaKey || e.ctrlKey) {
    // Cmd/Ctrl-click opens a genuine new browser tab — that is a deliberate
    // browser-level action, not in-app SPA navigation.
    window.open(href, "_blank", "noopener,noreferrer")
  } else {
    navigate(href)
  }
}

// Tiny helper for the "search-then-render" pattern shared by all four lists.
// Returns the loaded rows plus `hasMore` (derived from the tool's nextCursor)
// so the header can render an honest "N+" count rather than the page size.
interface SearchState<T> {
  results: T[]
  hasMore: boolean
}
function useSearch<T>(toolName: string, project: (raw: unknown) => T[]) {
  const [query, setQuery] = createSignal("")
  const [debouncedQuery, setDebouncedQuery] = createSignal("")
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  function onQuery(q: string): void {
    setQuery(q)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => setDebouncedQuery(q), 250)
  }
  // A pending debounce timer outlives the component if the user navigates away
  // mid-type; clear it on unmount so the stale callback can't fire setDebouncedQuery
  // (a no-op on a disposed scope, but still a leak + a console warning in dev).
  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
  })
  const [results, { refetch }] = createResource<SearchState<T>, string>(debouncedQuery, async (q) => {
    const raw = await app.invokeTool(toolName, {
      query: q || undefined,
      limit: SEARCH_PAGE_SIZE,
    })
    const r = raw as { nextCursor?: string | null }
    return { results: project(raw), hasMore: Boolean(r?.nextCursor) }
  })
  return { query, onQuery, results, refetch, debouncedQuery }
}

// A second tool fetch driven by an ALREADY-debounced query signal owned by
// another `useSearch` instance — used by ShopifyOrdersList so `orders_search`
// and `draft_orders_list` re-issue together on the same debounced keystroke
// instead of each list view getting its own independent (and, for drafts,
// unwired) search box.
function useCoDebouncedSearch<T>(
  toolName: string,
  debouncedQuery: () => string,
  project: (raw: unknown) => T[],
) {
  const [results, { refetch }] = createResource<SearchState<T>, string>(debouncedQuery, async (q) => {
    const raw = await app.invokeTool(toolName, {
      query: q || undefined,
      limit: SEARCH_PAGE_SIZE,
    })
    const r = raw as { nextCursor?: string | null }
    return { results: project(raw), hasMore: Boolean(r?.nextCursor) }
  })
  return { results, refetch }
}

// ─────────────────────────────────────────────────────────────────────────
// ShopifyOrdersList — merged view over regular orders (every financial state,
// including cancelled + refunded) AND draft orders, in one table, with a
// segmented filter-chip row over the merge. This intentionally shows "basically
// everything" the store's Orders section would — a plain `orders_search` alone
// undercounts because Shopify treats drafts as a separate resource.
// ─────────────────────────────────────────────────────────────────────────
interface OrderRow {
  kind: "order" | "draft"
  id: string
  title: string
  customer: { displayName?: string; email?: string } | null
  currency: string | null
  totalAmount: string | null
  fulfillmentStatus: string | null
  financialStatus: string | null
  cancelledAt: string | null
  draftStatus: string | null
  sortAt: string | null
  tags: string[]
  lineItems: OrderLineLike[]
  /** The order's own "requires shipping" (every line); null when unknown. */
  requiresShipping: boolean | null
  /** More lines than the fetched ones. */
  lineItemsMore: boolean
  /** The order's whole current item count; null when unknown. */
  itemsQuantity: number | null
}

function projectLineItems(raw: unknown): OrderLineLike[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((li): li is Record<string, unknown> => li !== null && typeof li === "object")
    .map((li) => ({
      sku: typeof li.sku === "string" ? li.sku : null,
      title: typeof li.title === "string" ? li.title : null,
      quantity: typeof li.quantity === "number" ? li.quantity : null,
      currentQuantity: typeof li.currentQuantity === "number" ? li.currentQuantity : null,
      requiresShipping: typeof li.requiresShipping === "boolean" ? li.requiresShipping : null,
    }))
}

interface InvoiceLink {
  order_id: string
  invoice_id: string
  number: string | null
  type: string
  scope: string | null
  status: string
  payment_status: string
}

function projectOrderRow(o: NormalizedHit): OrderRow {
  const customer = (o.attributes?.customer ?? null) as
    | { displayName?: string; email?: string }
    | null
  const currency = (o.currency ?? o.attributes?.shopCurrency ?? null) as string | null
  const sortAt = (o.attributes?.processedAt ?? o.attributes?.createdAt ?? null) as string | null
  return {
    kind: "order",
    id: o.id,
    title: o.title,
    customer,
    currency,
    totalAmount: (o.attributes?.totalAmount ?? null) as string | null,
    fulfillmentStatus: (o.attributes?.fulfillmentStatus ?? null) as string | null,
    financialStatus: (o.attributes?.financialStatus ?? null) as string | null,
    cancelledAt: (o.attributes?.cancelledAt ?? null) as string | null,
    draftStatus: null,
    sortAt,
    tags: orderTags(Array.isArray(o.attributes?.tags) ? (o.attributes.tags as string[]) : []),
    lineItems: projectLineItems(o.attributes?.lineItems),
    requiresShipping: typeof o.attributes?.requiresShipping === "boolean" ? o.attributes.requiresShipping : null,
    lineItemsMore: o.attributes?.lineItemsMore === true,
    itemsQuantity: typeof o.attributes?.itemsQuantity === "number" ? o.attributes.itemsQuantity : null,
  }
}

function projectDraftRow(d: NormalizedHit): OrderRow {
  const customer = (d.attributes?.customer ?? null) as
    | { displayName?: string; email?: string }
    | null
  return {
    kind: "draft",
    id: d.id,
    title: d.title,
    customer,
    currency: (d.currency ?? null) as string | null,
    totalAmount: (d.attributes?.totalAmount ?? null) as string | null,
    fulfillmentStatus: null,
    financialStatus: null,
    cancelledAt: null,
    draftStatus: (d.attributes?.status ?? null) as string | null,
    sortAt: (d.attributes?.createdAt ?? null) as string | null,
    tags: [],
    lineItems: [],
    requiresShipping: null,
    lineItemsMore: false,
    itemsQuantity: null,
  }
}

// Regular-order financial states worth a chip. Shopify returns the financial
// status UPPERCASE ("PAID" / "REFUNDED" / "PARTIALLY_REFUNDED"), so normalize
// before matching (a raw-value compare would never fire on real store data).
function financialStateChip(financialStatus: string | null) {
  const fin = normOrderStatus(financialStatus)
  if (fin === "refunded") return { label: "Refunded", tone: "danger" as const }
  if (fin === "partially_refunded") return { label: "Partial refund", tone: "warning" as const }
  if (fin === "paid") return { label: "Paid", tone: "success" as const }
  return null
}

export const ShopifyOrdersList: Component = () => {
  const shopDomain = useShopDomain()
  const [filter, setFilter] = createSignal<OrderFilterKey>("all")
  // "Has items to ship" narrows whichever status chip is active (Unfulfilled +
  // Has items to ship = the orders with a parcel still to send).
  const [shippableOnly, setShippableOnly] = createSignal(false)

  const {
    query,
    onQuery,
    results: orderResults,
    refetch: refetchOrders,
    debouncedQuery,
  } = useSearch<NormalizedHit>("orders_search", (raw) => (raw as SearchResult)?.results ?? [])
  // Drafts re-issue on the SAME debounced query as orders (not their own
  // independent debounce) — there's only one search box on this list.
  const { results: draftResults, refetch: refetchDrafts } = useCoDebouncedSearch<NormalizedHit>(
    "draft_orders_list",
    debouncedQuery,
    (raw) => (raw as SearchResult)?.results ?? [],
  )

  // Merge orders + drafts, sorted chronologically (newest first) so the table
  // reads as one continuous timeline rather than two stacked blocks.
  const mergedRows = () => {
    const orders = (orderResults()?.results ?? []).map(projectOrderRow)
    const drafts = (draftResults()?.results ?? []).map(projectDraftRow)
    return [...orders, ...drafts].sort((a, b) => {
      const at = a.sortAt ? new Date(a.sortAt).getTime() : 0
      const bt = b.sortAt ? new Date(b.sortAt).getTime() : 0
      return bt - at
    })
  }
  const filteredRows = () =>
    mergedRows().filter(
      (r) => orderMatchesFilter(r, filter()) && (!shippableOnly() || orderHasItemsToShip(r)),
    )
  // A live refetch (an order came in or changed) keeps the rows on screen;
  // only a first load or a new search shows "Loading…".
  const [live, setLive] = createSignal(false)
  const loading = () => !live() && (orderResults.loading || draftResults.loading)
  // The list is a tab that stays mounted, so an order placed while it is open
  // (or hidden behind another tab) must arrive by itself: every order change
  // refetches the rows, except the invoice relay below, which only moves the
  // Invoice column.
  onEntityChange("shopify:order", (events) => {
    if (events.every((e) => e.action === "invoice_changed")) return
    setLive(true)
    void Promise.allSettled([refetchOrders(), refetchDrafts()]).finally(() => setLive(false))
  })

  // Invoice links are best-effort and scoped to REGULAR order rows only —
  // fetched once the merged order set is known, bucketed by order_id so each
  // row can render its own pills. A failure (e.g. invoicing app not
  // installed) degrades to "no links" rather than breaking the list.
  //
  // They also refetch on every `shopify:order` change. An invoice is usually
  // issued seconds AFTER its order lands (the invoicing app reacts to the
  // order event), so the order-id set alone never moves when the link
  // appears. This UI may watch only its own keys, so the app's
  // `onInvoicingDocumentChanged` subscriber relays invoicing's document
  // events as `order:invoice_changed`, which lands here too.
  const orderGids = () => mergedRows().filter((r) => r.kind === "order").map((r) => r.id)
  const [invoiceLinks, { refetch: refetchInvoiceLinks }] = createResource(orderGids, async (ids) => {
    if (ids.length === 0) return new Map<string, InvoiceLink[]>()
    try {
      const res = await app.invokeTool<{ links: InvoiceLink[] }>("orders_invoice_links", {
        order_ids: ids,
      })
      const byOrder = new Map<string, InvoiceLink[]>()
      for (const link of res?.links ?? []) {
        const bucket = byOrder.get(link.order_id)
        if (bucket) bucket.push(link)
        else byOrder.set(link.order_id, [link])
      }
      return byOrder
    } catch {
      return new Map<string, InvoiceLink[]>()
    }
  })
  onEntityChange("shopify:order", () => void refetchInvoiceLinks())

  // Short codes for the cart summary: the org's product attributes, read by
  // SKU through this app's own `products_short_codes` tool. Best effort: a
  // failure leaves every line as "N×?" with its title on hover.
  const visibleSkus = () => lineSkus(mergedRows().flatMap((r) => r.lineItems)).sort().join("\n")
  const [shortCodes] = createResource(visibleSkus, async (joined) => {
    const skus = joined === "" ? [] : joined.split("\n")
    if (skus.length === 0) return {} as Record<string, string>
    try {
      const res = await app.invokeTool<{ codes?: Record<string, string> }>("products_short_codes", { skus })
      return res?.codes ?? {}
    } catch {
      return {} as Record<string, string>
    }
  })

  // One cell renderer per declared column key. The roles (anchor / secondary /
  // meta / fold) live in ORDER_COLUMNS, so the card layout at 390 px and the
  // table at 640 px+ are the same declaration read two ways.
  const orderCell = (key: string, o: OrderRow) => {
    if (key === "order") return o.title
    if (key === "customer") {
      return (
        <Show when={o.customer} fallback={<span class="text-text-tertiary">guest</span>}>
          <span class="truncate text-text">{o.customer?.displayName ?? o.customer?.email}</span>
        </Show>
      )
    }
    if (key === "total") {
      return (
        <Show when={o.totalAmount} fallback={<span class="text-text-tertiary">-</span>}>
          {o.totalAmount}
          <span class="ml-1 text-text-tertiary">{o.currency}</span>
        </Show>
      )
    }
    if (key === "status") {
      const stateChip = () => (o.kind === "order" ? financialStateChip(o.financialStatus) : null)
      return (
        <div class="flex flex-wrap items-center gap-1">
          <Show
            when={o.kind === "order"}
            fallback={
              <>
                <Chip>Draft</Chip>
                <Show when={o.draftStatus}>
                  <StatusPill status={o.draftStatus} />
                </Show>
              </>
            }
          >
            <Show when={o.fulfillmentStatus} fallback={<Chip>{statusLabel("unfulfilled")}</Chip>}>
              <StatusPill status={o.fulfillmentStatus} />
            </Show>
            <Show when={o.cancelledAt}>
              <Chip tone="danger">Cancelled</Chip>
            </Show>
            <Show when={!o.cancelledAt && stateChip()}>
              {(chip) => <Chip tone={chip().tone}>{chip().label}</Chip>}
            </Show>
          </Show>
        </div>
      )
    }
    if (key === "items") {
      const entries = () => cartSummary(o.lineItems, shortCodes.latest ?? {})
      const more = cartMoreLabel(o)
      return (
        <Show when={entries().length > 0 || more} fallback={<span class="text-text-tertiary">-</span>}>
          <span data-testid={`shopify-orders-cart-${o.id}`} class="font-mono text-[11.5px] text-text-secondary">
            <For each={entries()}>
              {(e, i) => (
                <>
                  <Show when={i() > 0}>{", "}</Show>
                  <span title={e.title} class={e.code ? undefined : "text-text-tertiary"}>
                    {e.label}
                  </span>
                </>
              )}
            </For>
            <Show when={more}>
              <span data-testid={`shopify-orders-cart-more-${o.id}`} class="text-text-tertiary">
                {entries().length > 0 ? ` ${more}` : more}
              </span>
            </Show>
          </span>
        </Show>
      )
    }
    if (key === "tags") {
      return (
        <Show when={o.tags.length > 0} fallback={<span class="text-text-tertiary">-</span>}>
          <div data-testid={`shopify-orders-tags-${o.id}`} class="flex flex-wrap items-center gap-1">
            <For each={o.tags}>{(t) => <Chip>{t}</Chip>}</For>
          </div>
        </Show>
      )
    }
    if (key === "date") {
      const when = formatListDate(o.sortAt)
      return when ? when : <span class="text-text-tertiary">-</span>
    }
    // invoice
    // `.latest` keeps the current pills on screen while a live refetch runs.
    const links = () => invoiceLinks.latest?.get(o.id) ?? []
    return (
      <Show
        when={o.kind === "order" && links().length > 0}
        fallback={<span class="text-text-tertiary">-</span>}
      >
        <div class="flex flex-wrap items-center gap-1">
          <For each={links()}>
            {(link) => (
              <button
                type="button"
                data-testid={`shopify-order-invoice-link-${link.invoice_id}`}
                onClick={(e) => {
                  e.stopPropagation()
                  // Another app's record: the host opens invoicing's own tab for it.
                  app.openRecord("invoicing", "document", link.invoice_id)
                }}
                class="min-h-11 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-accent-border hover:bg-accent-subtle hover:text-accent sm:min-h-0"
              >
                {link.number ?? "Invoice"}
              </button>
            )}
          </For>
        </div>
      </Show>
    )
  }
  const orderColumns = (): Array<CardTableColumn<OrderRow>> =>
    ORDER_COLUMNS.map((c: ListColumn) => ({
      key: c.key,
      header: c.header,
      role: c.role,
      align: c.align,
      numeric: c.numeric,
      cell: (o: OrderRow) => orderCell(c.key, o),
    }))

  return (
    <ListShell
      testid="shopify-orders-list"
      title="Orders"
      count={listCountLabel(
        filteredRows().length,
        (orderResults()?.hasMore ?? false) || (draftResults()?.hasMore ?? false),
      )}
      shopDomain={shopDomain()}
      shopifyPath="/orders"
      searchPlaceholder="Search orders by name, email…"
      query={query()}
      onQuery={onQuery}
      loading={loading()}
      empty={filteredRows().length === 0}
      emptyMessage={query() ? "No orders match your search." : "No orders yet."}
    >
      <div class="flex flex-wrap items-center gap-1.5 border-b border-border-subtle bg-bg/40 px-3 py-2">
        <For each={ORDER_FILTERS}>
          {(f) => {
            const active = () => filter() === f.key
            return (
              <button
                type="button"
                data-testid={`shopify-orders-filter-${f.key}`}
                onClick={() => setFilter(f.key)}
                class={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  active()
                    ? "border-accent-border bg-accent-subtle text-accent"
                    : "border-border bg-surface text-text-secondary hover:border-accent-border hover:text-text"
                }`}
              >
                {f.label}
              </button>
            )
          }}
        </For>
        <span class="mx-1 h-4 w-px bg-border-subtle" aria-hidden="true" />
        <button
          type="button"
          data-testid="shopify-orders-filter-shippable"
          aria-pressed={shippableOnly()}
          title="Only orders with at least one item that needs shipping (hides software-only orders and drafts)"
          onClick={() => setShippableOnly(!shippableOnly())}
          class={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
            shippableOnly()
              ? "border-accent-border bg-accent-subtle text-accent"
              : "border-border bg-surface text-text-secondary hover:border-accent-border hover:text-text"
          }`}
        >
          Has items to ship
        </button>
      </div>
      <CardTable
        rows={filteredRows()}
        rowKey={(o) => o.id}
        rowTestid={(o) => `shopify-orders-row-${o.id}`}
        columns={orderColumns()}
        onRowClick={(o) => {
          // Regular orders open the Shopify admin order page directly (new
          // browser tab) — there is no in-app order detail view. Draft orders
          // have their own admin page at a different path.
          const href =
            o.kind === "draft"
              ? adminDraftOrderUrl(shopDomain(), o.id)
              : adminOrderUrl(shopDomain(), o.id)
          openOutside(href)
        }}
      />
    </ListShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ShopifyCustomersList
// ─────────────────────────────────────────────────────────────────────────
export const ShopifyCustomersList: Component = () => {
  const shopDomain = useShopDomain()
  const { query, onQuery, results } = useSearch<NormalizedHit>(
    "customers_search",
    (raw) => (raw as SearchResult)?.results ?? [],
  )
  const rows = () => results()?.results ?? []

  return (
    <ListShell
      testid="shopify-customers-list"
      title="Customers"
      count={listCountLabel(results()?.results.length, results()?.hasMore ?? false)}
      shopDomain={shopDomain()}
      shopifyPath="/customers"
      searchPlaceholder="Search by name, email, tag…"
      query={query()}
      onQuery={onQuery}
      loading={results.loading}
      empty={rows().length === 0}
      emptyMessage={query() ? "No customers match your search." : "No customers yet."}
    >
      <CardTable
        rows={rows()}
        rowKey={(c) => c.id}
        rowTestid={(c) => `shopify-customers-row-${c.id}`}
        columns={[
          {
            key: "customer",
            header: "Customer",
            role: "anchor",
            cell: (c) => <span class="truncate">{c.title}</span>,
          },
          {
            key: "email",
            header: "Email",
            role: "secondary",
            cell: (c) => {
              const email = c.attributes?.email as string | undefined
              return (
                <span class="font-mono text-[11.5px] text-text-secondary">
                  <Show when={email} fallback={<span class="text-text-tertiary">-</span>}>
                    {email}
                  </Show>
                </span>
              )
            },
          },
          {
            key: "spend",
            header: "Spend",
            role: "meta",
            align: "right",
            numeric: true,
            cell: (c) => {
              const spent = c.attributes?.amountSpent as
                | { amount?: string; currencyCode?: string }
                | undefined
              return (
                <Show when={spent?.amount} fallback={<span class="text-text-tertiary">-</span>}>
                  {spent?.amount}
                  <span class="ml-1 text-text-tertiary">{spent?.currencyCode}</span>
                </Show>
              )
            },
          },
          {
            key: "orders",
            header: "Orders",
            role: "meta",
            align: "right",
            cell: (c) => {
              const orders = c.attributes?.numberOfOrders as string | undefined
              return <span class="font-mono tabular-nums">{orders ?? "0"} orders</span>
            },
          },
          {
            key: "market",
            header: "Market",
            role: "fold",
            cell: (c) => c.market ?? <span class="text-text-tertiary">-</span>,
          },
        ]}
        onRowClick={(c, e) => onRowClick(openDetailUrl("customer", c.id), e)}
      />
    </ListShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ShopifyProductsList
// ─────────────────────────────────────────────────────────────────────────
export const ShopifyProductsList: Component = () => {
  const shopDomain = useShopDomain()
  const { query, onQuery, results } = useSearch<NormalizedHit>(
    "products_search",
    (raw) => (raw as SearchResult)?.results ?? [],
  )
  const rows = () => results()?.results ?? []

  return (
    <ListShell
      testid="shopify-products-list"
      title="Products"
      count={listCountLabel(results()?.results.length, results()?.hasMore ?? false)}
      shopDomain={shopDomain()}
      shopifyPath="/products"
      searchPlaceholder="Search by title, SKU, tag…"
      query={query()}
      onQuery={onQuery}
      loading={results.loading}
      empty={rows().length === 0}
      emptyMessage={query() ? "No products match your search." : "No products yet."}
    >
      <CardTable
        rows={rows()}
        rowKey={(p) => p.id}
        rowTestid={(p) => `shopify-products-row-${p.id}`}
        columns={[
          {
            key: "product",
            header: "Product",
            role: "anchor",
            cell: (p) => <span class="truncate">{p.title}</span>,
          },
          {
            key: "vendor",
            header: "Vendor",
            role: "secondary",
            cell: (p) => {
              const vendor = p.attributes?.vendor as string | undefined
              const type = p.attributes?.productType as string | undefined
              const label = [vendor, type].filter(Boolean).join(" · ")
              return label ? label : <span class="text-text-tertiary">-</span>
            },
          },
          {
            key: "stock",
            header: "Stock",
            role: "meta",
            align: "right",
            numeric: true,
            cell: (p) => {
              const totalInventory = p.attributes?.totalInventory as number | undefined
              return totalInventory === undefined ? (
                <span class="text-text-tertiary">-</span>
              ) : (
                totalInventory
              )
            },
          },
          {
            key: "status",
            header: "Status",
            role: "meta",
            cell: (p) => {
              const status = p.attributes?.status as string | undefined
              return status ? <StatusPill status={status} /> : <Chip>-</Chip>
            },
          },
          {
            key: "variants",
            header: "Variants",
            role: "fold",
            align: "right",
            numeric: true,
            cell: (p) => {
              const variantCount = p.attributes?.variantCount as number | undefined
              return variantCount === undefined ? <span class="text-text-tertiary">-</span> : variantCount
            },
          },
        ]}
        onRowClick={(p, e) => onRowClick(openDetailUrl("product", p.id), e)}
      />
    </ListShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ShopifyMarketsList — uses `markets_list` (no search) since markets are a
// short fixed set.
// ─────────────────────────────────────────────────────────────────────────
export const ShopifyMarketsList: Component = () => {
  const shopDomain = useShopDomain()
  const [markets] = app.createResource<NormalizedHit[]>(async () => {
    const raw = await app.invokeTool("markets_list", {})
    // markets_list returns the uniform { results: NormalizedHit[] } envelope —
    // a market's enabled flag + regions live under `attributes`, not top-level.
    return (raw as SearchResult)?.results ?? []
  })

  return (
    <ListShell
      testid="shopify-markets-list"
      title="Markets"
      count={listCountLabel(markets()?.length, false)}
      shopDomain={shopDomain()}
      shopifyPath="/settings/markets"
      searchPlaceholder="Search markets…"
      query=""
      onQuery={() => undefined}
      loading={markets.loading}
      empty={(markets()?.length ?? 0) === 0}
      emptyMessage="No markets configured."
    >
      <CardTable
        rows={markets() ?? []}
        rowKey={(m) => m.id}
        rowTestid={(m) => `shopify-markets-row-${m.id}`}
        columns={[
          { key: "market", header: "Market", role: "anchor", cell: (m) => m.title },
          {
            key: "currency",
            header: "Currency",
            role: "secondary",
            cell: (m) => (
              <span class="font-mono text-text-secondary">
                <Show when={m.currency} fallback={<span class="text-text-tertiary">-</span>}>
                  {m.currency}
                </Show>
              </span>
            ),
          },
          {
            key: "regions",
            header: "Regions",
            role: "meta",
            align: "right",
            numeric: true,
            cell: (m) => {
              const regions = m.attributes?.regions
              const regionCount = Array.isArray(regions) ? regions.length : null
              return regionCount === null ? <span class="text-text-tertiary">-</span> : regionCount
            },
          },
          {
            key: "status",
            header: "Status",
            role: "meta",
            cell: (m) => {
              const enabled = m.attributes?.enabled
              return enabled === false ? <Chip>disabled</Chip> : <Chip tone="success">active</Chip>
            },
          },
        ]}
        onRowClick={(m, e) => onRowClick(openDetailUrl("market", m.id), e)}
      />
    </ListShell>
  )
}
