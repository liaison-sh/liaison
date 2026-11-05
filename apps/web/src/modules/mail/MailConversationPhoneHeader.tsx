// SPDX-License-Identifier: FSL-1.1-ALv2
//
// K4. The mail conversation's phone-tier nav bar: back to the list, the
// subject, and the trigger for the "⋯" actions sheet. It used to be rendered
// INSIDE MailConversation's own body while MainPanel's phone top bar ALSO
// rendered its generic bar above it — a manifest tab type (mail is one) has
// no way to declare a `phoneHeader` on its own registration, so nothing
// stopped the plain bar from showing too. Registered at runtime instead
// (`registerAppPhoneHeader`, called from `registerAppHooks()` in exports.ts),
// so MainPanel renders THIS in place of its generic bar and MailConversation
// renders no bar of its own.
//
// The sheet's CONTENTS stay in MailConversation (archive, convert to ticket,
// discuss all need data and mutations already loaded there); this component
// only flips the shared open flag in `mail-conversation-phone-header-store`.
import { ChevronLeft, MoreHorizontal, PanelRightOpen } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { openMailConversationMoreSheet } from "~/modules/mail/mail-conversation-phone-header-store"
import { conversationStore } from "~/modules/mail/mail-conversation-store"
import { deriveSubject, openedSubjectOf } from "~/modules/mail/mail-conversation-subject"
import { getMessages } from "~/modules/mail/mail-message-store"
import { openTab } from "~/modules/shell/tab-store"
import { openThreadMap, threadMapAvailable } from "~/ui/thread-map-store"

interface MailConversationPhoneHeaderProps {
  entityId: string
}

const MailConversationPhoneHeader: Component<MailConversationPhoneHeaderProps> = (props) => {
  const i18n = useI18n()
  const conversation = () => conversationStore.byId[props.entityId]
  // True while at least one row of this conversation is sealed and unopened,
  // same check MailConversation makes for its own subject line.
  const anyMessageLocked = () =>
    getMessages(props.entityId).some((m) => (m as { encState?: string }).encState === "locked")

  function backToList(): void {
    openTab({ type: "mail:inbox", entityId: "inbox", label: i18n.t("kernel.mailBackToList") })
  }

  return (
    <div
      class="flex min-w-0 flex-1 items-center gap-1"
      data-testid="mail-conversation-phone-header"
    >
      <button
        type="button"
        data-testid="mail-phone-back"
        aria-label={i18n.t("kernel.back")}
        class="flex min-h-11 shrink-0 items-center gap-0.5 rounded-md pl-1 pr-2 text-[15px] text-text-secondary hover:bg-surface-hover"
        onClick={() => backToList()}
      >
        <ChevronLeft size={20} />
        {i18n.t("kernel.mailBackToList")}
      </button>
      <span
        class="min-w-0 flex-1 truncate text-center text-[14px] font-semibold text-text"
        data-testid="mail-phone-subject"
      >
        {deriveSubject(
          conversation(),
          anyMessageLocked(),
          i18n.t,
          openedSubjectOf(getMessages(props.entityId)),
        )}
      </span>
      {/* The thread drawer (ThreadMapDrawer, rendered by MailConversation),
          offered once the thread has enough messages to need a map. */}
      <Show when={threadMapAvailable(`mail:${props.entityId}`)}>
        <button
          type="button"
          data-testid="mail-phone-thread-map"
          aria-label={i18n.t("kernel.threadMap.open")}
          class="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover"
          onClick={() => openThreadMap(`mail:${props.entityId}`)}
        >
          <PanelRightOpen size={18} />
        </button>
      </Show>
      <button
        type="button"
        data-testid="mail-phone-more"
        aria-label={i18n.t("kernel.mailConversationActions")}
        class="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover"
        onClick={() => openMailConversationMoreSheet(props.entityId)}
      >
        <MoreHorizontal size={18} />
      </button>
    </div>
  )
}

export default MailConversationPhoneHeader
