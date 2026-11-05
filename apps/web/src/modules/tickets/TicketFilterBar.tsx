// SPDX-License-Identifier: FSL-1.1-ALv2
// TicketFilterBar — the interactive filter + sort row above the ticket list.
// Status / Priority / Inbox / Category are dropdown refinements layered on top
// of the active smart-filter view; Sort switches the list order (recent
// activity vs chronological newest/oldest). Each control writes through a
// ticket-list-store setter that patches one param dimension and reloads.

import { ArrowDown, ArrowUp, Check, ChevronDown } from "lucide-solid"
import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { loadCategories, ticketCategoryStore } from "~/modules/tickets/ticket-category-store"
import { loadInboxes, ticketInboxStore } from "~/modules/tickets/ticket-inbox-store"
import {
  type SmartFilter,
  setAudienceFilter,
  setCategoryFilter,
  setInboxFilter,
  setPriorityFilter,
  setSortMode,
  setStatusFilter,
  setTeamFilter,
  ticketListStore,
} from "~/modules/tickets/ticket-list-store"
import { loadTeams, ticketTeamStore } from "~/modules/tickets/ticket-team-store"
import { PopupMenu } from "~/ui/PopupMenu"

const STATUS_LABELS: Record<string, string> = {
  open: "tickets.status.open",
  awaiting_customer: "tickets.status.awaiting_customer",
  awaiting_followup: "tickets.status.awaiting_followup",
  closed: "tickets.status.closed",
}

const PRIORITY_OPTIONS = [
  { value: "urgent", label: "tickets.urgent" },
  { value: "high", label: "tickets.high" },
  { value: "normal", label: "tickets.normal" },
  { value: "low", label: "tickets.low" },
]

// The statuses worth offering per view. Each option can only NARROW the view's
// scope (the backend intersects params.status with the smart filter's own status
// clause), so restricting the menu to in-scope statuses guarantees every choice
// returns rows rather than an empty intersection.
function statusOptionsForView(smartFilter: SmartFilter | undefined): string[] {
  switch (smartFilter) {
    case "awaiting-customer":
      return ["awaiting_customer"]
    case "follow-ups":
      return ["awaiting_followup"]
    case "closed":
      return ["closed"]
    case "needs-attention":
      return ["open", "awaiting_followup"]
    default:
      return ["open", "awaiting_customer", "awaiting_followup"]
  }
}

function chipClass(active: boolean): string {
  return cn(
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors",
    active
      ? "bg-accent/15 text-accent"
      : "bg-surface-sunken text-text-secondary hover:bg-surface-hover",
  )
}

