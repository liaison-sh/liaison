// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one way to clear the downgrade alarm: its owner, on this computer, after
// reading exactly what is cleared and what clearing means, proves the mailbox
// secret again. See `alarm-clear.ts` for the order of proof, record and forget,
// and why the server can take no part in the step that removes anything.
//
// The proof is the mailbox password whenever the keyring has one. A keyring
// with no mailbox password is confirmed with this computer's passkey instead,
// through the same unlock path. Either way the step doubles as an unlock, so a
// locked mailbox needs no separate unlock first.

import {
  type Component,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  Show,
  Suspense,
} from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type AlarmClearOutcome, clearDowngradeAlarmWithProof } from "~/modules/mailbox/alarm-clear"
import { devicePasskeyWrapId, rememberDevicePasskey } from "~/modules/mailbox/device-state"
import type { DowngradeFinding } from "~/modules/mailbox/downgrade-detector"
import { fetchKeyring, type WrapMetadataView } from "~/modules/mailbox/mailbox-api"
import { prfSecretForWrapBlob } from "~/modules/mailbox/passkey-ceremony"
import type { IndexBlobStore } from "~/modules/mailbox/search-index/index-blob-store"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"

export interface MailboxAlarmClearDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: string
  findings: () => DowngradeFinding[]
  label: (finding: DowngradeFinding) => string
  store: () => IndexBlobStore
}

type ClearError = Exclude<AlarmClearOutcome, "cleared"> | "unexpected"

const ERROR_KEY: Record<ClearError, string> = {
  refused: "kernel.mailboxAlarmClear.err.refused",
  "not-recorded": "kernel.mailboxAlarmClear.err.notRecorded",
  "worker-missing": "kernel.mailboxAlarmClear.err.workerMissing",
  unexpected: "kernel.mailboxAlarmClear.err.unexpected",
}

/** Newest use first, then newest created: the passkey most likely to be this one. */
function byRecency(a: WrapMetadataView, b: WrapMetadataView): number {
  return Date.parse(b.lastUsedAt ?? b.createdAt) - Date.parse(a.lastUsedAt ?? a.createdAt)
}

const ClearForm: Component<MailboxAlarmClearDialogProps> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [password, setPassword] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ClearError | null>(null)
  const [keyring] = createResource(() => fetchKeyring(api))

  const wraps = () => keyring()?.wraps ?? []
  // Newest first, as in MailboxUnlock: a legacy row whose delete failed after
  // the silent re-wrap can linger beside its replacement.
  const passwordWrap = () =>
    wraps()
      .filter((wrap) => wrap.type === "passphrase")
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
  const passkeyWrap = () => {
    const passkeys = wraps()
      .filter((wrap) => wrap.type === "passkey_prf")
      .sort(byRecency)
    const deviceId = devicePasskeyWrapId(props.userId)
    return passkeys.find((wrap) => wrap.id === deviceId) ?? passkeys[0]
  }
  /** The password when there is one; a passkey only for a keyring without it. */
  const proofWrap = () => passwordWrap() ?? passkeyWrap()

  async function confirm(): Promise<void> {
    const wrap = proofWrap()
    if (!wrap || busy()) return
    setBusy(true)
    setError(null)
    try {
      const outcome = await clearDowngradeAlarmWithProof({
        api,
        userId: props.userId,
        wrap,
        secret: wrap.type === "passphrase" ? password() : undefined,
        resolveSecret: wrap.type === "passkey_prf" ? prfSecretForWrapBlob : undefined,
        findings: props.findings(),
        store: props.store(),
      })
      setPassword("")
      if (outcome === "cleared") {
        if (wrap.type === "passkey_prf") rememberDevicePasskey(props.userId, wrap.id)
        props.onOpenChange(false)
        return
      }
      setError(outcome)
    } catch {
      setError("unexpected")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      class="mt-3 space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void confirm()
      }}
    >
      <Show
        when={proofWrap()}
        fallback={
          <p class="text-text-secondary" data-testid="mailbox-alarm-clear.no-method">
            {i18n.t("kernel.mailboxAlarmClear.noMethod")}
          </p>
        }
      >
        {(wrap) => (
          <>
            <Show
              when={wrap().type === "passphrase"}
              fallback={
                <p class="text-text-secondary" data-testid="mailbox-alarm-clear.passkey-hint">
                  {i18n.t("kernel.mailboxAlarmClear.passkeyHint")}
                </p>
              }
            >
              <Input
                type="password"
                autocomplete="current-password"
                label={i18n.t("kernel.mailboxAlarmClear.passwordLabel")}
                value={password()}
                onInput={(event) => setPassword(event.currentTarget.value)}
                disabled={busy()}
                data-testid="mailbox-alarm-clear.password"
              />
              <p class="text-xs text-text-tertiary">
                {i18n.t("kernel.mailboxAlarmClear.passwordHint")}
              </p>
            </Show>
            <Show when={error()}>
              {(code) => (
                <p class="text-danger" role="alert" data-testid="mailbox-alarm-clear.error">
                  {i18n.t(ERROR_KEY[code()])}
                </p>
              )}
            </Show>
            <div class="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => props.onOpenChange(false)}
                data-testid="mailbox-alarm-clear.cancel"
              >
                {i18n.t("kernel.mailboxAlarmClear.cancel")}
              </Button>
              <Button
                type="submit"
                variant="danger"
                size="sm"
                disabled={busy() || (wrap().type === "passphrase" && password().length === 0)}
                data-testid="mailbox-alarm-clear.confirm"
              >
                {busy()
                  ? i18n.t("kernel.mailboxAlarmClear.busy")
                  : wrap().type === "passphrase"
                    ? i18n.t("kernel.mailboxAlarmClear.confirmPassword")
                    : i18n.t("kernel.mailboxAlarmClear.confirmPasskey")}
              </Button>
            </div>
          </>
        )}
      </Show>
    </form>
  )
}

export const MailboxAlarmClearDialog: Component<MailboxAlarmClearDialogProps> = (props) => {
  const i18n = useI18n()
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content class="w-full max-w-lg text-[13px]">
        <div data-testid="mailbox-alarm-clear">
          <Dialog.Title>{i18n.t("kernel.mailboxAlarmClear.title")}</Dialog.Title>
          <p class="mt-2 text-text-secondary">{i18n.t("kernel.mailboxAlarmClear.willClear")}</p>
          <ul class="mt-1 list-disc space-y-1 pl-5" data-testid="mailbox-alarm-clear.list">
            <For each={props.findings()}>
              {(finding) => (
                <li data-testid={`mailbox-alarm-clear.item.${finding.kind}`}>
                  {props.label(finding)}
                </li>
              )}
            </For>
          </ul>
          <p class="mt-2" data-testid="mailbox-alarm-clear.meaning">
            {i18n.t("kernel.mailboxAlarmClear.meaning")}
          </p>
          <p class="mt-1 text-text-secondary">{i18n.t("kernel.mailboxAlarmClear.recheck")}</p>
          <p class="mt-1 text-text-secondary">{i18n.t("kernel.mailboxAlarmClear.audit")}</p>
          <ErrorBoundary
            fallback={
              <p class="mt-3 text-danger" role="alert" data-testid="mailbox-alarm-clear.error">
                {i18n.t("kernel.mailboxAlarmClear.err.unexpected")}
              </p>
            }
          >
            <Suspense>
              <ClearForm {...props} />
            </Suspense>
          </ErrorBoundary>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
