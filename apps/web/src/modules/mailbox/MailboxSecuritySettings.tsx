// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mailbox security page. Its job is to say, in plain words, exactly what
// this design protects and exactly what it does not, including the parts that
// are uncomfortable: the metadata that stays visible, the passphrase that is
// the weakest link, the backups that still hold plaintext until a stated date,
// the assistant's answers that stay in a chat history, and the fact that the
// operator serves the JavaScript. The fine print sits behind "Learn more", so
// the page reads as settings first.
//
// It is also where the owner manages the mailbox while it is open: change the
// mailbox password, remove a passkey, or reset the mailbox. Each of those works
// from here; none sends the user to a screen they cannot reach while unlocked.
//
// The wording lives in `mailbox-copy.ts` and is asserted by tests. Do not
// paraphrase it here.

import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  agentMailAccessState,
  publishAgentMailAccess,
  setAgentMailAccessEnabled,
} from "~/modules/mailbox/agent-mail-access"
import { devicePasskeyWrapId, forgetDevicePasskey } from "~/modules/mailbox/device-state"
import { MailboxVerificationPanel } from "~/modules/mailbox/MailboxVerificationPanel"
import {
  addWrap,
  deleteWrap,
  fetchKeyring,
  fetchMigrationState,
  type WrapMetadataView,
} from "~/modules/mailbox/mailbox-api"
import {
  agentResidualCopy,
  approvedZeroAccessClaim,
  mailboxPasswordExplainer,
  metadataStillVisible,
  operatorJavascriptLimitation,
  passphraseCaveat,
  pendingSetupClaim,
  rotationNote,
  wrapLabel,
} from "~/modules/mailbox/mailbox-copy"
import {
  agentMailAccessSyncDeps,
  loadMailboxKeyring,
  mailboxCryptoClient,
  unlockMailbox,
} from "~/modules/mailbox/mailbox-store"
import { requestMailboxReset } from "~/modules/mailbox/mailbox-unlock-bus"
import { checkPassphrase } from "~/modules/mailbox/passphrase-strength"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

export interface MailboxSecuritySettingsProps {
  userId: string
  emailAddress: string
  /** Personal mailboxes are encrypted; shared org mailboxes are not. The
   * asymmetry is deliberate and has to be visible. */
  mode: "personal" | "shared"
  /**
   * The mail account this page is about. It is what the migration
   * acknowledgement names, so the full-mailbox check is offered only when the
   * caller can say which mailbox it is checking.
   */
  accountId?: string
  /** The mailbox has no keys yet (awaiting its password): nothing is stored
   *  encrypted, so the page says what will be, not what is. */
  pendingSetup?: boolean
}

function formatDate(value: string | null): string {
  if (!value) return ""
  return new Date(value).toISOString().slice(0, 10)
}

