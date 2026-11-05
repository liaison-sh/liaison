// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Mounts the unlock surface over the mail view when anything asks for it: a
// locked message placeholder, a locked conversation, or the user choosing to
// unlock from the sidebar. It is a modal over the mail surface, not a route, so
// unlocking never loses the reader's place.
//
// "Not now" (and Escape) belong to the unlock screen only. Every other screen
// (setting a password, the passkey offer, the reset) has its own way out, and
// leaving one halfway through is what used to strand a user between a reset
// and a mailbox with nothing to unlock it.

import { type Component, createSignal, onCleanup, Show } from "solid-js"
import { hasScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { MailboxUnlock, type MailboxUnlockView } from "~/modules/mailbox/MailboxUnlock"
import { MAIL_READ_SCOPE } from "~/modules/mailbox/mailbox-store"
import {
  type MailboxUnlockRequest,
  onMailboxUnlockRequested,
} from "~/modules/mailbox/mailbox-unlock-bus"

export interface MailboxUnlockHostProps {
  userId: string | null
}

export const MailboxUnlockHost: Component<MailboxUnlockHostProps> = (props) => {
  const i18n = useI18n()
  const [request, setRequest] = createSignal<MailboxUnlockRequest | null>(null)
  const [view, setView] = createSignal<MailboxUnlockView>("unlock")
  onCleanup(
    onMailboxUnlockRequested((next) => {
      // A request while the modal is open keeps the screen the user is on.
      if (request()) return
      setView(next.view === "reset" ? "reset-confirm" : "unlock")
      setRequest(next)
    }),
  )
  const close = () => setRequest(null)
  const dismissible = () => view() === "unlock"

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && request() && dismissible()) {
      event.stopPropagation()
      close()
    }
  }
  // On the window, so Escape works wherever the focus is while the modal is up.
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  }

  return (
    // A user without mail access has no mailbox to unlock: the modal would
    // cover the whole app with an error they can do nothing about.
    <Show when={request() && hasScope(MAIL_READ_SCOPE) && props.userId}>
      {(userId) => (
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          data-testid="mailbox-unlock-host"
          data-view={view()}
          role="dialog"
          aria-modal="true"
        >
          <div class="w-full max-w-md rounded-lg border border-border bg-surface p-5">
            <MailboxUnlock
              userId={userId()}
              initialView={request()?.view}
              onViewChange={setView}
              onUnlocked={close}
            />
            <Show when={dismissible()}>
              <button
                type="button"
                class="mt-4 text-xs text-text-tertiary hover:underline"
                data-testid="mailbox-unlock-host.dismiss"
                onClick={close}
              >
                {i18n.t("kernel.mailboxEncryption.unlock.notNow")}
              </button>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
