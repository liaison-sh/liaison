// SPDX-License-Identifier: FSL-1.1-ALv2
// TicketsSidebar — smart filters + per-inbox unread counts.

import type { Component } from "solid-js"
import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { onEntityChange } from "~/framework/entity-changes"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"
import { SavedViewsList } from "~/modules/shell/saved-views/SavedViewsList"
import { openTab, tabStore } from "~/modules/shell/tab-store"
import { useWs } from "~/modules/shell/WsContext"
import { setNewTicketDialogOpen } from "~/modules/tickets/new-ticket-dialog"
import { loadCategories, ticketCategoryStore } from "~/modules/tickets/ticket-category-store"
import {
  inboxUnreadMayChange,
  loadInboxes,
  refreshInboxCounts,
  ticketInboxStore,
  totalUnreadAcrossInboxes,
} from "~/modules/tickets/ticket-inbox-store"
import {
  COUNTED_SMART_FILTERS,
  filterRoutePath,
  loadTickets,
  paramsForInbox,
  paramsForSmartFilter,
  refreshFilterCounts,
  type SmartFilter,
  setListParams,
  ticketFilterCountStore,
  ticketListStore,
} from "~/modules/tickets/ticket-list-store"
import type { TicketCategory, TicketInbox } from "~/modules/tickets/ticket-types"

const SMART_FILTERS: { id: SmartFilter; label: string }[] = [
  { id: "needs-attention", label: "tickets.smart.needsAttention" },
  { id: "awaiting-customer", label: "tickets.smart.awaitingCustomer" },
  { id: "follow-ups", label: "tickets.smart.followUps" },
  { id: "closed", label: "tickets.smart.closed" },
  { id: "all-open", label: "tickets.smart.allOpen" },
]

function inboxKind(inbox: TicketInbox): "mailbox" | "api" {
  return inbox.kind === "api" ? "api" : "mailbox"
}

const byOrder = (a: TicketCategory, b: TicketCategory): number =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)

/**
 * The sidebar's category list, as the tree Settings shows: each root, then its
 * children indented under it. The flat list used to print every child as a
 * sibling, so a Acme org read "Achat non comptabilisé" three times (one
 * per escalation level L1 to L3) with the levels themselves mixed in as plain
 * categories. A child whose parent is archived or missing is shown as a root
 * rather than dropped.
 */
export function categoryTree(
  categories: readonly TicketCategory[],
): Array<{ category: TicketCategory; depth: number }> {
  const visible = categories.filter((c) => !c.archivedAt)
  const ids = new Set(visible.map((c) => c.id))
  const children = new Map<string, TicketCategory[]>()
  const roots: TicketCategory[] = []
  for (const c of visible) {
    if (c.parentId && ids.has(c.parentId) && c.parentId !== c.id) {
      children.set(c.parentId, [...(children.get(c.parentId) ?? []), c])
    } else roots.push(c)
  }
  const out: Array<{ category: TicketCategory; depth: number }> = []
  const seen = new Set<string>()
  const walk = (c: TicketCategory, depth: number): void => {
    if (seen.has(c.id)) return
    seen.add(c.id)
    out.push({ category: c, depth })
    for (const child of [...(children.get(c.id) ?? [])].sort(byOrder)) walk(child, depth + 1)
  }
  for (const root of [...roots].sort(byOrder)) walk(root, 0)
  return out
}

