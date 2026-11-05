// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A REFUSED START IS SAID WHERE THE PERSON IS TYPING (2026-09-23).
//
// The desktop app was quit and relaunched; the first message in a "This
// machine" conversation was refused by the server (409, the conversation still
// held by the previous instance) and the window showed nothing a person could
// act on: two toasts that dismiss themselves, the runtime chips gone (they are
// drawn only while a session is live, and none was), and the draft back in an
// otherwise unchanged composer. A second press produced the same nothing.
//
// So the refusal stays on the conversation, above the composer, until the
// person acts or the next start answers it: which computer holds the
// conversation (theirs or a named colleague's), a Take over when the server
// says it would accept one, and the way out, letting Liaison answer it. Every
// other refusal gets its sentence here too, because a toast is not where a
// person looks for why their message came back.

import { X } from "lucide-solid"
import { type Component, createEffect, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { claimedCopyFor, startRefusalCopyFor } from "./desktop-notices"
import {
  desktopState,
  isDesktop,
  lastStartRequest,
  setRuntimeLocation,
  startLocalSession,
} from "./desktop-store"

interface LocalStartRefusalProps {
  /** The conversation this composer writes into. */
  threadId?: string
}

const LocalStartRefusal: Component<LocalStartRefusalProps> = (props) => {
  const i18n = useI18n()
  /** The person closed it: it stays closed until the next start refuses. */
  const [dismissed, setDismissed] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  createEffect(() => {
    const state = desktopState()
    if (state.sessionStatus === "starting" || !state.startError) setDismissed(false)
  })

  /** The refusal, when the last start asked for was THIS conversation's. */
  const refusal = () => {
    if (!isDesktop() || !props.threadId) return null
    const state = desktopState()
    const reason = state.startError ?? null
    if (!reason || state.sessionStatus === "starting") return null
    // Said by the Claude sign-in notice, which carries the sign-in itself.
    if (reason === "ClaudeSignInRequired") return null
    const request = lastStartRequest()
    if (!request || request.threadId !== props.threadId) return null
    if (dismissed()) return null
    return { state, reason, agentId: request.agentId }
  }

  const sentence = () => {
    const current = refusal()
    if (!current) return ""
    if (current.reason !== "ConversationClaimed") {
      return startRefusalCopyFor(current.reason, current.state.startErrorDetail ?? null)
    }
    // Read here so the sentence follows the page's language as it changes.
    void i18n.locale()
    return claimedCopyFor(current.state.startClaimHolder)
  }

  const claimed = () => refusal()?.reason === "ConversationClaimed"
  /** An older shell names no holder; the server accepts a takeover from any
   *  member who may claim, so the button is offered unless it said no. */
  const canTakeOver = () => claimed() && refusal()?.state.startClaimHolder?.canTakeOver !== false

  async function takeOver() {
    const current = refusal()
    if (!current || !props.threadId || busy()) return
    setBusy(true)
    try {
      await startLocalSession(props.threadId, current.agentId, undefined, { takeOver: true })
    } finally {
      setBusy(false)
    }
  }

  function useLiaison() {
    setRuntimeLocation("liaison")
    setDismissed(true)
  }

  return (
    <Show when={refusal()}>
      <div
        role="alert"
        data-testid="local-start-refusal"
        class="mb-2 flex flex-wrap items-start gap-2 rounded-md border border-warning/40 bg-warning-glow px-3 py-2 text-[12.5px] text-text"
      >
        <span class="min-w-0 flex-1">{sentence()}</span>
        <div class="flex shrink-0 items-center gap-1">
          <Show when={canTakeOver()}>
            <button
              type="button"
              data-testid="local-start-take-over"
              disabled={busy()}
              onClick={() => void takeOver()}
              class="rounded-md bg-accent px-2 py-0.5 font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
            >
              {i18n.t("kernel.desktopUi.localStart.takeOver")}
            </button>
          </Show>
          <button
            type="button"
            data-testid="local-start-use-liaison"
            onClick={useLiaison}
            class="rounded-md px-2 py-0.5 font-medium text-text-secondary hover:bg-surface-hover hover:text-text"
          >
            {i18n.t("kernel.desktopUi.localStart.useLiaison")}
          </button>
          <button
            type="button"
            aria-label={i18n.t("kernel.desktopUi.localStart.dismiss")}
            onClick={() => setDismissed(true)}
            class="flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text"
          >
            <X size={12} />
          </button>
        </div>
      </div>
    </Show>
  )
}

export default LocalStartRefusal
