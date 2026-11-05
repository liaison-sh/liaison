// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a locked mailbox shows in place of the mail it cannot open: one lock,
// one sentence and one large Unlock button. A sealed row or body is never
// rendered blank while the mailbox is locked; this panel stands in for it.
//
// Wording rules that are load bearing, not decoration: a locked mailbox is a
// state, so this never says error, failed, corrupt or lost, and it reads like
// any app asking the user to confirm who they are. A device whose passkey
// cannot reproduce its PRF output gets its own sentence, because that is a
// device condition and not damaged mail.
//
// The legacy `mailbox-locked-notice` test ids are kept so the browser
// scenarios that drive the unlock keep finding it.

import { Lock } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { requestMailboxUnlock } from "~/modules/mailbox/mailbox-unlock-bus"
import { Button } from "~/ui/Button"

export interface MailboxLockedPanelProps {
  /** "page" fills a list or reader area; "card" sits inline in a card. */
  variant: "page" | "card"
  /** True when this device's passkey cannot reproduce the wrap's PRF output. */
  devicePrfMismatch?: boolean
  /** Replaces the default sentence (a surface with its own context to say). */
  body?: string
  /** Test id of the unlock button; defaults to the mail surface's. */
  unlockTestId?: string
  class?: string
}

export const MailboxLockedPanel: Component<MailboxLockedPanelProps> = (props) => {
  const i18n = useI18n()
  const page = () => props.variant === "page"
  return (
    <div
      data-testid="mailbox-locked-notice"
      data-variant={props.variant}
      class={cn(
        "flex flex-col items-center text-center",
        page()
          ? "flex-1 justify-center gap-4 px-6 py-12"
          : "gap-3 rounded-lg bg-surface-sunken px-4 py-5 ring-1 ring-border",
        props.class,
      )}
    >
      <span
        aria-hidden="true"
        class={cn(
          "flex items-center justify-center rounded-full bg-accent-glow text-accent",
          page() ? "h-14 w-14" : "h-10 w-10",
        )}
      >
        <Lock size={page() ? 26 : 20} />
      </span>
      <h2
        data-testid="mailbox-locked-panel.title"
        class={cn("font-semibold text-text", page() ? "text-[19px]" : "text-[15px]")}
      >
        {i18n.t("kernel.mailboxEncryption.locked.panelTitle")}
      </h2>
      <p
        data-testid="mailbox-locked-panel.body"
        class={cn("max-w-sm text-text-secondary", page() ? "text-[14px]" : "text-[13px]")}
      >
        <Show
          when={props.devicePrfMismatch}
          fallback={props.body ?? i18n.t("kernel.mailboxEncryption.locked.panelBody")}
        >
          {i18n.t("kernel.mailboxEncryption.locked.prfMismatch")}
        </Show>
      </p>
      <Button
        type="button"
        size="lg"
        data-testid={props.unlockTestId ?? "mailbox-locked-notice.unlock"}
        class="min-w-[200px]"
        onClick={() => requestMailboxUnlock()}
      >
        {i18n.t("kernel.mailboxEncryption.locked.panelButton")}
      </Button>
    </div>
  )
}