export const TicketsSidebar: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const ws = useWs()
  let lastStatus: string | null = null

  // Smart-filter count badges: keep them live without a fetch storm. Every
  // ticket event dispatches `tickets:attention-invalidated` (see
  // handleTicketEvent), so coalesce a burst of transitions into one recount.
  let filterCountTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleFilterCountRefresh = (): void => {
    if (filterCountTimer) clearTimeout(filterCountTimer)
    filterCountTimer = setTimeout(() => void refreshFilterCounts(api), 400)
  }

  onMount(() => {
    void loadInboxes(api)
    void loadCategories(api)
    void refreshInboxCounts(api)
    void refreshFilterCounts(api)
    const onInboxesInvalidated = () => {
      void loadInboxes(api)
      void refreshInboxCounts(api)
    }
    window.addEventListener("tickets:inboxes-invalidated", onInboxesInvalidated)
    window.addEventListener("tickets:attention-invalidated", scheduleFilterCountRefresh)
    onCleanup(() => {
      window.removeEventListener("tickets:inboxes-invalidated", onInboxesInvalidated)
      window.removeEventListener("tickets:attention-invalidated", scheduleFilterCountRefresh)
      if (filterCountTimer) clearTimeout(filterCountTimer)
    })
  })

  // Per-inbox unread badges follow the changes that can move an unread count
  // (new ticket, customer reply, read, close/reopen/merge, inbox change), one
  // recount per burst; a priority edit, an SLA breach or our own reply does not
  // recount. A resync also recounts the filters, which the attention-invalidated
  // path above keeps live otherwise.
  onEntityChange(
    ["tickets:ticket", "tickets:message"],
    (events) => {
      if (events.some(inboxUnreadMayChange)) void refreshInboxCounts(api)
      if (events.some((e) => e.resync)) void refreshFilterCounts(api)
    },
    { debounceMs: 1500, maxWaitMs: 4000 },
  )

  // WS reconcile — when the socket becomes "connected" again after
  // being disconnected/reconnecting, refresh inbox + filter counts so the
  // badges reflect any events that fired while we were offline.
  createEffect(() => {
    const s = ws.status()
    if (lastStatus !== "connected" && s === "connected" && lastStatus !== null) {
      void refreshInboxCounts(api)
      void refreshFilterCounts(api)
      attentionStore.markStaleAndReload(api)
    }
    lastStatus = s
  })

  const visibleInboxes = createMemo(() => ticketInboxStore.inboxes.filter((i) => !i.archivedAt))

  // The "All" inbox row's unread badge. The "All open work" view carries its
  // own open count (COUNTED_SMART_FILTERS), never this number.
  const totalUnread = createMemo(() => totalUnreadAcrossInboxes())

  // The rows under "All" must add up to it. Unread tickets with no live source
  // inbox (imported, created by an agent or the API, or from an archived
  // inbox) belong to no inbox row, so the walk read "All 42" over rows summing
  // to 4. They get their own row, shown only when there are some.
  const noInboxUnread = createMemo(() => {
    const perInbox = visibleInboxes().reduce(
      (sum, inbox) => sum + (ticketInboxStore.unreadByInboxId[inbox.id] ?? 0),
      0,
    )
    return Math.max(0, totalUnread() - perInbox)
  })

  const categoryRows = createMemo(() => categoryTree(ticketCategoryStore.categories))

  const inboxTabRoute = createMemo(
    () =>
      tabStore.tabs.find((tab) => tab.id === tabStore.activeTabId && tab.type === "tickets:inbox")
        ?.routePath,
  )

  const activeFilterValue = createMemo(() => {
    const raw = inboxTabRoute()?.split("?")[1]
    return raw
      ? new URLSearchParams(raw).get("filter")
      : (ticketListStore.params.smartFilter ?? "all-open")
  })

  function selectFilter(filter: SmartFilter): void {
    setListParams(paramsForSmartFilter(filter))
    openTab({
      type: "tickets:inbox",
      entityId: "inbox",
      label: i18n.t("tickets.tickets2"),
      routePath: filterRoutePath(filter),
    })
    void loadTickets(api)
  }

  function selectInbox(inboxId: string): void {
    setListParams(paramsForInbox(inboxId))
    openTab({
      type: "tickets:inbox",
      entityId: "inbox",
      label: i18n.t("tickets.tickets2"),
      routePath: filterRoutePath("all-open", inboxId),
    })
    void loadTickets(api)
  }

  function selectCategory(categoryId: string): void {
    setListParams({ ...paramsForSmartFilter("all-open"), categoryId })
    openTab({ type: "tickets:inbox", entityId: "inbox", label: i18n.t("tickets.tickets2") })
    void loadTickets(api)
  }

  const isActiveFilter = (id: SmartFilter) =>
    activeFilterValue() === id &&
    !ticketListStore.params.inboxId &&
    !ticketListStore.params.categoryId

  const isActiveInbox = (id: string) => activeFilterValue() === `inbox:${id}`

  return (
    <div
      class="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-3"
      data-testid="tickets-sidebar"
      data-tour-tier="wide"
    >
      <div>
        <button
          type="button"
          class="w-full rounded bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-hover"
          data-testid="tickets-new-button"
          onClick={() => {
            openTab({
              type: "tickets:inbox",
              entityId: "inbox",
              label: i18n.t("tickets.tickets2"),
              routePath: filterRoutePath("all-open"),
            })
            setNewTicketDialogOpen(true)
          }}
        >
          {i18n.t("tickets.newTicket")}
        </button>
      </div>

      <nav
        class="flex flex-col gap-0.5"
        aria-label={i18n.t("tickets.smartFilters")}
        data-testid="tickets-smart-filters"
        data-tour-tier="wide"
      >
        <For each={SMART_FILTERS}>
          {(f) => (
            <button
              type="button"
              data-testid={`tickets-filter-${f.id}`}
              class={cn(
                "flex items-center justify-between rounded px-3 py-1.5 text-left text-sm",
                isActiveFilter(f.id)
                  ? "bg-surface-active font-medium text-text"
                  : "text-text-secondary hover:bg-surface-hover",
              )}
              onClick={() => selectFilter(f.id)}
            >
              <span>{i18n.t(f.label)}</span>
              <Show
                when={
                  COUNTED_SMART_FILTERS.includes(f.id) &&
                  ticketFilterCountStore.countByFilter[f.id] !== undefined
                }
              >
                <span
                  class="text-xs text-text-tertiary"
                  data-testid={`tickets-filter-count-${f.id}`}
                >
                  {ticketFilterCountStore.countByFilter[f.id]}
                </span>
              </Show>
            </button>
          )}
        </For>
      </nav>

      <div class="flex flex-col gap-1">
        {/* Every badge in this section counts UNREAD tickets, while the "All
            open work" view above counts open ones: the heading says so. */}
        <h3 class="flex items-baseline justify-between px-3 text-xs uppercase tracking-wide text-text-tertiary">
          <span>{i18n.t("tickets.inboxes")}</span>
          <span class="normal-case tracking-normal" data-testid="tickets-inbox-count-legend">
            {i18n.t("tickets.inboxUnreadLegend")}
          </span>
        </h3>
        <button
          type="button"
          data-testid="tickets-sidebar-inbox-all"
          class={cn(
            "flex items-center justify-between rounded px-3 py-1.5 text-left text-sm",
            isActiveFilter("all-open")
              ? "bg-surface-active font-medium text-text"
              : "text-text-secondary hover:bg-surface-hover",
          )}
          onClick={() => selectFilter("all-open")}
        >
          <span class="truncate">{i18n.t("kernel.common.all")}</span>
          <span
            class="ml-2 text-xs text-text-tertiary"
            data-testid="tickets-inbox-unread-all"
            title={i18n.t("tickets.inboxUnreadTitle", { count: totalUnread() })}
          >
            {totalUnread()}
          </span>
        </button>
        <For each={visibleInboxes()}>
          {(inbox) => (
            <button
              type="button"
              data-testid={`tickets-sidebar-inbox-${inbox.id}`}
              class={cn(
                "flex items-center justify-between rounded px-3 py-1.5 text-left text-sm",
                isActiveInbox(inbox.id)
                  ? "bg-surface-active font-medium text-text"
                  : "text-text-secondary hover:bg-surface-hover",
              )}
              onClick={() => selectInbox(inbox.id)}
            >
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate">{inbox.name}</span>
                <span
                  class="shrink-0 rounded-full bg-surface-sunken px-1.5 py-px text-[10px] font-medium text-text-tertiary"
                  data-testid={`tickets-inbox-kind-${inbox.id}`}
                >
                  {inboxKind(inbox) === "api" ? "API" : i18n.t("tickets.mailbox")}
                </span>
              </span>
              <span
                class="ml-2 shrink-0 text-xs text-text-tertiary"
                data-testid={`tickets-inbox-unread-${inbox.id}`}
                title={i18n.t("tickets.inboxUnreadTitle", {
                  count: ticketInboxStore.unreadByInboxId[inbox.id] ?? 0,
                })}
              >
                {ticketInboxStore.unreadByInboxId[inbox.id] ?? 0}
              </span>
            </button>
          )}
        </For>
        <Show when={noInboxUnread() > 0}>
          <div
            class="flex items-center justify-between px-3 py-1.5 text-sm text-text-tertiary"
            data-testid="tickets-sidebar-inbox-none"
            title={i18n.t("tickets.noInboxBucketHint")}
          >
            <span class="truncate">{i18n.t("tickets.noInboxBucket")}</span>
            <span class="ml-2 shrink-0 text-xs" data-testid="tickets-inbox-unread-none">
              {noInboxUnread()}
            </span>
          </div>
        </Show>
      </div>

      <SavedViewsList app="tickets" viewId="inbox" />

      <Show when={categoryRows().length > 0}>
        <div class="flex flex-col gap-1" data-testid="tickets-sidebar-categories">
          <h3 class="px-3 text-xs uppercase tracking-wide text-text-tertiary">
            {i18n.t("tickets.categories")}
          </h3>
          <For each={categoryRows()}>
            {(row) => (
              <button
                type="button"
                data-testid={`tickets-sidebar-category-${row.category.id}`}
                data-depth={row.depth}
                class={cn(
                  "truncate rounded py-1.5 pr-3 text-left text-sm hover:bg-surface-hover",
                  row.depth === 0 ? "text-text-secondary" : "text-text-tertiary",
                  ticketListStore.params.categoryId === row.category.id &&
                    "bg-surface-active font-medium text-text",
                )}
                style={{ "padding-left": `${12 + row.depth * 14}px` }}
                onClick={() => selectCategory(row.category.id)}
              >
                {row.category.name}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
