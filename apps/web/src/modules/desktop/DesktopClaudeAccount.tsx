// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE CLAUDE ACCOUNT LOCAL SESSIONS RUN ON, in Settings > Profile beside the
// servers group, on every desktop OS.
//
// No OS has a native Account menu, so this is where the account is read and
// signed out of. Signing out signs the whole
// computer out of Claude, so the button only ASKS: the shell shows its own
// native question, which a page script cannot answer, and signs out on a yes.
//
// A browser and the phone render nothing.

import { type Component, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import {
  canSignInToClaude,
  canSignOutOfClaude,
  checkClaudeAccount,
  claudeAccount,
  isDesktop,
  signOutOfClaude,
  startClaudeSignIn,
} from "./desktop-store"

const DesktopClaudeAccount: Component = () => {
  const i18n = useI18n()
  onMount(() => {
    if (isDesktop() && !claudeAccount()) void checkClaudeAccount()
  })
  const line = () => {
    const account = claudeAccount()
    if (!account?.loggedIn) return i18n.t("kernel.servers.claudeNotSignedIn")
    return account.email
      ? i18n.t("kernel.servers.claudeAccount", { email: account.email })
      : i18n.t("kernel.servers.claudeSignedIn")
  }

  return (
    <Show when={isDesktop()}>
      <div data-testid="desktop-claude-account" class="flex flex-col">
        <h2 class="px-4 pb-1 pt-4 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
          {i18n.t("kernel.servers.claudeHeading")}
        </h2>
        <div class="flex min-h-11 items-center gap-3 px-4 pb-2">
          <span class="min-w-0 flex-1 truncate text-[14px] text-text">{line()}</span>
          <Show
            when={claudeAccount()?.loggedIn}
            fallback={
              <Show when={canSignInToClaude()}>
                <Button
                  variant="outline"
                  data-testid="desktop-claude-sign-in"
                  onClick={() => void startClaudeSignIn()}
                >
                  {i18n.t("kernel.servers.claudeSignInEllipsis")}
                </Button>
              </Show>
            }
          >
            <Show when={canSignOutOfClaude()}>
              <Button
                variant="outline"
                data-testid="desktop-claude-sign-out"
                onClick={() => void signOutOfClaude()}
              >
                {i18n.t("kernel.servers.claudeSignOut")}
              </Button>
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  )
}

export default DesktopClaudeAccount
