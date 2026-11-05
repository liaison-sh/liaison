// SPDX-License-Identifier: FSL-1.1-ALv2
// "Mailbox encryption" on the Mail settings page: this person's pick for new
// personal mailboxes (transparent or private), and, for mail admins, the org
// switch that allows private mailboxes at all.

import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  type MailboxEncryptionMode,
  mailboxEncryptionSettings,
  setAllowPrivateMailboxes,
  setMailboxEncryptionPreference,
} from "~/modules/mail/mail-encryption-store"
import { useApi } from "~/modules/shell/ApiContext"

export const MailEncryptionSettings: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const settings = mailboxEncryptionSettings

  const choose = (mode: MailboxEncryptionMode) => void setMailboxEncryptionPreference(api, mode)

  return (
    <Show when={settings()}>
      {(s) => (
        <div
          class="rounded-lg border border-border bg-surface p-4 space-y-3"
          data-testid="mail-encryption-settings"
        >
          <h4 class="text-sm font-medium text-text">{i18n.t("mail.encryption.title")}</h4>
          <Show
            when={s().allowManaged !== false}
            fallback={
              <p class="text-xs text-text-secondary" data-testid="mail-encryption-private-locked">
                {i18n.t("mail.encryption.privateLocked")}
              </p>
            }
          >
            <Show
              when={s().allowPrivate}
              fallback={
                <p class="text-xs text-text-secondary" data-testid="mail-encryption-private-off">
                  {i18n.t("mail.encryption.privateNotAllowed")}
                </p>
              }
            >
              <fieldset class="space-y-2" data-testid="mail-encryption-preference">
                <legend class="text-xs text-text-secondary mb-1">
                  {i18n.t("mail.encryption.newMailboxes")}
                </legend>
                {(["managed", "private"] as const).map((mode) => (
                  <label class="flex items-start gap-2 text-sm text-text cursor-pointer">
                    <input
                      type="radio"
                      name="mail-encryption-mode"
                      data-testid={`mail-encryption-mode-${mode}`}
                      class="mt-1"
                      checked={s().effective === mode}
                      onChange={() => choose(mode)}
                    />
                    <span>
                      <span class="font-medium">
                        {i18n.t(
                          mode === "managed"
                            ? "mail.encryption.transparent"
                            : "mail.encryption.private",
                        )}
                      </span>
                      <span class="block text-xs text-text-secondary">
                        {i18n.t(
                          mode === "managed"
                            ? "mail.encryption.transparentHelp"
                            : "mail.encryption.privateHelp",
                        )}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </Show>
          </Show>
          <Show when={s().canSetPolicy && s().allowManaged !== false}>
            <label class="flex items-start gap-2 border-t border-border pt-3 text-sm text-text cursor-pointer">
              <input
                type="checkbox"
                data-testid="mail-encryption-allow-private"
                class="mt-1"
                checked={s().allowPrivate}
                onChange={(e) => void setAllowPrivateMailboxes(api, e.currentTarget.checked)}
              />
              <span>
                <span class="font-medium">{i18n.t("mail.encryption.allowPrivate")}</span>
                <span class="block text-xs text-text-secondary">
                  {i18n.t("mail.encryption.allowPrivateHelp")}
                </span>
              </span>
            </label>
          </Show>
        </div>
      )}
    </Show>
  )
}
