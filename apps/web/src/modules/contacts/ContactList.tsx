// SPDX-License-Identifier: FSL-1.1-ALv2

import { Mail, Phone, Search, Users, X } from "lucide-solid"
import { type Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { openExternal } from "~/modules/desktop/external-links"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import EntityPreview from "~/modules/shell/entity-preview/EntityPreview"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab } from "~/modules/shell/tab-store"
import { Skeleton } from "~/ui/Skeleton"
import { type SwipeAction, SwipeRow } from "~/ui/SwipeRow"
import { Tooltip } from "~/ui/Tooltip"
import { AddToGroupMenu } from "./AddToGroupMenu"
import { ContactAvatar } from "./ContactAvatar"
import { groups } from "./contact-groups-store"
import {
  type Contact,
  contactListStore,
  groupFilter,
  hasMore,
  loadContacts,
  loading,
  loadingMore,
  loadMoreContacts,
  mode,
  query,
  setGroupFilter,
  setMode,
  setQuery,
  total,
} from "./contact-list-store"
import { contactDisplayName, formatAbsoluteTime, formatRelativeTime } from "./contact-visuals"

interface ContactListProps {
  entityId: string
}

export const ContactList: Component<ContactListProps> = () => {
  const api = useApi()
  const i18n = useI18n()
  const phone = () => shellTier() === "phone"
  let debounceTimer: number | undefined
  let scrollRef!: HTMLDivElement

  onMount(() => {
    void loadContacts(api)
  })

  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
  })

  function handleSearch(value: string): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => {
      setQuery(value)
      void loadContacts(api)
    }, 300)
  }

  function handleModeChange(next: "people" | "all"): void {
    if (mode() === next) return
    setMode(next)
    void loadContacts(api)
  }

  function handleScroll(): void {
    if (!scrollRef) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef
    if (scrollHeight - scrollTop - clientHeight < 200 && hasMore() && !loadingMore()) {
      void loadMoreContacts(api)
    }
  }

  function openContact(id: string): void {
    const contact = contactListStore.byId[id]
    openTab({ type: "contact-detail", entityId: id, label: contactDisplayName(contact) })
  }

  const isEmpty = () => contactListStore.ids.length === 0
  const trimmedQuery = createMemo(() => query().trim())
  const visibleCount = () => contactListStore.ids.length

  // Multi-select (desktop): pick contacts, then add them to a group (S15).
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
  const [selectionMenuOpen, setSelectionMenuOpen] = createSignal(false)
  function toggleSelected(id: string): void {
    const next = new Set(selected())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
    if (next.size === 0) setSelectionMenuOpen(false)
  }
  function clearSelection(): void {
    setSelected(new Set<string>())
    setSelectionMenuOpen(false)
  }

  const activeGroupName = () => {
    const id = groupFilter()
    return id ? (groups().find((g) => g.id === id)?.name ?? "") : null
  }
  function clearGroupFilter(): void {
    setGroupFilter(null)
    void loadContacts(api)
  }

  return (
    <div class="flex h-full flex-col" data-testid="contacts-list">
      {/* At phone width the screen owns its own large title: the shell's top
          bar is a 15px label shared with the workspace name, which is not a
          title at the size a phone list needs one. */}
      <Show when={phone()}>
        <h1
          data-testid="contacts-title"
          class="shrink-0 px-4 pb-1 pt-3 font-display text-[32px] font-semibold leading-tight text-text"
        >
          {i18n.t("kernel.contactsTitle")}
        </h1>
      </Show>
      {/* ── Header: search + mode toggle ──────────────────────────── */}
      <div class="border-b border-border-subtle px-4 pt-4 pb-3">
        <div class="flex items-center gap-3">
          <ModeToggle current={mode()} onChange={handleModeChange} />
          <div class="ml-auto flex items-center gap-2 text-[11px] tabular-nums text-text-tertiary">
            <Show when={!loading() && !isEmpty()}>
              <span aria-live="polite">
                {i18n.t("contacts.countOf", { shown: visibleCount(), total: total() })}
              </span>
            </Show>
          </div>
        </div>
        <Show when={activeGroupName() !== null}>
          <div class="mt-3 flex items-center gap-2">
            <span
              data-testid="contacts-group-filter"
              class="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-2 py-0.5 text-[12px] text-text-secondary"
            >
              <Users size={12} class="text-text-tertiary" />
              {i18n.t("contacts.groups.filteredBy", { name: activeGroupName() ?? "" })}
              <button
                type="button"
                data-testid="contacts-group-filter-clear"
                class="rounded-sm text-text-tertiary hover:text-text"
                aria-label={i18n.t("contacts.groups.clearFilter")}
                title={i18n.t("contacts.groups.clearFilter")}
                onClick={clearGroupFilter}
              >
                <X size={12} />
              </button>
            </span>
          </div>
        </Show>
        <Show when={!phone() && selected().size > 0}>
          <div
            data-testid="contacts-selection-bar"
            class="mt-3 flex items-center gap-2 text-[12px] text-text-secondary"
          >
            <span>{i18n.t("contacts.groups.selectedCount", { count: selected().size })}</span>
            <div class="relative">
              <button
                type="button"
                data-testid="contacts-selection-add-to-group"
                class="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-surface px-2 py-0.5 text-text hover:bg-surface-hover"
                aria-expanded={selectionMenuOpen() ? "true" : "false"}
                onClick={() => setSelectionMenuOpen((v) => !v)}
              >
                <Users size={12} />
                {i18n.t("contacts.groups.addToGroup")}
              </button>
              <Show when={selectionMenuOpen()}>
                <AddToGroupMenu contactIds={[...selected()]} onClose={clearSelection} />
              </Show>
            </div>
            <button
              type="button"
              data-testid="contacts-selection-clear"
              class="text-text-tertiary hover:text-text"
              onClick={clearSelection}
            >
              {i18n.t("contacts.groups.clearSelection")}
            </button>
          </div>
        </Show>
        <label class="mt-3 flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 transition-colors focus-within:border-border focus-within:bg-elevated">
          <Search size={14} class="shrink-0 text-text-tertiary" />
          <input
            data-testid="contacts-search"
            type="text"
            placeholder={
              mode() === "people"
                ? i18n.t("contacts.searchPeople")
                : i18n.t("contacts.searchAllSenders")
            }
            class="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
            value={query()}
            onInput={(event) => handleSearch(event.currentTarget.value)}
          />
        </label>
      </div>

      {/* ── Body ──────────────────────────────────────────────────── */}
      <div ref={scrollRef!} class="flex-1 overflow-y-auto" onScroll={handleScroll}>
        <Show when={loading()}>
          <ListSkeleton />
        </Show>

        <Show when={!loading()}>
          <Show
            when={!isEmpty()}
            fallback={
              <EmptyState
                query={trimmedQuery()}
                mode={mode()}
                onTrySendersClick={() => handleModeChange("all")}
              />
            }
          >
            <ul class="divide-y divide-border-subtle">
              <For each={contactListStore.ids.filter((id) => !!id)}>
                {(id) => {
                  const contact = () => contactListStore.byId[id]
                  return (
                    <Show when={contact()?.id}>
                      <li
                        class={
                          phone()
                            ? "[&>span]:w-full"
                            : "flex items-center [&>span]:min-w-0 [&>span]:w-full"
                        }
                      >
                        <Show
                          when={phone()}
                          fallback={
                            <>
                              <input
                                type="checkbox"
                                data-testid={`contact-select-${id}`}
                                class="ml-4 shrink-0 accent-accent"
                                aria-label={i18n.t("contacts.groups.selectContact", {
                                  name: contactDisplayName(contact()),
                                })}
                                checked={selected().has(id)}
                                onChange={() => toggleSelected(id)}
                              />
                              <EntityPreview
                                app="kernel"
                                entityType="contact"
                                entityId={id}
                                trigger="hover"
                                interactiveChild
                              >
                                <ContactRow
                                  contact={contact()}
                                  isAllMode={mode() === "all"}
                                  onOpen={() => openContact(id)}
                                />
                              </EntityPreview>
                            </>
                          }
                        >
                          <SwipeRow
                            testid={`contact-swipe-${id}`}
                            actions={phoneActions(contact(), i18n.t)}
                          >
                            <ContactPhoneRow contact={contact()} onOpen={() => openContact(id)} />
                          </SwipeRow>
                        </Show>
                      </li>
                    </Show>
                  )
                }}
              </For>
            </ul>
            <Show when={loadingMore()}>
              <div class="flex justify-center py-6">
                <span class="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

// ── Row ────────────────────────────────────────────────────────────

interface ContactRowProps {
  contact: Contact
  isAllMode: boolean
  onOpen: () => void
}

const ContactRow: Component<ContactRowProps> = (props) => {
  const i18n = useI18n()
  const contact = () => props.contact
  const displayName = () => contactDisplayName(contact())
  const lastContacted = () => formatRelativeTime(contact().lastContactedAt)
  const lastContactedAbs = () => formatAbsoluteTime(contact().lastContactedAt) ?? ""
  const isAutomated = () => contact().isAutomated === true

  return (
    <button
      type="button"
      data-testid={`contact-row-${contact().id}`}
      class="group grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-0 px-4 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
      onClick={() => props.onOpen()}
    >
      {/* Avatar */}
      <ContactAvatar
        id={contact().id}
        name={contact().name}
        email={contact().email}
        size="md"
        muted={isAutomated()}
      />

      {/* Identity column — name on top, email beneath */}
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span title={displayName()} class="truncate text-[13.5px] font-medium text-text">
            {displayName()}
          </span>
          <Show when={props.isAllMode && isAutomated()}>
            <span
              class="rounded-sm border border-border-subtle bg-surface-hover px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-text-tertiary"
              title={i18n.t("contacts.detectedAsANotificationOrNo")}
            >
              {i18n.t("contacts.autoBadge")}
            </span>
          </Show>
        </div>
        <div class="mt-0.5 flex items-center gap-2 text-[12px] text-text-tertiary">
          <Show when={contact().email}>
            <span title={contact().email ?? ""} class="truncate font-mono text-[11.5px]">
              {contact().email}
            </span>
          </Show>
          <Show when={contact().email && contact().company}>
            <span aria-hidden="true" class="text-text-tertiary/60">
              ·
            </span>
          </Show>
          <Show when={contact().company}>
            <span title={contact().company ?? ""} class="truncate text-[12px] text-text-secondary">
              {contact().company}
            </span>
          </Show>
        </div>
      </div>

      {/* Last contacted, right-flushed, mono for steady alignment */}
      <div
        data-testid="contact-row-last-contacted"
        class="shrink-0 self-start pt-[3px] text-right font-mono text-[11px] tabular-nums text-text-tertiary"
      >
        <Show
          when={lastContacted()}
          fallback={<span class="text-text-tertiary/70">{i18n.t("contacts.never")}</span>}
        >
          <span title={lastContactedAbs()}>{lastContacted()}</span>
        </Show>
      </div>
    </button>
  )
}

// ── Phone row ──────────────────────────────────────────────────────
//
// 64px, the touch row the rest of the phone tier uses: avatar, the name, one
// muted line for company or address, and how long ago this contact was last
// heard from. A hover preview has no meaning on a touch screen, so the row is
// wrapped in a SwipeRow instead: the contact's own fields ARE the actions, and
// a contact with neither an address nor a number reveals nothing.

/** The swipe actions a contact's own record supports. A field that is not
 *  there is not an action: the rail stays empty rather than offering a button
 *  that cannot do anything. */
export function phoneActions(contact: Contact, t: (key: string) => string): SwipeAction[] {
  const actions: SwipeAction[] = []
  if (contact?.email) {
    actions.push({
      label: t("kernel.contactsActionEmail"),
      tone: "accent",
      icon: <Mail size={16} />,
      onSelect: () => openExternal(`mailto:${contact.email}`),
    })
  }
  if (contact?.phone) {
    actions.push({
      label: t("kernel.contactsActionCall"),
      icon: <Phone size={16} />,
      onSelect: () => openExternal(`tel:${contact.phone}`),
    })
  }
  return actions
}

const ContactPhoneRow: Component<{ contact: Contact; onOpen: () => void }> = (props) => {
  const i18n = useI18n()
  const contact = () => props.contact
  const secondary = () => contact().company || contact().email || ""
  const lastContacted = () => formatRelativeTime(contact().lastContactedAt)
  return (
    <button
      type="button"
      data-testid={`contact-row-${contact().id}`}
      onClick={() => props.onOpen()}
      class="flex h-16 w-full items-center gap-3 px-4 text-left hover:bg-surface-hover"
    >
      <ContactAvatar
        id={contact().id}
        name={contact().name}
        email={contact().email}
        size="lg"
        muted={contact().isAutomated === true}
      />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[16px] text-text">{contactDisplayName(contact())}</span>
        <Show when={secondary()}>
          <span class="block truncate text-[13px] text-text-secondary">{secondary()}</span>
        </Show>
      </span>
      <span
        data-testid="contact-row-last-contacted"
        class="shrink-0 text-[12px] tabular-nums text-text-tertiary"
      >
        {lastContacted() || i18n.t("contacts.never")}
      </span>
    </button>
  )
}

// ── Mode toggle ────────────────────────────────────────────────────

interface ModeToggleProps {
  current: "people" | "all"
  onChange: (mode: "people" | "all") => void
}

const ModeToggle: Component<ModeToggleProps> = (props) => {
  const i18n = useI18n()
  return (
    <div
      role="tablist"
      aria-label={i18n.t("contacts.contactFilter")}
      class="inline-flex items-center rounded-md border border-border-subtle bg-surface p-0.5"
    >
      <ModeToggleButton
        active={props.current === "people"}
        label={i18n.t("contacts.modePeople")}
        hint={i18n.t("contacts.modePeopleHint")}
        onClick={() => props.onChange("people")}
      />
      <ModeToggleButton
        active={props.current === "all"}
        label={i18n.t("contacts.modeAll")}
        hint={i18n.t("contacts.modeAllHint")}
        onClick={() => props.onChange("all")}
      />
    </div>
  )
}

const ModeToggleButton: Component<{
  active: boolean
  label: string
  hint: string
  onClick: () => void
}> = (props) => (
  <Tooltip content={props.hint}>
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      data-testid={`contacts-mode-${props.label.toLowerCase()}`}
      class={cn(
        "rounded-[5px] px-2.5 py-1 text-[11.5px] font-medium transition-colors",
        props.active
          ? "bg-elevated text-text shadow-[inset_0_0_0_1px_var(--color-border)]"
          : "text-text-tertiary hover:text-text-secondary",
      )}
      onClick={() => props.onClick()}
    >
      {props.label}
    </button>
  </Tooltip>
)

// ── Loading skeleton ───────────────────────────────────────────────

const skeletonNameWidths = [
  "w-[40%]",
  "w-[53%]",
  "w-[66%]",
  "w-[49%]",
  "w-[62%]",
  "w-[45%]",
  "w-[58%]",
]
const skeletonMetaWidths = [
  "w-[55%]",
  "w-[72%]",
  "w-[64%]",
  "w-[56%]",
  "w-[73%]",
  "w-[65%]",
  "w-[57%]",
]

const ListSkeleton: Component = () => (
  <ul class="divide-y divide-border-subtle">
    <For each={[0, 1, 2, 3, 4, 5, 6]}>
      {(_, i) => (
        <li class="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 px-4 py-3">
          <Skeleton class="h-8 w-8 rounded-full" />
          <div class="min-w-0 space-y-1.5">
            <Skeleton class={`h-3 ${skeletonNameWidths[i()]}`} />
            <Skeleton class={`h-2.5 ${skeletonMetaWidths[i()]}`} />
          </div>
          <Skeleton class="h-2.5 w-10" />
        </li>
      )}
    </For>
  </ul>
)

// ── Empty state ────────────────────────────────────────────────────

interface EmptyStateProps {
  query: string
  mode: "people" | "all"
  onTrySendersClick: () => void
}

const EmptyState: Component<EmptyStateProps> = (props) => {
  const i18n = useI18n()
  const safeQuery = () => props.query ?? ""
  const isSearch = () => safeQuery().length > 0
  return (
    <div class="flex flex-1 flex-col items-center justify-center px-8 py-20 text-center">
      <Show
        when={isSearch()}
        fallback={
          <>
            <p class="text-[14px] text-text-secondary">
              {props.mode === "people"
                ? i18n.t("contacts.noPeopleYet")
                : i18n.t("contacts.noContactsYet")}
            </p>
            <p class="mt-1.5 max-w-xs text-[12px] text-text-tertiary">
              {i18n.t("contacts.appearAutomatically")}
            </p>
          </>
        }
      >
        <p class="text-[14px] text-text-secondary">
          {i18n.t("contacts.noMatch", { query: safeQuery() })}
        </p>
        <Show when={props.mode === "people"}>
          <button
            type="button"
            class="mt-3 text-[12px] text-accent hover:underline"
            onClick={() => props.onTrySendersClick()}
          >
            {i18n.t("contacts.searchAllSendersInstead")}
          </button>
        </Show>
      </Show>
    </div>
  )
}
