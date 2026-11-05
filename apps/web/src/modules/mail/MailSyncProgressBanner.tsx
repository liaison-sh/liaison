// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The first import of a mailbox is long: a ten thousand message mailbox pages
// through Gmail for the better part of an hour, paced on purpose so the rest
// of the system never feels it. From the inbox that looks like an empty or
// half-filled list with no explanation, and the one status word the settings
// page shows ("syncing") never moves. This banner sits above the list while
// the import runs, names the mailbox, and shows a count that visibly grows.
//
// Copy rules:
//   * The address is named, so a user with several mailboxes knows which one.
//   * "New mail keeps arriving" is a fact: the incremental sync runs alongside
//     the import from the first page (the history cursor is seeded up front).
//   * No dash punctuation anywhere, asserted by the test.
//
// A mailbox whose sync is suspended by encryption enrollment is NOT an import
// in progress, whatever its status word says; that case belongs to
// MailEncryptionEnrollmentBanner and is excluded here so the two never stack.

import { type Component, createEffect, For, onCleanup, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  allAccounts,
  isSyncingEncryptionState,
  loadAccounts,
  type MailAccount,
} from "~/modules/mail/mail-account-store"
import { useApi } from "~/modules/shell/ApiContext"

export interface MailSyncProgressBannerProps {
  /** Defaults to every visible mailbox. */
  accounts?: MailAccount[]
  /** How often to re-read the accounts while an import runs. 0 disables. */
  refreshMs?: number
}

/** Refresh cadence while an import is running. Each page of the import saves
 *  its count every few seconds, so a quarter minute keeps the number moving
 *  without turning the inbox into a poller. */
export const SYNC_PROGRESS_REFRESH_MS = 15_000

function isSuspendedByEncryption(account: MailAccount): boolean {
  if (account.ownerType !== "user") return false
  const state = account.encryptionState
  return state != null && !isSyncingEncryptionState(state)
}

/** The first import is running: the mailbox has not reached `active` yet. */
export function isImporting(account: MailAccount): boolean {
  if (isSuspendedByEncryption(account)) return false
  return account.syncStatus === "pre-sync" || account.syncStatus === "syncing"
}

function progressSentence(
  account: MailAccount,
  i18n: { t: (key: string, params?: Record<string, string>) => string; locale: () => string },
): string {
  if (account.syncStatus === "pre-sync" || account.messagesSynced === 0) {
    return i18n.t("mail.sync.importingFirstPass", { email: account.emailAddress })
  }
  const count = account.messagesSynced.toLocaleString(i18n.locale())
  return i18n.t("mail.sync.importingCount", { email: account.emailAddress, count })
}

export const MailSyncProgressBanner: Component<MailSyncProgressBannerProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const importing = () => (props.accounts ?? allAccounts()).filter(isImporting)
  const refreshMs = () => props.refreshMs ?? SYNC_PROGRESS_REFRESH_MS

  // Poll only while something is importing, and only when the banner reads
  // the shared store (a caller passing its own list owns its own refresh).
  createEffect(() => {
    if (props.accounts || refreshMs() <= 0 || importing().length === 0) return
    const timer = setInterval(() => {
      void loadAccounts(api).catch(() => {})
    }, refreshMs())
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={importing().length > 0}>
      <div class="flex flex-col gap-2 px-3 pt-2">
        <For each={importing()}>
          {(account) => (
            <div
              data-testid="mail-sync-progress-banner"
              data-account-id={account.id}
              data-sync-status={account.syncStatus}
              class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-surface-sunken px-4 py-3 text-[13px] text-text-secondary ring-1 ring-border"
            >
              <span
                class="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
                aria-hidden="true"
              />
              <span data-testid="mail-sync-progress-banner.text">
                {progressSentence(account, i18n)}
              </span>
              <span>{i18n.t("mail.newMailKeepsArrivingWhileThe")}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
