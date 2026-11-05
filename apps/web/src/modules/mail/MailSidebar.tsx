// SPDX-License-Identifier: FSL-1.1-ALv2

import { FileText, Inbox, Plus, Send, Star, Trash2, UserCheck } from "lucide-solid"
import { type Component, createMemo, For, onMount, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  allAccounts,
  loadAccounts,
  personalAccounts,
  sharedAccounts,
} from "~/modules/mail/mail-account-store"
import {
  assignedToMeCount,
  currentView,
  setView,
  type ViewType,
} from "~/modules/mail/mail-conversation-store"
import { drafts } from "~/modules/mail/mail-draft-store"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"

export const MailSidebar: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const showSubItems = createMemo(() => allAccounts().length > 1)
  const draftCount = createMemo(() => Object.keys(drafts()).length)
  const inboxCount = createMemo(() =>
    allAccounts().reduce((total, account) => total + account.unreadCount, 0),
  )
  const personalInboxCount = createMemo(() =>
    personalAccounts().reduce((total, account) => total + account.unreadCount, 0),
  )

  onMount(() => {
    void loadAccounts(api)
  })

  function navigate(view: ViewType): void {
    setView(view)
    const entityId =
      view === "assigned-to-me"
        ? "inbox:assigned-to-me"
        : view.startsWith("inbox:") && view !== "inbox:personal"
          ? `inbox:account:${view.slice(6)}`
          : view
    openTab({
      type: "mail:inbox",
      entityId,
      label: i18n.t("mail.mail2"),
    })
  }

  function openCompose(): void {
    openTab({
      type: "mail:compose",
      entityId: "compose",
      label: i18n.t("mail.newEmail"),
    })
  }

  const isActive = (view: ViewType) => currentView() === view

  return (
    <div
      class="flex h-full min-h-0 flex-col overflow-y-auto py-4"
      data-testid="mail-sidebar"
      data-tour-tier="wide"
    >
      <div class="px-3 mb-4">
        <button
          type="button"
          data-testid="mail-compose-btn"
          class="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:bg-accent/90 transition-colors"
          onClick={openCompose}
        >
          <Plus size={16} />
          {i18n.t("mail.compose")}
        </button>
      </div>

      <nav class="flex flex-col gap-0.5 px-2" data-testid="mail-folders" data-tour-tier="wide">
        <SidebarItem
          icon={Inbox}
          label={i18n.t("mail.inbox")}
          active={isActive("inbox")}
          onClick={() => navigate("inbox")}
          count={inboxCount() || undefined}
          testId="mail-nav-inbox"
        />

        <SidebarItem
          icon={UserCheck}
          label={i18n.t("mail.assignedToMe")}
          active={isActive("assigned-to-me")}
          onClick={() => navigate("assigned-to-me")}
          count={assignedToMeCount() || undefined}
          testId="mail-sidebar-assigned-to-me"
        />

        <Show when={showSubItems()}>
          <Show when={personalAccounts().length > 0}>
            <SidebarItem
              icon={null}
              label={i18n.t("mail.personal")}
              active={isActive("inbox:personal")}
              onClick={() => navigate("inbox:personal")}
              indent
              count={personalInboxCount() || undefined}
            />
          </Show>
          <For each={sharedAccounts()}>
            {(account) => (
              <SidebarItem
                icon={null}
                label={account.displayName ?? account.emailAddress}
                active={isActive(`inbox:${account.id}` as ViewType)}
                onClick={() => navigate(`inbox:${account.id}` as ViewType)}
                indent
                count={account.unreadCount || undefined}
              />
            )}
          </For>
        </Show>

        <SidebarItem
          icon={Star}
          label={i18n.t("mail.starred")}
          active={isActive("starred")}
          onClick={() => navigate("starred")}
          testId="mail-nav-starred"
        />
        <SidebarItem
          icon={Send}
          label={i18n.t("mail.sent")}
          active={isActive("sent")}
          onClick={() => navigate("sent")}
          testId="mail-nav-sent"
        />
        <SidebarItem
          icon={FileText}
          label={i18n.t("mail.drafts")}
          active={isActive("drafts")}
          onClick={() => navigate("drafts")}
          count={draftCount() || undefined}
          testId="mail-nav-drafts"
        />
        <SidebarItem
          icon={Trash2}
          label={i18n.t("mail.trash")}
          active={isActive("trash")}
          onClick={() => navigate("trash")}
          testId="mail-nav-trash"
        />
      </nav>
    </div>
  )
}

const SidebarItem: Component<{
  icon: Component<{ size?: number }> | null
  label: string
  active: boolean
  onClick: () => void
  indent?: boolean
  count?: number
  testId?: string
}> = (props) => {
  const Icon = () => props.icon
  return (
    <button
      type="button"
      data-testid={props.testId}
      class={cn(
        "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors duration-150 text-left w-full",
        props.indent && "pl-8",
        props.active
          ? "bg-surface-active text-text font-medium"
          : "text-text-secondary hover:bg-surface-hover hover:text-text",
      )}
      onClick={props.onClick}
    >
      <Show when={Icon()}>{(CurrentIcon) => <Dynamic component={CurrentIcon()} size={16} />}</Show>
      <span class="flex-1 truncate">{props.label}</span>
      <Show when={props.count}>
        <span class="text-xs text-text-tertiary">{props.count}</span>
      </Show>
    </button>
  )
}
