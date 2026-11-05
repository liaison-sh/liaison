// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CLAUDE ON THIS COMPUTER IS NOT SIGNED IN, SAID WHERE THE PERSON IS TYPING
// (2026-09-24).
//
// A local turn runs on the Claude Code login of the computer it runs on. A
// person who only ever used the Claude desktop app has none: the first turn
// failed with "Failed to authenticate" and the only way out was a terminal.
// The shell now names that failure (`claudeSignInNeeded`, raised by a turn
// that could not authenticate or by a start that found no sign-in), and this
// notice, over the composer, carries the one thing to do about it: sign in.
// The failed turn keeps its own Retry on the conversation; a refused start
// sends again from the composer, where the draft came back.

import { X } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  canSignInToClaude,
  claudeSignInNeededFor,
  desktopState,
  dismissClaudeSignInNeeded,
  isDesktop,
  startClaudeSignIn,
} from "./desktop-store"

/** NORMATIVE. No dash punctuation. */
export const CLAUDE_SIGN_IN_NEEDED_TURN = "kernel.desktopUi.claudeSignIn.neededTurn"
export const CLAUDE_SIGN_IN_NEEDED_START = "kernel.desktopUi.claudeSignIn.neededStart"
export const CLAUDE_SIGN_IN_ACTION = "kernel.desktopUi.claudeSignIn.action"

interface ClaudeSignInNoticeProps {
  /** The conversation this composer writes into. */
  threadId?: string
}

const ClaudeSignInNotice: Component<ClaudeSignInNoticeProps> = (props) => {
  const i18n = useI18n()
  const needed = () =>
    isDesktop() && canSignInToClaude() ? claudeSignInNeededFor(props.threadId) : null
  /** The dialog is open: the notice's button would only open it again. */
  const signingIn = () => !!desktopState().claudeSignIn

  return (
    <Show when={needed()}>
      {(current) => (
        <div
          role="alert"
          data-testid="claude-sign-in-notice"
          class="mb-2 flex flex-wrap items-start gap-2 rounded-md border border-warning/40 bg-warning-glow px-3 py-2 text-[12.5px] text-text"
        >
          <span class="min-w-0 flex-1">
            {i18n.t(current().messageId ? CLAUDE_SIGN_IN_NEEDED_TURN : CLAUDE_SIGN_IN_NEEDED_START)}
          </span>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              data-testid="claude-sign-in-start"
              disabled={signingIn()}
              onClick={() => void startClaudeSignIn()}
              class="rounded-md bg-accent px-2 py-0.5 font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
            >
              {i18n.t(CLAUDE_SIGN_IN_ACTION)}
            </button>
            <button
              type="button"
              aria-label={i18n.t("kernel.desktopUi.claudeSignIn.dismiss")}
              onClick={() => dismissClaudeSignInNeeded()}
              class="flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}
    </Show>
  )
}

export default ClaudeSignInNotice
