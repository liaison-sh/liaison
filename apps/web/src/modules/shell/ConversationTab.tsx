// SPDX-License-Identifier: FSL-1.1-ALv2
import { ExternalLink, Minus, X } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { userFromToken } from "~/modules/auth/auth-store"
import {
  localPromptWaitingIn,
  PERMISSION_WAITING_BADGE,
} from "~/modules/desktop/LocalPermissionCard"
import { useI18n } from "~/modules/i18n/i18n-context"
import { pluralFormFor } from "~/modules/projects/plural"
import { DockAvatar, dockPresence } from "~/modules/shell/DockAvatar"
import { DockSurfaceBoundary } from "~/modules/shell/DockSurfaceBoundary"
import { DockWindow } from "~/modules/shell/DockWindow"
import {
  close,
  collapse,
  DOCK_BADGE_CLASS,
  DOCK_ITEM_MAX_WIDTH,
  DOCK_PILL_CLASS,
  type DockTab,
  expand,
} from "~/modules/shell/dock-store"
import { openTab } from "~/modules/shell/tab-store"
import AgentStateLabel from "~/modules/threads/AgentStateLabel"
import { openAgentPage } from "~/modules/threads/agent-directory"
import { conversationDisplayName, isChannel } from "~/modules/threads/conversation-display"
import OutsideTextMark from "~/modules/threads/OutsideTextMark"
import ThreadRuntimeSlot, { dmAgentSeat } from "~/modules/threads/ThreadRuntimeSlot"
import ThreadView from "~/modules/threads/ThreadView"
import { getThread } from "~/modules/threads/thread-store"
import { Button } from "~/ui/Button"
import { Tooltip } from "~/ui/Tooltip"

interface ConversationTabProps {
  tab: DockTab
}

// The window header's ghost buttons: 28px, radius 6 (`rounded-md`), tertiary
// text with a hover surface, the same treatment as ThreadHeader's actions-menu
// trigger. One shared class rather than one per button.
const ICON_BUTTON_CLASS =
  "flex h-7 w-7 items-center justify-center rounded-md p-0 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"

/**
 * An open dock conversation: an ITEM on the dock bar (avatar, name, unread,
 * close) and, while `tab.expanded`, its WINDOW floating above the bar, right
 * aligned with the item: a compact header over the real ThreadView (dock
 * surface, no second ThreadHeader). The item stays on the bar while the window
 * is open, marked active; pressing it again minimises the window.
 */