export const MailboxSecuritySettings: Component<MailboxSecuritySettingsProps> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [keyring, { refetch: refetchKeyring }] = createResource(async () => fetchKeyring(api))
  const [migration] = createResource(async () => fetchMigrationState(api))
  // Persisted per browser and read by the plaintext responder (a switch that
  // only moved a local signal turned nothing off), then relayed to the
  // holder's other devices, which follow it here live (agent-mail-access.ts).
  const agentAccess = agentMailAccessState

  // A legacy recovery phrase row is not listed: nothing offers it any more.
  const wraps = () => (keyring()?.wraps ?? []).filter((wrap) => wrapLabel(wrap.type) !== null)
  const hasPassphrase = () => wraps().some((wrap) => wrap.type === "passphrase")
  /** The password row the unlock screen uses: the newest one. */
  const currentPasswordWrap = (): WrapMetadataView | null =>
    wraps()
      .filter((wrap) => wrap.type === "passphrase")
      .reduce<WrapMetadataView | null>(
        (newest, wrap) => (!newest || wrap.createdAt > newest.createdAt ? wrap : newest),
        null,
      )

  const [changing, setChanging] = createSignal(false)
  const [currentPassword, setCurrentPassword] = createSignal("")
  const [newPassword, setNewPassword] = createSignal("")
  const [newPasswordAgain, setNewPasswordAgain] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal<string | null>(null)

  function closeChange(): void {
    setChanging(false)
    setCurrentPassword("")
    setNewPassword("")
    setNewPasswordAgain("")
  }

  /**
   * Change the mailbox password. The current password is proven by opening the
   * mailbox with it (in minting mode, so the worker can wrap the same mailbox
   * under the new one); the new password row is added BEFORE the old ones are
   * deleted, so no failure can leave the mailbox without a password.
   */
  async function changePassword(): Promise<void> {
    const oldWrap = currentPasswordWrap()
    const client = mailboxCryptoClient()
    setError(null)
    setNotice(null)
    if (!oldWrap) return
    if (!client) {
      setError(i18n.t("kernel.mailboxEncryption.unlock.failures.workerMissing"))
      return
    }
    if (newPassword() !== newPasswordAgain()) {
      setError(i18n.t("kernel.mailboxEncryption.passwordsMismatch"))
      return
    }
    setBusy(true)
    try {
      const verdict = await checkPassphrase(newPassword())
      if (!verdict.ok) {
        setError(verdict.reasons.join(" "))
        return
      }
      const opened = await unlockMailbox(api, {
        userId: props.userId,
        wrap: oldWrap,
        secret: currentPassword(),
        mintWraps: true,
      })
      if (!opened) {
        setError(i18n.t("kernel.mailboxEncryption.security.currentPasswordWrong"))
        return
      }
      try {
        const minted = await client.mintWrap({ kind: "passphrase", passphrase: newPassword() })
        const added = await addWrap(api, { ...minted, label: "Mailbox password" })
        for (const wrap of wraps()) {
          if (wrap.type === "passphrase" && wrap.id !== added.id) await deleteWrap(api, wrap.id)
        }
      } finally {
        await client.endMinting()
      }
      closeChange()
      setNotice(i18n.t("kernel.mailboxEncryption.security.passwordChanged"))
      await refreshKeyring()
    } catch {
      setError(i18n.t("kernel.mailboxEncryption.security.passwordNotChanged"))
      await refreshKeyring()
    } finally {
      setBusy(false)
    }
  }

  async function removePasskey(wrap: WrapMetadataView): Promise<void> {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await deleteWrap(api, wrap.id)
      if (devicePasskeyWrapId(props.userId) === wrap.id) forgetDevicePasskey(props.userId)
      setNotice(i18n.t("kernel.mailboxEncryption.security.passkeyRemoved"))
      await refreshKeyring()
    } catch {
      setError(i18n.t("kernel.mailboxEncryption.security.passkeyNotRemoved"))
    } finally {
      setBusy(false)
    }
  }

  async function refreshKeyring(): Promise<void> {
    await refetchKeyring()
    // The unlock screen reads the store's copy: keep it in step with this one.
    await loadMailboxKeyring(api, props.userId).catch(() => undefined)
  }

  return (
    <div class="space-y-6" data-testid="mailbox-security-settings">
      <div class="space-y-2">
        <h3 class="text-lg font-semibold text-text">
          {i18n.t("kernel.mailboxEncryption.security.title")}
        </h3>
        <p class="text-sm text-text-secondary" data-testid="mailbox-security.mode">
          <Show
            when={props.mode === "personal"}
            fallback={i18n.t("kernel.mailboxEncryption.security.sharedMode", {
              email: props.emailAddress,
            })}
          >
            {i18n.t("kernel.mailboxEncryption.security.personalMode", {
              email: props.emailAddress,
            })}
          </Show>
        </p>
        <p class="text-sm text-text-secondary" data-testid="mailbox-security.claim">
          {props.pendingSetup ? pendingSetupClaim(i18n.t) : approvedZeroAccessClaim(i18n.t)}
        </p>
      </div>

      <div class="space-y-2">
        <h4 class="text-sm font-medium text-text">
          {i18n.t("kernel.mailboxEncryption.security.stillVisible")}
        </h4>
        <ul
          class="list-disc space-y-1 pl-5 text-sm text-text-secondary"
          data-testid="mailbox-security.metadata"
        >
          <For each={metadataStillVisible(i18n.t)}>{(field) => <li>{field}</li>}</For>
        </ul>
        <p class="text-xs text-text-tertiary">
          {i18n.t("kernel.mailboxEncryption.security.metadataWhy")}
        </p>
      </div>

      <div class="space-y-2">
        <h4 class="text-sm font-medium text-text">
          {i18n.t("kernel.mailboxEncryption.security.unlockMethods")}
        </h4>
        <ul
          class="space-y-1 text-sm text-text-secondary"
          data-testid="mailbox-security.unlock-methods"
        >
          <For each={wraps()}>
            {(wrap) => (
              <li
                class="flex items-center gap-2"
                data-testid={`mailbox-security.wrap-${wrap.type}`}
              >
                <span>{wrapLabel(wrap.type, i18n.t)}</span>
                <span class="text-xs text-text-tertiary">
                  {i18n.t("kernel.mailboxEncryption.security.wrapAdded", {
                    date: formatDate(wrap.createdAt),
                  })}
                </span>
                {/* A passkey is a shortcut: removing it is safe only while a
                    mailbox password remains to open the mailbox everywhere. */}
                <Show when={wrap.type === "passkey_prf" && hasPassphrase()}>
                  <button
                    type="button"
                    class="ml-auto text-xs text-text-tertiary hover:text-red-500 hover:underline disabled:opacity-50"
                    data-testid="mailbox-security.remove-passkey"
                    data-wrap-id={wrap.id}
                    disabled={busy()}
                    onClick={() => void removePasskey(wrap)}
                  >
                    {i18n.t("kernel.mailboxEncryption.security.removePasskey")}
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <p class="text-xs text-text-secondary" data-testid="mailbox-security.password-policy">
          {mailboxPasswordExplainer(i18n.t)}{" "}
          {i18n.t("kernel.mailboxEncryption.security.forgotPassword")}
        </p>

        <Show when={changing()}>
          <div
            class="space-y-2 rounded-lg border border-border p-3"
            data-testid="mailbox-security.change-password-form"
          >
            <input
              type="password"
              autocomplete="current-password"
              data-testid="mailbox-security.current-password"
              aria-label={i18n.t("kernel.mailboxEncryption.security.currentPasswordLabel")}
              placeholder={i18n.t("kernel.mailboxEncryption.security.currentPasswordLabel")}
              class="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm"
              value={currentPassword()}
              onInput={(event) => setCurrentPassword(event.currentTarget.value)}
            />
            <input
              type="password"
              autocomplete="new-password"
              data-testid="mailbox-security.new-password"
              aria-label={i18n.t("kernel.mailboxEncryption.security.newPasswordLabel")}
              placeholder={i18n.t("kernel.mailboxEncryption.security.newPasswordLabel")}
              class="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm"
              value={newPassword()}
              onInput={(event) => setNewPassword(event.currentTarget.value)}
            />
            <input
              type="password"
              autocomplete="new-password"
              data-testid="mailbox-security.new-password-again"
              aria-label={i18n.t("kernel.mailboxEncryption.unlock.passwordAgainLabel")}
              placeholder={i18n.t("kernel.mailboxEncryption.unlock.passwordAgainLabel")}
              class="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm"
              value={newPasswordAgain()}
              onInput={(event) => setNewPasswordAgain(event.currentTarget.value)}
            />
            <div class="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                data-testid="mailbox-security.save-password"
                disabled={busy() || !currentPassword() || !newPassword()}
                onClick={() => void changePassword()}
              >
                {i18n.t("kernel.mailboxEncryption.security.savePassword")}
              </Button>
              <button
                type="button"
                class="text-xs text-text-tertiary hover:underline"
                data-testid="mailbox-security.cancel-password"
                onClick={closeChange}
              >
                {i18n.t("kernel.common.cancel")}
              </button>
            </div>
          </div>
        </Show>

        <Show when={error()}>
          {(message) => (
            <p class="text-xs text-red-500" role="alert" data-testid="mailbox-security.error">
              {message()}
            </p>
          )}
        </Show>
        <Show when={notice()}>
          {(message) => (
            <p
              class="text-xs text-text-secondary"
              role="status"
              data-testid="mailbox-security.notice"
            >
              {message()}
            </p>
          )}
        </Show>

        <div class="flex flex-wrap items-center gap-2">
          <Show when={hasPassphrase() && !changing()}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="mailbox-security.change-password"
              onClick={() => {
                setError(null)
                setNotice(null)
                setChanging(true)
              }}
            >
              {i18n.t("kernel.mailboxEncryption.security.changePassword")}
            </Button>
          </Show>
          <Show when={props.mode === "personal"}>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="mailbox-security.reset"
              onClick={() => requestMailboxReset()}
            >
              {i18n.t("kernel.mailboxEncryption.security.resetMailbox")}
            </Button>
          </Show>
        </div>
      </div>

      <div class="space-y-2">
        <h4 class="text-sm font-medium text-text">
          {i18n.t("kernel.mailboxEncryption.security.assistant")}
        </h4>
        <p class="text-sm text-text-secondary" data-testid="mailbox-security.agent-residual">
          {agentResidualCopy(i18n.t)}
        </p>
        <label class="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            data-testid="mailbox-security.agent-access-toggle"
            checked={agentAccess()}
            onChange={(event) => {
              const record = setAgentMailAccessEnabled(event.currentTarget.checked)
              void publishAgentMailAccess(api, record, agentMailAccessSyncDeps())
            }}
          />
          {i18n.t("kernel.mailboxEncryption.security.assistantToggle")}
        </label>
      </div>

      <Show when={props.mode === "personal" && props.accountId}>
        {(accountId) => <MailboxVerificationPanel accountId={accountId()} />}
      </Show>

      <Show when={migration()?.backupsClearAfter}>
        {(clearAfter) => (
          <p class="text-xs text-amber-600" data-testid="mailbox-security.backups-clear-after">
            {i18n.t("kernel.mailboxEncryption.security.backupsClearAfter", {
              date: formatDate(clearAfter()),
            })}
          </p>
        )}
      </Show>

      <details class="text-xs text-text-tertiary" data-testid="mailbox-security.learn-more">
        <summary class="cursor-pointer text-text-secondary hover:underline">
          {i18n.t("kernel.mailboxEncryption.security.learnMore")}
        </summary>
        <div class="mt-2 space-y-2">
          <Show when={hasPassphrase()}>
            <p data-testid="mailbox-security.passphrase-caveat">{passphraseCaveat(i18n.t)}</p>
          </Show>
          <p data-testid="mailbox-security.rotation-note">{rotationNote(i18n.t)}</p>
          <p data-testid="mailbox-security.operator-limit">
            {operatorJavascriptLimitation(i18n.t)}
          </p>
        </div>
      </details>
    </div>
  )
}
