// SPDX-License-Identifier: FSL-1.1-ALv2

import { Archive, Lock, Mail, MailCheck, MailOpen, PenSquare, Search, Star } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { cn } from "~/lib/cn"
import { compactAge } from "~/lib/relative-time"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { AssigneePicker } from "~/modules/mail/AssigneePicker"
import { MailEncryptionEnrollmentBanner } from "~/modules/mail/MailEncryptionEnrollmentBanner"
import { MailSyncProgressBanner } from "~/modules/mail/MailSyncProgressBanner"
import {
  accountsLoaded,
  allAccounts,
  getAccount,
  loadAccounts,
} from "~/modules/mail/mail-account-store"
import {
  type MailCategory,
  mailCategoryFor,
  mailCategoryScope,
  setMailCategory,
} from "~/modules/mail/mail-category"
import {
  archiveConversation,
  claimConversation,
  clearDeepSearch,
  conversationStore,
  currentView,
  deepSearching,
  hasMore,
  loadConversations,
  loading,
  loadingMore,
  loadMoreConversations,
  reassignConversation,
  searchAllConversations,
  setView,
  toggleRead,
  toggleStar,
  unassignConversation,
} from "~/modules/mail/mail-conversation-store"
import { drafts, loadDrafts } from "~/modules/mail/mail-draft-store"
import {
  MAIL_PHONE_FILTERS,
  type MailPhoneFilter,
  mailAccountLine,
  mailFolderLabelKey,
  matchesMailPhoneFilter,
} from "~/modules/mail/mail-phone-view"
import { MailboxDowngradeAlarmHost } from "~/modules/mailbox/MailboxDowngradeAlarmHost"
import { MailboxJobsHost } from "~/modules/mailbox/MailboxJobsHost"
import { MailboxLockedPanel } from "~/modules/mailbox/MailboxLockedPanel"
import {
  claimLandingUnlockPrompt,
  loadMailboxKeyring,
  mailboxStore,
} from "~/modules/mailbox/mailbox-store"
import { requestMailboxUnlock } from "~/modules/mailbox/mailbox-unlock-bus"
import { MailSearchIndexBanner } from "~/modules/mailbox/search-index/MailSearchIndexBanner"
import { appSettingsPath } from "~/modules/settings/settings-aliases"
import { useApi } from "~/modules/shell/ApiContext"
import { openPhoneNavigator } from "~/modules/shell/phone-navigator-store"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab } from "~/modules/shell/tab-store"
import { Button } from "~/ui/Button"
import { OverlaySheet } from "~/ui/OverlaySheet"
import { SwipeRow } from "~/ui/SwipeRow"

// The convert flow is the tickets module's own dialog, opened here rather than
// copied: a swipe action that converted through a second code path would drift
// from the one the desktop header offers.
const MailConvertToTicketDialog = lazy(() =>
  import("~/modules/tickets/MailConvertToTicketDialog").then((m) => ({
    default: m.MailConvertToTicketDialog,
  })),
)

interface MailInboxProps {
  entityId: string
}

function viewFromEntityId(entityId: string) {
  if (entityId === "inbox:assigned-to-me") return "assigned-to-me"
  if (entityId.startsWith("inbox:account:"))
    return `inbox:${entityId.slice("inbox:account:".length)}`
  return entityId || "inbox"
}