const ConversationTab: Component<ConversationTabProps> = (props) => {
  const i18n = useI18n()
  const currentUserId = () => userFromToken()?.userId ?? ""
  const thread = () => getThread(props.tab.threadId)

  const name = () => {
    const t = thread()
    if (!t) return i18n.t("kernel.dock.conversation")
    return conversationDisplayName(t, currentUserId())
  }

  const unread = () => thread()?.unreadCount ?? 0
  const active = () => props.tab.expanded

  // The one predicate, shared with the thread header that holds the same
  // conversation in Home (ThreadRuntimeSlot.tsx, P4c-T19). This tab reads it
  // for the agent state label; the runtime control in the header row below
  // reads it through the slot itself.
  const dmAgentId = (): string | null => {
    const t = thread()
    if (!t) return null
    return (
      dmAgentSeat({
        threadId: props.tab.threadId,
        title: t.title,
        threadType: t.type,
        currentUserId: currentUserId(),
        participants: t.participants,
      })?.id ?? null
    )
  }

  /** The window header's second line, from what the client really knows: the
   *  agent's turn state (AgentStateLabel, rendered below), a channel's member
   *  count, or "Active now" for a DM whose person is online. */
  const statusText = (): string | null => {
    const t = thread()
    if (!t || dmAgentId()) return null
    if (isChannel(t, currentUserId())) {
      const count = t.participants.length
      if (count === 0) return null
      return i18n.t(
        pluralFormFor(i18n.locale(), count) === "one"
          ? "kernel.dock.membersOne"
          : "kernel.dock.membersMany",
        { count },
      )
    }
    return dockPresence(props.tab.threadId) === "online" ? i18n.t("kernel.dock.activeNow") : null
  }

  function handleOpenInHome() {
    openTab({ type: "thread", entityId: props.tab.threadId, label: name() })
    close(props.tab.threadId)
  }

  return (
    <div
      class="relative flex h-full"
      data-dock-tab={props.tab.threadId}
      data-expanded={props.tab.expanded ? "true" : "false"}
      data-active={active() ? "true" : "false"}
    >
      {/* The ITEM. The whole item is the hover surface; the name button and
          the close button are siblings inside it, never nested. */}
      <div
        data-dock-pill
        class={cn(DOCK_PILL_CLASS, "group/item gap-0 pr-1 pl-0", active() && "bg-surface-hover")}
        style={{ "max-width": `${DOCK_ITEM_MAX_WIDTH}px` }}
      >
        <button
          type="button"
          data-testid="dock-tab-toggle"
          aria-expanded={active() ? "true" : "false"}
          class="flex h-full min-w-0 items-center gap-1.5 pl-2 pr-1 outline-none"
          onClick={() => (active() ? collapse(props.tab.threadId) : expand(props.tab.threadId))}
        >
          <DockAvatar threadId={props.tab.threadId} size={20} />
          <span
            data-testid="dock-tab-name"
            class={`truncate ${unread() > 0 ? "font-semibold text-text" : "text-text-secondary"} ${active() ? "text-text" : ""}`}
          >
            {name()}
          </span>
          {/* A LOCAL TURN PARKED ON A QUESTION (2026-09-23). Collapsed, the
              conversation gave no sign that a command on this computer was
              waiting for an Allow, and the turn sat there unnoticed. */}
          <Show when={localPromptWaitingIn(props.tab.threadId)}>
            <span
              data-testid="dock-tab-permission"
              role="status"
              aria-label={i18n.t(PERMISSION_WAITING_BADGE)}
              title={i18n.t(PERMISSION_WAITING_BADGE)}
              class="inline-flex h-4 min-w-4 shrink-0 animate-pulse items-center justify-center rounded-[4px] bg-warning px-1 text-[10.5px] font-semibold leading-none text-bg"
            >
              !
            </span>
          </Show>
          <Show when={unread() > 0}>
            <span data-testid="dock-tab-unread" class={DOCK_BADGE_CLASS}>
              {unread() > 99 ? "99+" : unread()}
            </span>
          </Show>
        </button>
        <button
          type="button"
          data-testid="dock-tab-close"
          aria-label={i18n.t("kernel.dock.closeNamed", { name: name() })}
          title={i18n.t("kernel.dock.close")}
          class={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[4px] text-text-tertiary outline-none transition-opacity hover:bg-surface-active hover:text-text focus-visible:opacity-100 ${
            active()
              ? "opacity-100"
              : "opacity-0 group-focus-within/item:opacity-100 group-hover/item:opacity-100"
          }`}
          onClick={() => close(props.tab.threadId)}
        >
          <X size={13} />
        </button>
        <Show when={active()}>
          <span
            data-testid="dock-tab-active-line"
            aria-hidden="true"
            class="pointer-events-none absolute right-2 bottom-0 left-2 h-0.5 rounded-full bg-accent"
          />
        </Show>
      </div>

      <Show when={props.tab.expanded}>
        <DockWindow data-testid="dock-window" kind={dmAgentId() ? "agent" : "person"}>
          <div
            data-testid="dock-window-header"
            class="flex shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-3 py-2"
          >
            <div class="flex min-w-0 items-center gap-2.5">
              <DockAvatar threadId={props.tab.threadId} size={34} />
              <div class="flex min-w-0 flex-col">
                {/* P4c-T39: in a DM with an agent the tab's name IS the agent,
                    so pressing it opens that agent's page, the same one the
                    sidebar row, the participant row and a mention chip open.
                    A tab that names people keeps a plain label: there is no
                    one page to go to. */}
                <Show
                  when={dmAgentId()}
                  fallback={
                    <span class="truncate text-[13.5px] font-semibold leading-tight text-text">
                      {name()}
                    </span>
                  }
                >
                  {(agentId) => (
                    <button
                      type="button"
                      data-testid="dock-tab-agent-name"
                      class="min-w-0 truncate rounded text-left text-[13.5px] font-semibold leading-tight text-text outline-none transition-colors hover:text-accent"
                      onClick={() => openAgentPage({ id: agentId(), name: name() })}
                    >
                      {name()}
                    </button>
                  )}
                </Show>
                {/* Collapses when there is nothing to say (an idle agent, a
                    person offline), so the name then centres on the avatar. */}
                <div
                  data-testid="dock-window-status"
                  class="hidden truncate text-[12px] leading-4 text-text-secondary has-[[data-status]]:block has-[[data-testid=agent-state]]:block"
                >
                  <Show
                    when={dmAgentId()}
                    fallback={
                      <Show when={statusText()}>{(text) => <span data-status>{text()}</span>}</Show>
                    }
                  >
                    {/* AgentStateLabel pads itself for the message stream; in
                        this one line it sits flush with the name above. */}
                    <span class="contents [&_[data-testid=agent-state]]:gap-1.5 [&_[data-testid=agent-state]]:p-0 [&_[data-testid=agent-state]]:text-text-secondary">
                      <AgentStateLabel threadId={props.tab.threadId} />
                    </span>
                  </Show>
                </div>
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-0.5">
              {/* The conversation read outside text: the globe alone, its label the hint. */}
              <OutsideTextMark
                threadId={props.tab.threadId}
                marked={thread()?.tainted === true}
                variant="icon"
              />
              {/*
                Where THIS tab's conversation runs (P4c-T19). A local session
                claims a (thread, agent) pair (A32), so the id it starts with is
                this tab's own thread id and not whatever Home has open behind
                the dock. Compact: 360px of header has no words to spare.
              */}
              <ThreadRuntimeSlot
                threadId={props.tab.threadId}
                title={thread()?.title ?? null}
                threadType={thread()?.type}
                currentUserId={currentUserId()}
                participants={thread()?.participants ?? []}
                compact
              />
              <Tooltip content={i18n.t("kernel.dock.collapse")}>
                <Button
                  variant="ghost"
                  size="sm"
                  class={ICON_BUTTON_CLASS}
                  aria-label={i18n.t("kernel.dock.collapse")}
                  onClick={() => collapse(props.tab.threadId)}
                >
                  <Minus size={15} />
                </Button>
              </Tooltip>
              <Tooltip content={i18n.t("kernel.dock.openInHome")}>
                <Button
                  variant="ghost"
                  size="sm"
                  class={ICON_BUTTON_CLASS}
                  aria-label={i18n.t("kernel.dock.openInHome")}
                  onClick={handleOpenInHome}
                >
                  <ExternalLink size={14} />
                </Button>
              </Tooltip>
            </div>
          </div>
          <div class="min-h-0 flex-1">
            {/* The dock is rendered by the Shell, outside MainPanel's per-tab
                boundaries: without this one a pending or failed read inside the
                thread body reaches App's fallback-less root <Suspense> and
                blanks the whole document. */}
            <DockSurfaceBoundary>
              <ThreadView
                entityId={props.tab.threadId}
                surface="dock"
                isActive={() => props.tab.expanded}
              />
            </DockSurfaceBoundary>
          </div>
        </DockWindow>
      </Show>
    </div>
  )
}

export default ConversationTab
