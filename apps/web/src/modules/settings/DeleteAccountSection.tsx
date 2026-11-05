// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Delete my account" (spec S19), on the Security screen next to the password
// and two-factor settings, so web, desktop and the phone's You screen all reach
// it. The dialog says what is deleted and what stays, then the emailed code is
// the only confirmation (a password does not satisfy it). On a demo box the
// reserved App Review org gets the code back in the response, and the dialog
// shows it: the reviewer cannot read that mailbox. On success the app signs
// out; in the mobile shell through the shell, so it forgets the stored server
// session too.

import { type Component, createSignal, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { authApiPath } from "~/lib/env"
import { nativeServers } from "~/lib/native-bridge"
import { markAccountDeleted } from "~/modules/auth/account-deleted-notice"
import { authManager } from "~/modules/auth/createAuthManager"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"

/** Which sentence explains a refusal. The server's own words stay English. */
function refusalKey(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return "kernel.deleteAccount.lastAdmin"
    // The code is checked by its own words too: the refusal is about the code
    // whichever status carried it (assertStepUp answers 422).
    if (err.status === 422 || err.status === 400 || /step-up code|wrong codes/i.test(err.message)) {
      return /too many wrong codes/i.test(err.message)
        ? "kernel.deleteAccount.tooManyWrong"
        : "kernel.deleteAccount.wrongCode"
    }
    // Ten deletion attempts an hour: a wait, not a failure.
    if (err.status === 429) return "kernel.deleteAccount.tooManyAttempts"
  }
  return "kernel.deleteAccount.failed"
}

const DeleteAccountSection: Component = () => {
  const i18n = useI18n()
  const api = useApi()

  const [open, setOpen] = createSignal(false)
  const [codeSent, setCodeSent] = createSignal(false)
  const [demoCode, setDemoCode] = createSignal<string | null>(null)
  const [code, setCode] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [refusal, setRefusal] = createSignal<string | null>(null)

  function openDialog() {
    setCodeSent(false)
    setDemoCode(null)
    setCode("")
    setRefusal(null)
    setOpen(true)
  }

  async function sendCode() {
    setRefusal(null)
    setBusy(true)
    try {
      const res = await api.post<{ sent: boolean; demoCode?: string }>(
        authApiPath("/totp/step-up"),
        { purpose: "account_delete" },
        { suppressGlobalError: true },
      )
      setDemoCode(typeof res?.demoCode === "string" ? res.demoCode : null)
      setCodeSent(true)
    } catch {
      setRefusal("kernel.deleteAccount.sendFailed")
    } finally {
      setBusy(false)
    }
  }

  async function confirm(e: Event) {
    e.preventDefault()
    setRefusal(null)
    setBusy(true)
    try {
      await api.post(
        authApiPath("/account/delete"),
        { stepUpCode: code().trim() },
        { suppressGlobalError: true },
      )
    } catch (err) {
      setRefusal(refusalKey(err))
      setBusy(false)
      return
    }
    // The account is gone and its sessions with it: sign out. The mobile shell
    // signs out through itself, so it also forgets its stored server session.
    // The sign-in screen this lands on says why (account-deleted-notice.ts).
    markAccountDeleted()
    const servers = nativeServers()
    if (servers) await servers.signOut().catch(() => undefined)
    else await authManager.logout()
  }

  return (
    <div class="mt-6 rounded-lg border border-border p-4" data-testid="delete-account-section">
      <h2 class="text-sm font-medium text-text">{i18n.t("kernel.deleteAccount.heading")}</h2>
      <p class="mt-1 text-xs text-text-secondary">{i18n.t("kernel.deleteAccount.intro")}</p>
      <div class="mt-3">
        <Button variant="outline" size="sm" class="text-error" onClick={openDialog}>
          {i18n.t("kernel.deleteAccount.open")}
        </Button>
      </div>

      <Dialog open={open()} onOpenChange={setOpen}>
        <Dialog.Content class="max-w-md">
          <Dialog.Title>{i18n.t("kernel.deleteAccount.title")}</Dialog.Title>
          <div class="mt-3 flex flex-col gap-3 text-xs text-text-secondary">
            <div>
              <h3 class="font-medium text-text">{i18n.t("kernel.deleteAccount.deletedHeading")}</h3>
              <p class="mt-1">{i18n.t("kernel.deleteAccount.deleted")}</p>
            </div>
            <div>
              <h3 class="font-medium text-text">{i18n.t("kernel.deleteAccount.staysHeading")}</h3>
              <p class="mt-1">{i18n.t("kernel.deleteAccount.stays")}</p>
              <p class="mt-1">{i18n.t("kernel.deleteAccount.otherOrgs")}</p>
            </div>
            <p>{i18n.t("kernel.deleteAccount.codeStep")}</p>
          </div>

          <Show
            when={codeSent()}
            fallback={
              <div class="mt-4 flex flex-col gap-3">
                <Show when={refusal()}>
                  {(key) => (
                    <p role="alert" class="text-xs text-error">
                      {i18n.t(key())}
                    </p>
                  )}
                </Show>
                <div class="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                    {i18n.t("kernel.deleteAccount.cancel")}
                  </Button>
                  <Button size="sm" onClick={sendCode} loading={busy()}>
                    {i18n.t("kernel.deleteAccount.sendCode")}
                  </Button>
                </div>
              </div>
            }
          >
            <form onSubmit={confirm} class="mt-4 flex flex-col gap-3">
              <p class="text-xs text-text-secondary">{i18n.t("kernel.deleteAccount.codeSent")}</p>
              <Show when={demoCode()}>
                {(demo) => (
                  <p class="text-xs font-medium text-text" data-testid="delete-account-demo-code">
                    {i18n.t("kernel.deleteAccount.demoCode", { code: demo() })}
                  </p>
                )}
              </Show>
              <Input
                label={i18n.t("kernel.deleteAccount.codeLabel")}
                placeholder="000000"
                maxLength={6}
                value={code()}
                onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)}
                autocomplete="one-time-code"
              />
              <Show when={refusal()}>
                {(key) => (
                  <p role="alert" class="text-xs text-error">
                    {i18n.t(key())}
                  </p>
                )}
              </Show>
              <div class="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={sendCode}>
                  {i18n.t("kernel.deleteAccount.resend")}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
                  {i18n.t("kernel.deleteAccount.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="danger"
                  size="sm"
                  loading={busy()}
                  disabled={code().trim().length !== 6}
                >
                  {i18n.t("kernel.deleteAccount.confirm")}
                </Button>
              </div>
            </form>
          </Show>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}

export default DeleteAccountSection