export const MailInbox: Component<MailInboxProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  let scrollRef!: HTMLDivElement
  const [searchQuery, setSearchQuery] = createSignal("")

  function matchesSearch(id: string): boolean {
    const q = searchQuery().toLowerCase()
    if (!q) return true
    const conv = conversationStore.byId[id]
    if (!conv) return false
    return (
      (conv.subject ?? "").toLowerCase().includes(q) ||
      (conv.senderName ?? "").toLowerCase().includes(q) ||
      (conv.senderEmail ?? "").toLowerCase().includes(q) ||
      (conv.snippet ?? "").toLowerCase().includes(q)
    )
  }

  // --- Phone tier (M2-2 T14) ---
  // A JS branch rather than a `md:` class pair: the swipe rail, the long press
  // sheet and the segmented filter are stateful, and a second copy of the
  // markup behind a media query would be a second copy of that state.
  const phone = () => shellTier() === "phone"
  const [phoneFilter, setPhoneFilter] = createSignal<MailPhoneFilter>("all")
  const [sheetFor, setSheetFor] = createSignal<string | null>(null)
  const [convertFor, setConvertFor] = createSignal<string | null>(null)

  const folderTitle = () => i18n.t(mailFolderLabelKey(currentView()))
  const accountLine = () => mailAccountLine(currentView(), allAccounts())
  const accountLineText = () => {
    const line = accountLine()
    if (line.kind === "address") return line.address
    if (line.kind === "all") return i18n.t("kernel.mailAllAccounts", { count: line.count })
    return ""
  }
  const phoneUnreadCount = () =>
    conversationStore.ids.filter((id) => conversationStore.byId[id]?.isRead === false).length

  // The loaded rows that match, plus what the search over the whole view found
  // beyond the loaded pages, newest first.
  function searchedIds(): string[] {
    const local = conversationStore.ids.filter(matchesSearch)
    if (!searchQuery() || conversationStore.searchIds.length === 0) return local
    const seen = new Set(local)
    const extra = conversationStore.searchIds.filter(
      (id) => !seen.has(id) && !!conversationStore.byId[id],
    )
    if (extra.length === 0) return local
    const at = (id: string) => Date.parse(conversationStore.byId[id]?.lastMessageAt ?? "") || 0
    return [...local, ...extra].sort((a, b) => at(b) - at(a))
  }

  const filteredIds = createMemo(() => {
    const bySearch = searchedIds()
    if (!phone()) return bySearch
    const filter = phoneFilter()
    return bySearch.filter((id) => {
      const conv = conversationStore.byId[id]
      return !!conv && matchesMailPhoneFilter(conv, filter)
    })
  })
  const conversationLoadOptions = () => ({ currentUserId: userFromToken()?.userId ?? null })

  function openCompose(): void {
    openTab({ type: "mail:compose", entityId: "compose", label: i18n.t("kernel.mailCompose") })
  }

  // The mailbox lock state, known from the keyring (enrolled and not unlocked
  // in this page) or, when that read failed, from a row the worker could not
  // open. A device that unlocked during this login re-opens from its persisted
  // handles at startup; one that did not asks once per page load, right away.
  const anyRowLocked = () =>
    conversationStore.ids.some((id) => conversationStore.byId[id]?.encState === "locked")
  const mailboxLocked = () =>
    mailboxStore.status === "locked" || (mailboxStore.status === "unknown" && anyRowLocked())
  // The landing prompt waits for the lock state to be KNOWN: while the status
  // is still "unknown" the startup restore may be about to open the mailbox,
  // and a prompt raised now would ask for a password nobody needs.
  createEffect(() => {
    if (mailboxStore.status === "locked" && claimLandingUnlockPrompt()) requestMailboxUnlock()
  })
  // While the mailbox is locked, a sealed row the browser has not opened has
  // no subject and no snippet to show. It is never listed as a blank row: the
  // unlock panel stands in for it, and only rows that can be read stay.
  const hiddenWhileLocked = (id: string) => {
    const conv = conversationStore.byId[id]
    return !!conv?.sealed && conv.encState !== "opened"
  }
  const listedIds = createMemo(() =>
    mailboxLocked() ? filteredIds().filter((id) => !hiddenWhileLocked(id)) : filteredIds(),
  )
  // Decided on the whole list, not the searched one, so a search that matches
  // nothing never takes the search box away.
  const lockedPanelOnly = () =>
    mailboxLocked() && conversationStore.ids.every((id) => hiddenWhileLocked(id))
  const lockedPanel = () => (
    <div class="flex flex-1 flex-col" data-testid="mail-inbox-locked">
      <MailboxLockedPanel
        variant="page"
        devicePrfMismatch={mailboxStore.lastErrorCode === "MAILBOX_DEVICE_PRF_MISMATCH"}
      />
    </div>
  )

  onMount(() => {
    setView(viewFromEntityId(props.entityId) as any)
    void loadAccounts(api)
    // Best effort: a failed read leaves the state unknown and the rows say it.
    void loadMailboxKeyring(api).catch(() => {})
    if (currentView() === "drafts") {
      void loadDrafts(api)
    } else {
      void loadConversations(api, conversationLoadOptions())
    }
  })

  // Gmail's Primary / Other (S13): only where the mailbox is Gmail. The scope
  // is a dependency of the load too, so a Gmail account that arrives after the
  // first load reloads the list under its remembered category.
  const categoryScope = () => mailCategoryScope(currentView(), allAccounts())
  const category = () => mailCategoryFor(categoryScope(), allAccounts())
  function chooseCategory(next: MailCategory): void {
    const scope = categoryScope()
    if (!scope || category() === next) return
    setMailCategory(scope, next)
    void loadConversations(api, conversationLoadOptions())
  }

  createEffect(
    on(
      [currentView, categoryScope],
      ([view]) => {
        if (view === "drafts") {
          void loadDrafts(api)
        } else {
          void loadConversations(api, conversationLoadOptions())
        }
      },
      { defer: true },
    ),
  )

  // Search beyond the loaded pages: only while more pages exist (a fully
  // loaded list is answered by the filter above alone), after a pause in typing.
  const DEEP_SEARCH_DEBOUNCE_MS = 300
  const [debouncing, setDebouncing] = createSignal(false)
  createEffect(
    on([() => searchQuery().trim(), currentView, hasMore], ([query, view, more]) => {
      if (query.length < 2 || !more || view === "drafts") {
        setDebouncing(false)
        clearDeepSearch()
        return
      }
      // A new query drops the previous one's results and any answer in flight.
      clearDeepSearch()
      setDebouncing(true)
      const timer = setTimeout(() => {
        setDebouncing(false)
        void searchAllConversations(api, query, conversationLoadOptions())
      }, DEEP_SEARCH_DEBOUNCE_MS)
      onCleanup(() => clearTimeout(timer))
    }),
  )
  const searchingDeep = () => debouncing() || deepSearching()

  function handleScroll(): void {
    if (!scrollRef) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef
    if (scrollHeight - scrollTop - clientHeight < 200 && hasMore() && !loadingMore()) {
      void loadMoreConversations(api, conversationLoadOptions())
    }
  }

  function openConversation(convId: string, subject: string, sealed = false): void {
    openTab({
      type: "mail:conversation",
      entityId: convId,
      label: subject || i18n.t(sealed ? "mail.lockedConversation" : "mail.noSubject"),
    })
  }

  function openComposeDraft(draftId: string, subject: string): void {
    openTab({
      type: "mail:compose",
      entityId: draftId,
      label: subject || i18n.t("mail.draft"),
    })
  }

  const noAccounts = () => accountsLoaded() && allAccounts().length === 0
  const isEmpty = () => conversationStore.ids.length === 0
  const isDraftsView = () => currentView() === "drafts"

  return (
    <div class="flex flex-col h-full" data-testid="mail-inbox">
      {/* The unlock surface lives over the mail view so a locked message can
          ask for it without the reader losing their place. */}
      {/* The downgrade detector's alarm (spec section 9.2). An operator who
          stopped sealing new mail would otherwise be invisible, so this sits
          above the list and cannot be dismissed. */}
      <MailboxDowngradeAlarmHost userId={userFromToken()?.userId ?? null} />
      {/* A personal mailbox that is not `ready` fetches no mail. This is the
          only place the reader is told that, so it sits above the list rather
          than inside a settings page nobody opens. */}
      <MailEncryptionEnrollmentBanner />
      {/* The first import of a mailbox runs for a long time. While it does,
          the list below is incomplete and this is what says so. */}
      <MailSyncProgressBanner />
      {/* Work the server can no longer do for an encrypted mailbox runs here,
          in this tab, while it is unlocked. The badge is how the user sees what
          is waiting: "runs when you are next online" is only honest if it is
          visible. */}
      <MailboxJobsHost />

      {/* The screen's own large title. It names the FOLDER, with the account
          under it, because at phone width the sidebar that used to answer both
          questions is behind the navigator sheet: tapping the title is how the
          reader gets back to it. */}
      <Show when={phone()}>
        <div class="flex shrink-0 items-start gap-2 px-4 pb-1 pt-3" data-testid="mail-phone-header">
          <button
            type="button"
            data-testid="mail-phone-title"
            aria-label={i18n.t("kernel.mailChooseFolder")}
            class="flex min-w-0 flex-1 flex-col items-start rounded-md text-left"
            onClick={() => openPhoneNavigator()}
          >
            <span class="max-w-full truncate text-[28px] font-bold leading-tight text-text">
              {folderTitle()}
            </span>
            <Show when={accountLineText()}>
              <span
                data-testid="mail-phone-account"
                class="max-w-full truncate text-[13px] text-text-tertiary"
              >
                {accountLineText()}
              </span>
            </Show>
          </button>
          <button
            type="button"
            data-testid="mail-phone-compose"
            data-tour-tier="phone"
            aria-label={i18n.t("kernel.mailCompose")}
            class="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-accent hover:bg-surface-hover"
            onClick={() => openCompose()}
          >
            <PenSquare size={20} />
          </button>
        </div>
        <div
          class="flex shrink-0 gap-2 overflow-x-auto px-4 pb-2"
          data-testid="mail-filter-row"
          data-tour-tier="phone"
          role="tablist"
        >
          <For each={MAIL_PHONE_FILTERS}>
            {(filter) => (
              <button
                type="button"
                role="tab"
                data-testid={`mail-filter-${filter}`}
                data-active={phoneFilter() === filter ? "true" : "false"}
                aria-selected={phoneFilter() === filter}
                class={cn(
                  "flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px]",
                  phoneFilter() === filter
                    ? "bg-accent text-accent-foreground"
                    : "bg-surface-sunken text-text-secondary",
                )}
                onClick={() => setPhoneFilter(filter)}
              >
                {i18n.t(
                  filter === "unread"
                    ? "kernel.mailFilterUnread"
                    : filter === "starred"
                      ? "kernel.mailFilterStarred"
                      : "kernel.mailFilterAll",
                )}
                <Show when={filter === "unread" && phoneUnreadCount() > 0}>
                  <span class="tabular-nums opacity-70" data-testid="mail-filter-unread-count">
                    {phoneUnreadCount()}
                  </span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={loading()}>
        <div class="flex-1 flex items-center justify-center">
          <div class="animate-spin rounded-full h-6 w-6 border-2 border-accent border-t-transparent" />
        </div>
      </Show>

      <Show when={!loading()}>
        <Show when={isDraftsView()}>
          <DraftsList onOpenDraft={openComposeDraft} />
        </Show>

        <Show when={!isDraftsView()}>
          <Show
            when={noAccounts() && isEmpty()}
            fallback={
              <Show when={!lockedPanelOnly()} fallback={lockedPanel()}>
                <div class="border-b border-border px-3 py-2">
                  <Show when={categoryScope()}>
                    <div
                      class="mb-2 flex gap-1"
                      role="tablist"
                      data-testid="mail-category-switch"
                      aria-label={i18n.t("mail.categorySwitch")}
                    >
                      <For each={["all", "primary", "other"] as const}>
                        {(option) => (
                          <button
                            type="button"
                            role="tab"
                            data-testid={`mail-category-${option}`}
                            aria-selected={category() === option}
                            class={cn(
                              "rounded-md px-2.5 py-1 text-[12.5px] transition-colors",
                              category() === option
                                ? "bg-surface-hover font-medium text-text"
                                : "text-text-secondary hover:bg-surface-hover/60",
                            )}
                            onClick={() => chooseCategory(option)}
                          >
                            {i18n.t(
                              option === "primary"
                                ? "mail.categoryPrimary"
                                : option === "other"
                                  ? "mail.categoryOther"
                                  : "mail.categoryAll",
                            )}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  {/* Whenever the client index cannot answer in full, it says
                      so here. No banner means the results are complete. */}
                  <MailSearchIndexBanner />
                  <div class="mt-2 flex items-center gap-2 rounded-md bg-surface-hover px-2 py-1.5 first:mt-0">
                    <Search size={14} class="text-text-tertiary shrink-0" />
                    <input
                      data-testid="mail-inbox-search"
                      type="text"
                      placeholder={i18n.t("mail.searchConversations")}
                      class="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
                      value={searchQuery()}
                      onInput={(e) => setSearchQuery(e.currentTarget.value)}
                    />
                  </div>
                </div>
                <div ref={scrollRef!} class="flex-1 overflow-y-auto" onScroll={handleScroll}>
                  {/* A locked mailbox that still lists readable rows says so
                      above them, with the way to open the rest. */}
                  <Show when={mailboxLocked()}>{lockedPanel()}</Show>
                  <Show when={listedIds().length === 0}>
                    <div class="flex items-center justify-center py-12 text-text-secondary text-sm">
                      {searchQuery()
                        ? i18n.t(
                            searchingDeep()
                              ? "mail.searchingConversations"
                              : "mail.noMatchingConversations",
                          )
                        : i18n.t("mail.noConversations")}
                    </div>
                  </Show>

                  <For each={listedIds()}>
                    {(id) => {
                      const conv = () => conversationStore.byId[id]
                      const senderLabel = () =>
                        conv().senderName ?? conv().senderEmail ?? i18n.t("mail.unknownSender")
                      const showAssignmentControls = () =>
                        getAccount(conv().accountId)?.ownerType === "org" &&
                        currentView() !== "assigned-to-me"

                      return (
                        <Show when={conv()}>
                          {/* Phone: a 72px row a thumb can read at arm's length
                              and swipe, with the hover only controls the
                              desktop row carries moved into the long press
                              sheet below. */}
                          <Show when={phone()}>
                            <SwipeRow
                              testid={`mail-swipe-${id}`}
                              class="border-b border-border"
                              onLongPress={() => setSheetFor(id)}
                              actions={[
                                {
                                  label: i18n.t("kernel.mailArchive"),
                                  onSelect: () => void archiveConversation(api, id),
                                },
                                {
                                  label: i18n.t("kernel.mailConvertToTicket"),
                                  tone: "accent",
                                  onSelect: () => setConvertFor(id),
                                },
                              ]}
                            >
                              <button
                                type="button"
                                data-testid="conversation-row"
                                data-conversation-id={id}
                                data-unread={!conv().isRead ? "true" : undefined}
                                class="flex min-h-[72px] w-full items-center gap-3 px-4 py-2 text-left"
                                onClick={() => openConversation(id, conv().subject, conv().sealed)}
                              >
                                <span
                                  data-testid="mail-row-avatar"
                                  class={cn(
                                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white",
                                    "bg-accent",
                                  )}
                                  aria-hidden="true"
                                >
                                  {senderLabel().trim().slice(0, 1).toUpperCase() || "?"}
                                </span>
                                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                                  <span class="flex items-center gap-2">
                                    <Show when={!conv().isRead}>
                                      <span
                                        data-testid="conversation-row-unread"
                                        class="h-2 w-2 shrink-0 rounded-full bg-accent"
                                      />
                                    </Show>
                                    <span
                                      class={cn(
                                        "min-w-0 flex-1 truncate text-[15px]",
                                        !conv().isRead
                                          ? "font-semibold text-text"
                                          : "text-text-secondary",
                                      )}
                                      data-testid="mail-row-sender"
                                    >
                                      {senderLabel()}
                                    </span>
                                    <span
                                      data-testid="conversation-row-timestamp"
                                      class="shrink-0 whitespace-nowrap text-[12px] tabular-nums text-text-tertiary"
                                    >
                                      {formatRelativeTime(conv().lastMessageAt, i18n.locale())}
                                    </span>
                                  </span>
                                  <span
                                    class="truncate text-[14px] text-text"
                                    data-testid="mail-row-subject"
                                  >
                                    <Show
                                      when={conv().subject || !conv().sealed}
                                      fallback={
                                        <span
                                          class="inline-flex items-center gap-1 text-text-tertiary"
                                          data-testid="conversation-row-locked"
                                        >
                                          <Lock size={12} aria-hidden="true" />
                                          {i18n.t("mail.lockedConversation")}
                                        </span>
                                      }
                                    >
                                      {conv().subject || i18n.t("kernel.mailNoSubject")}
                                    </Show>
                                  </span>
                                  <span
                                    class="truncate text-[13px] text-text-tertiary"
                                    data-testid="mail-row-preview"
                                  >
                                    {conv().snippet}
                                  </span>
                                </span>
                              </button>
                            </SwipeRow>
                          </Show>

                          <Show when={!phone()}>
                            <div
                              data-testid="conversation-row"
                              data-conversation-id={id}
                              data-unread={!conv().isRead ? "true" : undefined}
                              class="group flex items-center gap-3 border-b border-border px-4 py-3 transition-colors hover:bg-surface-hover"
                            >
                              <button
                                type="button"
                                class="min-w-0 flex-1 text-left"
                                onClick={() => openConversation(id, conv().subject, conv().sealed)}
                              >
                                <div class="flex items-center gap-2">
                                  <Show when={!conv().isRead}>
                                    <span
                                      data-testid="conversation-row-unread"
                                      class="h-2 w-2 shrink-0 rounded-full bg-accent"
                                    />
                                  </Show>
                                  <span
                                    class={cn(
                                      "truncate text-sm",
                                      !conv().isRead
                                        ? "font-semibold text-text"
                                        : "text-text-secondary",
                                    )}
                                  >
                                    {senderLabel()}
                                  </span>
                                </div>
                                <p
                                  class={cn(
                                    "mt-0.5 truncate text-sm",
                                    !conv().isRead
                                      ? "font-semibold text-text"
                                      : "text-text-secondary",
                                  )}
                                >
                                  <Show
                                    when={conv().subject || !conv().sealed}
                                    fallback={
                                      <span
                                        class="inline-flex items-center gap-1 text-text-tertiary"
                                        data-testid="conversation-row-locked"
                                      >
                                        <Lock size={12} aria-hidden="true" />
                                        {i18n.t("mail.lockedConversation")}
                                      </span>
                                    }
                                  >
                                    {conv().subject || i18n.t("mail.noSubject")}
                                  </Show>
                                </p>
                                <p class="mt-0.5 truncate text-xs text-text-tertiary">
                                  {conv().snippet}
                                </p>
                              </button>
                              <Show when={showAssignmentControls()}>
                                <Show
                                  when={conv().assignedTo}
                                  fallback={
                                    <button
                                      type="button"
                                      data-testid="conversation-claim"
                                      class="rounded-md border border-border px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-hover hover:text-text"
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        const userId = userFromToken()?.userId
                                        if (userId) void claimConversation(api, id, userId)
                                      }}
                                    >
                                      {i18n.t("mail.claim")}
                                    </button>
                                  }
                                >
                                  <AssigneePicker
                                    assignedTo={conv().assignedTo!}
                                    accountId={conv().accountId}
                                    onReassign={(userId) => reassignConversation(api, id, userId)}
                                  />
                                </Show>
                              </Show>
                              <div class="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                <button
                                  type="button"
                                  data-testid="conversation-row-mark-read"
                                  class="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text"
                                  onClick={() => void toggleRead(api, id)}
                                  title={
                                    conv().isRead
                                      ? i18n.t("mail.markUnread")
                                      : i18n.t("mail.markRead")
                                  }
                                >
                                  {conv().isRead ? <MailOpen size={14} /> : <MailCheck size={14} />}
                                </button>
                                <button
                                  type="button"
                                  data-testid="conversation-row-archive"
                                  class="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text"
                                  onClick={() => void archiveConversation(api, id)}
                                  title={i18n.t("mail.archive")}
                                >
                                  <Archive size={14} />
                                </button>
                                <button
                                  type="button"
                                  data-testid="conversation-row-star"
                                  class={cn(
                                    "rounded p-1 transition-colors",
                                    conv().isStarred
                                      ? "text-yellow-500"
                                      : "text-text-tertiary hover:bg-surface-hover hover:text-yellow-500",
                                  )}
                                  onClick={() => void toggleStar(api, id)}
                                  title={
                                    conv().isStarred ? i18n.t("mail.unstar") : i18n.t("mail.star")
                                  }
                                >
                                  <Star
                                    size={14}
                                    fill={conv().isStarred ? "currentColor" : "none"}
                                  />
                                </button>
                              </div>
                              <div
                                data-testid="conversation-row-timestamp"
                                class="shrink-0 text-xs text-text-tertiary group-hover:hidden group-focus-within:hidden"
                              >
                                <span class="text-xs text-text-tertiary">
                                  {formatRelativeTime(conv().lastMessageAt, i18n.locale())}
                                </span>
                              </div>
                            </div>
                          </Show>
                        </Show>
                      )
                    }}
                  </For>

                  <Show when={loadingMore()}>
                    <div class="flex justify-center py-4">
                      <div class="animate-spin rounded-full h-5 w-5 border-2 border-accent border-t-transparent" />
                    </div>
                  </Show>
                </div>
              </Show>
            }
          >
            <div
              data-testid="mail-empty-state-connect"
              class="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8"
            >
              <Mail size={28} class="text-text-tertiary" aria-hidden="true" />
              <p class="text-text-secondary">{i18n.t("mail.connectAnEmailAccountToGet")}</p>
              {/* Opens Settings > Mail, where the mailboxes are connected. */}
              <Button
                variant="primary"
                size="sm"
                data-testid="mail-empty-state-connect-button"
                onClick={() =>
                  openTab({
                    type: "kernel:settings",
                    entityId: "settings",
                    label: i18n.t("mail.emailAccounts"),
                    routePath: appSettingsPath("mail"),
                  })
                }
              >
                {i18n.t("mail.connectAnAccount")}
              </Button>
            </div>
          </Show>
        </Show>
      </Show>

      {/* The long press sheet: the row controls the desktop reveals on hover.
          A phone has no hover, so this is the only place they exist. */}
      <OverlaySheet
        open={sheetFor() !== null}
        onClose={() => setSheetFor(null)}
        variant="bottom"
        title={i18n.t("kernel.mailRowActions")}
        closeLabel={i18n.t("kernel.close")}
      >
        <Show when={sheetFor()}>
          {(id) => {
            const conv = () => conversationStore.byId[id()]
            const isShared = () => getAccount(conv()?.accountId ?? "")?.ownerType === "org"
            return (
              <div data-testid="mail-row-sheet">
                <button
                  type="button"
                  data-testid="mail-sheet-read"
                  class={phoneSheetRowClass}
                  onClick={() => {
                    const target = id()
                    setSheetFor(null)
                    void toggleRead(api, target)
                  }}
                >
                  {conv()?.isRead ? i18n.t("kernel.mailMarkUnread") : i18n.t("kernel.mailMarkRead")}
                </button>
                <button
                  type="button"
                  data-testid="mail-sheet-star"
                  class={phoneSheetRowClass}
                  onClick={() => {
                    const target = id()
                    setSheetFor(null)
                    void toggleStar(api, target)
                  }}
                >
                  {conv()?.isStarred ? i18n.t("kernel.mailUnstar") : i18n.t("kernel.mailStar")}
                </button>
                {/* M2-2 T16: claim and release on a SHARED mailbox, the same
                    two store calls the desktop row's Claim chip and assignee
                    picker make. */}
                <Show when={isShared()}>
                  <Show
                    when={conv()?.assignedTo}
                    fallback={
                      <button
                        type="button"
                        data-testid="mail-sheet-claim"
                        class={phoneSheetRowClass}
                        onClick={() => {
                          const target = id()
                          const userId = userFromToken()?.userId
                          setSheetFor(null)
                          if (userId) void claimConversation(api, target, userId)
                        }}
                      >
                        {i18n.t("kernel.mailClaim")}
                      </button>
                    }
                  >
                    <button
                      type="button"
                      data-testid="mail-sheet-release"
                      class={phoneSheetRowClass}
                      onClick={() => {
                        const target = id()
                        setSheetFor(null)
                        void unassignConversation(api, target)
                      }}
                    >
                      {i18n.t("kernel.mailRelease")}
                    </button>
                  </Show>
                </Show>
              </div>
            )
          }}
        </Show>
      </OverlaySheet>

      <Show when={convertFor()}>
        {(id) => (
          <MailConvertToTicketDialog
            mailConversationId={id()}
            onClose={() => setConvertFor(null)}
          />
        )}
      </Show>
    </div>
  )
}

/** One row of a phone action sheet: full width, 44px tall, left aligned. */
const phoneSheetRowClass =
  "flex min-h-11 w-full items-center px-4 py-3 text-left text-[15px] text-text hover:bg-surface-hover"

const DraftsList: Component<{ onOpenDraft: (id: string, subject: string) => void }> = (props) => {
  const i18n = useI18n()
  const draftList = () => Object.values(drafts())

  return (
    <div class="flex-1 overflow-y-auto">
      <Show when={draftList().length === 0}>
        <div class="flex items-center justify-center py-12 text-text-secondary text-sm">
          {i18n.t("mail.noDrafts")}
        </div>
      </Show>
      <For each={draftList()}>
        {(draft) => (
          <button
            type="button"
            class="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-surface-hover"
            onClick={() => {
              if (draft.conversationId) {
                openTab({
                  type: "mail:conversation",
                  entityId: draft.conversationId,
                  label:
                    draft.subject ||
                    i18n.t(draft.sealed ? "mail.lockedConversation" : "mail.noSubject"),
                })
              } else {
                props.onOpenDraft(
                  draft.id,
                  draft.subject || (draft.sealed ? i18n.t("mail.lockedConversation") : ""),
                )
              }
            }}
          >
            <div class="min-w-0 flex-1">
              <span class="text-sm text-text-secondary">
                {Array.isArray(draft.to) && draft.to.length > 0
                  ? draft.to.map((a: any) => a.name ?? a.email).join(", ")
                  : i18n.t("mail.noRecipients")}
              </span>
              <p class="mt-0.5 truncate text-xs text-text-tertiary">
                <Show
                  when={draft.subject || !draft.sealed}
                  fallback={
                    <span class="inline-flex items-center gap-1" data-testid="draft-row-locked">
                      <Lock size={12} aria-hidden="true" />
                      {i18n.t("mail.lockedConversation")}
                    </span>
                  }
                >
                  {draft.subject || i18n.t("mail.noSubject")}
                </Show>
              </p>
            </div>
          </button>
        )}
      </For>
    </div>
  )
}

function formatRelativeTime(iso: string, locale: string): string {
  return compactAge(iso, locale)
}