export const TicketFilterBar: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [statusOpen, setStatusOpen] = createSignal(false)
  const [priorityOpen, setPriorityOpen] = createSignal(false)
  const [inboxOpen, setInboxOpen] = createSignal(false)
  const [teamOpen, setTeamOpen] = createSignal(false)
  const [audienceOpen, setAudienceOpen] = createSignal(false)
  const [categoryOpen, setCategoryOpen] = createSignal(false)

  onMount(() => {
    if (!ticketInboxStore.loaded) void loadInboxes(api)
    if (!ticketCategoryStore.loaded) void loadCategories(api)
    if (!ticketTeamStore.loaded) void loadTeams(api)
  })

  const params = () => ticketListStore.params

  // --- Status ---
  const statusOptions = createMemo(() => statusOptionsForView(params().smartFilter))
  const selectedStatuses = createMemo(() => {
    const inScope = (params().status ?? []).filter((s) => statusOptions().includes(s))
    // No in-scope override => the whole view scope is shown (nothing narrowed).
    return inScope.length > 0 ? inScope : statusOptions()
  })
  const statusNarrowed = createMemo(() => selectedStatuses().length < statusOptions().length)
  const statusLabel = createMemo(() => {
    if (!statusNarrowed()) return i18n.t("kernel.common.status")
    const sel = selectedStatuses()
    if (sel.length !== 1) return i18n.t("tickets.filter.statusCount", { n: sel.length })
    const key = STATUS_LABELS[sel[0]]
    return key ? i18n.t(key) : sel[0]
  })
  function toggleStatus(s: string): void {
    const next = new Set(selectedStatuses())
    if (next.has(s)) next.delete(s)
    else next.add(s)
    setStatusFilter(api, [...next])
  }

  // --- Priority ---
  const selectedPriorities = createMemo(() => params().priority ?? [])
  const priorityLabel = createMemo(() => {
    const sel = selectedPriorities()
    if (sel.length === 0) return i18n.t("kernel.common.priority")
    if (sel.length === 1) {
      const key = PRIORITY_OPTIONS.find((p) => p.value === sel[0])?.label
      return key ? i18n.t(key) : sel[0]
    }
    return i18n.t("tickets.filter.priorityCount", { n: sel.length })
  })
  function togglePriority(p: string): void {
    const next = new Set(selectedPriorities())
    if (next.has(p)) next.delete(p)
    else next.add(p)
    setPriorityFilter(api, [...next])
  }

  // --- Inbox ---
  const inboxes = createMemo(() => ticketInboxStore.inboxes.filter((i) => !i.archivedAt))
  const activeInboxId = createMemo(() => params().sourceInboxId ?? params().inboxId ?? null)
  const inboxLabel = createMemo(() => {
    const id = activeInboxId()
    if (!id) return i18n.t("tickets.inbox")
    return inboxes().find((i) => i.id === id)?.name ?? i18n.t("tickets.inbox")
  })

  // --- Team ---
  // Teams are free text with no id, so the label is the key. It is used raw as
  // the filter value AND (suffixed) as the test id: never trim or normalise it,
  // or the chip stops matching the tickets it names.
  const teams = createMemo(() => ticketTeamStore.teams)
  const activeTeam = createMemo(() => params().team?.[0] ?? null)
  const teamLabel = createMemo(() => activeTeam() ?? i18n.t("tickets.team"))

  // --- Audience (B2B / B2C) ---
  // A closed set of two, so it is hardcoded rather than loaded: there is no
  // list endpoint and no spelling to get wrong. Always shown — the axis exists
  // for every desk, and a chip that reads "Audience" is how an operator learns
  // the split is even available.
  const AUDIENCES: { value: string; label: string }[] = [
    { value: "b2b", label: i18n.t("tickets.b2bPartner") },
    { value: "b2c", label: i18n.t("tickets.b2cCustomer") },
  ]
  const activeAudience = createMemo(() => params().audience?.[0] ?? null)
  const audienceLabel = createMemo(
    () => AUDIENCES.find((a) => a.value === activeAudience())?.label ?? i18n.t("tickets.audience"),
  )

  // --- Category ---
  const categories = createMemo(() => ticketCategoryStore.categories.filter((c) => !c.archivedAt))
  const activeCategoryId = createMemo(() => params().categoryId ?? null)
  const categoryLabel = createMemo(() => {
    const id = activeCategoryId()
    if (!id) return i18n.t("tickets.category")
    return categories().find((c) => c.id === id)?.name ?? i18n.t("tickets.category")
  })

  // --- Sort (last message, newest or oldest first) ---
  // The list always orders by the last message (inbound or outbound) -- the same
  // date each row shows -- and this toggle only flips the direction. Default falls
  // back to newest-first for any view whose params don't carry an explicit sort.
  const oldestFirst = createMemo(() => params().sort === "activity_oldest")
  function toggleSortDirection(): void {
    setSortMode(api, oldestFirst() ? "activity_newest" : "activity_oldest")
  }

  return (
    <div
      class="flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2"
      data-testid="tickets-filter-bar"
    >
      {/* Status */}
      <PopupMenu open={statusOpen()} onOpenChange={setStatusOpen}>
        <PopupMenu.Trigger aria-label={i18n.t("tickets.filterByStatus")}>
          <span data-testid="tickets-filter-chip-status" class={chipClass(statusNarrowed())}>
            {statusLabel()}
            <ChevronDown class="h-3 w-3 opacity-60" />
          </span>
        </PopupMenu.Trigger>
        <PopupMenu.Content aria-label={i18n.t("tickets.filterByStatus")} class="w-52">
          <For each={statusOptions()}>
            {(s) => (
              <PopupMenu.Item
                closeOnSelect={false}
                textValue={STATUS_LABELS[s] ? i18n.t(STATUS_LABELS[s]) : s}
                onSelect={() => toggleStatus(s)}
              >
                <Check
                  class={cn(
                    "h-3.5 w-3.5",
                    selectedStatuses().includes(s) ? "text-accent" : "opacity-0",
                  )}
                />
                <span data-testid={`tickets-filter-status-option-${s}`}>
                  {STATUS_LABELS[s] ? i18n.t(STATUS_LABELS[s]) : s}
                </span>
              </PopupMenu.Item>
            )}
          </For>
        </PopupMenu.Content>
      </PopupMenu>

      {/* Priority */}
      <PopupMenu open={priorityOpen()} onOpenChange={setPriorityOpen}>
        <PopupMenu.Trigger aria-label={i18n.t("tickets.filterByPriority")}>
          <span
            data-testid="tickets-filter-chip-priority"
            class={chipClass(selectedPriorities().length > 0)}
          >
            {priorityLabel()}
            <ChevronDown class="h-3 w-3 opacity-60" />
          </span>
        </PopupMenu.Trigger>
        <PopupMenu.Content aria-label={i18n.t("tickets.filterByPriority")} class="w-44">
          <For each={PRIORITY_OPTIONS}>
            {(opt) => (
              <PopupMenu.Item
                closeOnSelect={false}
                textValue={i18n.t(opt.label)}
                onSelect={() => togglePriority(opt.value)}
              >
                <Check
                  class={cn(
                    "h-3.5 w-3.5",
                    selectedPriorities().includes(opt.value) ? "text-accent" : "opacity-0",
                  )}
                />
                <span data-testid={`tickets-filter-priority-option-${opt.value}`}>
                  {i18n.t(opt.label)}
                </span>
              </PopupMenu.Item>
            )}
          </For>
        </PopupMenu.Content>
      </PopupMenu>

      {/* Inbox */}
      <PopupMenu open={inboxOpen()} onOpenChange={setInboxOpen}>
        <PopupMenu.Trigger aria-label={i18n.t("tickets.filterByInbox")}>
          <span data-testid="tickets-filter-chip-inbox" class={chipClass(activeInboxId() !== null)}>
            {inboxLabel()}
            <ChevronDown class="h-3 w-3 opacity-60" />
          </span>
        </PopupMenu.Trigger>
        <PopupMenu.Content
          aria-label={i18n.t("tickets.filterByInbox")}
          class="max-h-72 w-56 overflow-y-auto"
        >
          <PopupMenu.Item textValue="All inboxes" onSelect={() => setInboxFilter(api, null)}>
            <Check
              class={cn("h-3.5 w-3.5", activeInboxId() === null ? "text-accent" : "opacity-0")}
            />
            <span data-testid="tickets-filter-inbox-option-all">
              {i18n.t("tickets.allInboxes")}
            </span>
          </PopupMenu.Item>
          <Show when={inboxes().length > 0}>
            <PopupMenu.Separator />
          </Show>
          <For each={inboxes()}>
            {(inbox) => (
              <PopupMenu.Item textValue={inbox.name} onSelect={() => setInboxFilter(api, inbox.id)}>
                <Check
                  class={cn(
                    "h-3.5 w-3.5",
                    activeInboxId() === inbox.id ? "text-accent" : "opacity-0",
                  )}
                />
                <span class="truncate" data-testid={`tickets-filter-inbox-option-${inbox.id}`}>
                  {inbox.name}
                </span>
              </PopupMenu.Item>
            )}
          </For>
        </PopupMenu.Content>
      </PopupMenu>

      {/* Team — hidden entirely on a desk that files no tickets by team, so an
          org that doesn't use the dimension never carries a dead control. */}
      <Show when={teams().length > 0}>
        <PopupMenu open={teamOpen()} onOpenChange={setTeamOpen}>
          <PopupMenu.Trigger aria-label={i18n.t("tickets.filterByTeam")}>
            <span data-testid="tickets-filter-chip-team" class={chipClass(activeTeam() !== null)}>
              {teamLabel()}
              <ChevronDown class="h-3 w-3 opacity-60" />
            </span>
          </PopupMenu.Trigger>
          <PopupMenu.Content
            aria-label={i18n.t("tickets.filterByTeam")}
            class="max-h-72 w-64 overflow-y-auto"
          >
            <PopupMenu.Item textValue="All teams" onSelect={() => setTeamFilter(api, null)}>
              <Check
                class={cn("h-3.5 w-3.5", activeTeam() === null ? "text-accent" : "opacity-0")}
              />
              <span data-testid="tickets-filter-team-option-all">{i18n.t("tickets.allTeams")}</span>
            </PopupMenu.Item>
            <PopupMenu.Separator />
            <For each={teams()}>
              {(t) => (
                <PopupMenu.Item textValue={t.team} onSelect={() => setTeamFilter(api, t.team)}>
                  <Check
                    class={cn("h-3.5 w-3.5", activeTeam() === t.team ? "text-accent" : "opacity-0")}
                  />
                  <span
                    class="flex min-w-0 flex-1 items-center justify-between gap-2"
                    data-testid={`tickets-filter-team-option-${t.team}`}
                  >
                    <span class="truncate">{t.team}</span>
                    {/* The live count, so a desk with nothing open is visible
                        without clicking into it. */}
                    <span class="shrink-0 text-text-tertiary">{t.openCount}</span>
                  </span>
                </PopupMenu.Item>
              )}
            </For>
          </PopupMenu.Content>
        </PopupMenu>
      </Show>

      {/* Audience — which side wrote. Orthogonal to Team (which centre). */}
      <PopupMenu open={audienceOpen()} onOpenChange={setAudienceOpen}>
        <PopupMenu.Trigger aria-label={i18n.t("tickets.filterByAudience")}>
          <span
            data-testid="tickets-filter-chip-audience"
            class={chipClass(activeAudience() !== null)}
          >
            {audienceLabel()}
            <ChevronDown class="h-3 w-3 opacity-60" />
          </span>
        </PopupMenu.Trigger>
        <PopupMenu.Content aria-label={i18n.t("tickets.filterByAudience")} class="w-56">
          <PopupMenu.Item textValue="All" onSelect={() => setAudienceFilter(api, null)}>
            <Check
              class={cn("h-3.5 w-3.5", activeAudience() === null ? "text-accent" : "opacity-0")}
            />
            <span data-testid="tickets-filter-audience-option-all">
              {i18n.t("kernel.common.all")}
            </span>
          </PopupMenu.Item>
          <PopupMenu.Separator />
          <For each={AUDIENCES}>
            {(a) => (
              <PopupMenu.Item textValue={a.label} onSelect={() => setAudienceFilter(api, a.value)}>
                <Check
                  class={cn(
                    "h-3.5 w-3.5",
                    activeAudience() === a.value ? "text-accent" : "opacity-0",
                  )}
                />
                <span data-testid={`tickets-filter-audience-option-${a.value}`}>{a.label}</span>
              </PopupMenu.Item>
            )}
          </For>
        </PopupMenu.Content>
      </PopupMenu>

      {/* Category */}
      <PopupMenu open={categoryOpen()} onOpenChange={setCategoryOpen}>
        <PopupMenu.Trigger aria-label={i18n.t("tickets.filterByCategory")}>
          <span
            data-testid="tickets-filter-chip-category"
            class={chipClass(activeCategoryId() !== null)}
          >
            {categoryLabel()}
            <ChevronDown class="h-3 w-3 opacity-60" />
          </span>
        </PopupMenu.Trigger>
        <PopupMenu.Content
          aria-label={i18n.t("tickets.filterByCategory")}
          class="max-h-72 w-56 overflow-y-auto"
        >
          <PopupMenu.Item textValue="All categories" onSelect={() => setCategoryFilter(api, null)}>
            <Check
              class={cn("h-3.5 w-3.5", activeCategoryId() === null ? "text-accent" : "opacity-0")}
            />
            <span data-testid="tickets-filter-category-option-all">
              {i18n.t("tickets.allCategories")}
            </span>
          </PopupMenu.Item>
          <Show when={categories().length > 0}>
            <PopupMenu.Separator />
          </Show>
          <For each={categories()}>
            {(cat) => (
              <PopupMenu.Item textValue={cat.name} onSelect={() => setCategoryFilter(api, cat.id)}>
                <Check
                  class={cn(
                    "h-3.5 w-3.5",
                    activeCategoryId() === cat.id ? "text-accent" : "opacity-0",
                  )}
                />
                <span class="truncate" data-testid={`tickets-filter-category-option-${cat.id}`}>
                  {cat.name}
                </span>
              </PopupMenu.Item>
            )}
          </For>
        </PopupMenu.Content>
      </PopupMenu>

      {/* Sort direction — pushed to the right. One button that flips between
          newest- and oldest-received first (the list always orders by the last
          received customer message). */}
      <button
        type="button"
        class={cn("ml-auto", chipClass(false))}
        data-testid="tickets-filter-chip-sort"
        data-sort={oldestFirst() ? "activity_oldest" : "activity_newest"}
        title={i18n.t("tickets.sortByLastMessageDate")}
        onClick={toggleSortDirection}
      >
        <Show
          when={oldestFirst()}
          fallback={
            <>
              <ArrowDown class="h-3 w-3 opacity-70" />
              {i18n.t("tickets.newestFirst")}
            </>
          }
        >
          <ArrowUp class="h-3 w-3 opacity-70" />
          {i18n.t("tickets.oldestFirst")}
        </Show>
      </button>
    </div>
  )
}
