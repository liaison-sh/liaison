// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SIGNING IN TO CLAUDE FROM THE APP (2026-09-24).
//
// The shell starts the Claude Code CLI's own login and opens claude.com in the
// browser (apps/desktop `claude_auth.rs`). What the person does there ends one
// of two ways: the page finishes on its own, or it shows a code to paste back.
// This dialog is the paste, the way out, and the way back to the page; it
// closes by itself when the shell reports the account signed in.
//
// It draws only from `claudeSignIn` on the shell's state. The sign-in URL and
// the code never come back across the bridge: the page opens nothing itself
// and remembers nothing it was given.

import { type Component, createEffect, createSignal, Match, Show, Switch } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"
import {
  cancelClaudeSignIn,
  desktopState,
  isDesktop,
  reopenClaudeSignIn,
  startClaudeSignIn,
  submitClaudeSignInCode,
} from "./desktop-store"

/** NORMATIVE. No dash punctuation. */
export const CLAUDE_SIGN_IN_TITLE = "kernel.desktopUi.claudeSignIn.dialogTitle"
export const CLAUDE_SIGN_IN_WAITING = "kernel.desktopUi.claudeSignIn.waiting"

const ClaudeSignInDialog: Component = () => {
  const i18n = useI18n()
  const [code, setCode] = createSignal("")
  const signIn = () => (isDesktop() ? (desktopState().claudeSignIn ?? null) : null)
  const phase = () => signIn()?.phase ?? null
  const askingForCode = () =>
    phase() === "waiting" || phase() === "checking" || phase() === "codeRejected"

  // A new sign-in starts with an empty field.
  createEffect(() => {
    if (phase() === "starting" || phase() === null) setCode("")
  })

  const failure = () => {
    const current = signIn()
    if (current?.phase !== "failed") return ""
    if (current.reason === "timeout") return i18n.t("kernel.desktopUi.claudeSignIn.timedOut")
    if (current.reason === "cli_missing") return i18n.t("kernel.desktopUi.claudeSignIn.unavailable")
    if (current.detail) {
      return i18n.t("kernel.desktopUi.claudeSignIn.failedDetail", { detail: current.detail })
    }
    return i18n.t("kernel.desktopUi.claudeSignIn.failed")
  }

  async function submit(event?: Event) {
    event?.preventDefault()
    const value = code().trim()
    if (!value || phase() === "checking") return
    await submitClaudeSignInCode(value)
  }

  return (
    <Show when={signIn()}>
      <Dialog
        open={true}
        onOpenChange={(next) => {
          if (!next) void cancelClaudeSignIn()
        }}
      >
        <Dialog.Content class="max-w-sm">
          <Dialog.Title class="text-center">{i18n.t(CLAUDE_SIGN_IN_TITLE)}</Dialog.Title>
          <div class="mt-5 flex flex-col gap-4">
            <Switch>
              <Match when={phase() === "starting"}>
                <p class="text-[13px] text-text-secondary">
                  {i18n.t("kernel.desktopUi.claudeSignIn.starting")}
                </p>
              </Match>
              <Match when={askingForCode()}>
                <p class="text-[13px] text-text-secondary">{i18n.t(CLAUDE_SIGN_IN_WAITING)}</p>
                <form class="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
                  <Input
                    label={i18n.t("kernel.desktopUi.claudeSignIn.codeLabel")}
                    placeholder={i18n.t("kernel.desktopUi.claudeSignIn.codePlaceholder")}
                    value={code()}
                    autocomplete="off"
                    data-testid="claude-sign-in-code"
                    error={
                      phase() === "codeRejected"
                        ? i18n.t("kernel.desktopUi.claudeSignIn.codeRejected")
                        : undefined
                    }
                    onInput={(event) => setCode(event.currentTarget.value)}
                  />
                  <Show when={phase() === "checking"}>
                    <p class="text-[12.5px] text-text-tertiary" role="status">
                      {i18n.t("kernel.desktopUi.claudeSignIn.checking")}
                    </p>
                  </Show>
                  <Button
                    fullWidth
                    type="submit"
                    disabled={!code().trim() || phase() === "checking"}
                  >
                    {i18n.t("kernel.desktopUi.claudeSignIn.submit")}
                  </Button>
                </form>
                <button
                  type="button"
                  data-testid="claude-sign-in-reopen"
                  onClick={() => void reopenClaudeSignIn()}
                  class="self-center text-[12.5px] font-medium text-accent hover:underline"
                >
                  {i18n.t("kernel.desktopUi.claudeSignIn.reopen")}
                </button>
              </Match>
              <Match when={phase() === "failed"}>
                <p role="alert" class="text-[13px] text-text">
                  {failure()}
                </p>
                <Show when={signIn()?.reason !== "cli_missing"}>
                  <Button fullWidth onClick={() => void startClaudeSignIn()}>
                    {i18n.t("kernel.desktopUi.claudeSignIn.tryAgain")}
                  </Button>
                </Show>
              </Match>
            </Switch>
            <Button fullWidth variant="outline" onClick={() => void cancelClaudeSignIn()}>
              {i18n.t("kernel.desktopUi.claudeSignIn.cancel")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </Show>
  )
}

export default ClaudeSignInDialog
