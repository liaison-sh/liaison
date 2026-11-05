// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Blueprint task 4.8. The deploy that lands the encryption regime moves every
// existing personal mailbox out of `ready`, and a personal mailbox that is not
// `ready` fetches no mail (`isSyncableAccount`, apps/api mail handlers). Without
// this banner the observable behaviour of a security improvement is "mail
// silently stopped", which is the worst possible framing of it.
//
// Copy rules that are load bearing, not decoration:
//   * The address is named, so the user knows WHICH mailbox went quiet.
//   * "Nothing has been lost" is a fact, not reassurance: the messages are
//     still at the provider and arrive once enrollment finishes.
//   * `paused` gets its own sentence, because it is not "you have not started
//     yet" and a user who reads the first sentence alone would go looking for
//     a setup step they already did.
//   * `blocked` is not a setup problem at all: the keys exist and could not be
//     used. Its banner says mail stopped and offers the one thing that brings
//     it back, a reset (the mail downloads again from the provider).
//   * No dash punctuation anywhere, asserted by the test.
//
// A missing state (`null`) renders NOTHING. The projection can be absent on a
// deploy where the server half has not landed, and a banner on every mailbox
// saying mail has stopped would itself be the incident.

import { ChevronRight, TriangleAlert } from "lucide-solid"
import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { MailAccount, MailEncryptionState } from "~/modules/mail/mail-account-store"
import { allAccounts, isSyncingEncryptionState } from "~/modules/mail/mail-account-store"
import { requestMailboxReset } from "~/modules/mailbox/mailbox-unlock-bus"
import { pluralFormFor } from "~/modules/projects/plural"
import { appSettingsPath } from "~/modules/settings/settings-aliases"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab } from "~/modules/shell/tab-store"
import { OverlaySheet } from "~/ui/OverlaySheet"

export interface MailEncryptionEnrollmentBannerProps {
  /** Defaults to every visible mailbox; `isSuspended` keeps only personal ones. */
  accounts?: MailAccount[]
  /** Defaults to opening the mail accounts settings tab, which hosts the wizard. */
  onSetUp?: (account: MailAccount) => void
  /**
   * A `blocked` mailbox. Setting up again cannot help it: its keys exist and
   * the server could not use them, so the only way out is a reset (which the
   * state machine allows from `blocked`). Defaults to opening the reset flow.
   */
  onReset?: (account: MailAccount) => void
}

/**
 * Suspended means "personal, and the server told us it is not ready". Org
 * mailboxes are not in the regime at all, and `null` is unknown, not suspended.
 */
function isSuspended(account: MailAccount): boolean {
  if (account.ownerType !== "user") return false
  const state = account.encryptionState
  return state != null && !isSyncingEncryptionState(state)
}

/** The extra sentence a state earns, or null when the first sentence says it all. */
function stateSentence(state: MailEncryptionState): string | null {
  if (state === "paused") return "mail.encryption.pausedSentence"
  return null
}

const AccountBanner: Component<{
  account: MailAccount
  onSetUp: (account: MailAccount) => void
  onReset: (account: MailAccount) => void
}> = (props) => {
  const i18n = useI18n()
  const state = () => (props.account.encryptionState ?? "none") as MailEncryptionState
  const blocked = () => state() === "blocked"
  return (
    <div
      data-testid="mail-encryption-enrollment-banner"
      data-account-id={props.account.id}
      data-encryption-state={state()}
      class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-surface-sunken px-4 py-3 text-[13px] text-text-secondary ring-1 ring-border"
    >
      <Show
        when={blocked()}
        fallback={
          <>
            <span>
              {i18n.t("mail.newMailFor")} {props.account.emailAddress}{" "}
              {i18n.t("mail.isPausedLiaisonIsSwitchingPersonal")}
            </span>
            <Show when={stateSentence(state())}>
              {(sentence) => <span>{i18n.t(sentence())}</span>}
            </Show>
          </>
        }
      >
        <span>
          {i18n.t("mail.encryption.blockedSentence", { email: props.account.emailAddress })}
        </span>
      </Show>
      <button
        type="button"
        data-testid="mail-encryption-enrollment-banner.action"
        data-action={blocked() ? "reset" : "set-up"}
        class="text-accent hover:underline"
        onClick={() => (blocked() ? props.onReset(props.account) : props.onSetUp(props.account))}
      >
        {blocked() ? i18n.t("mail.resetMailbox") : i18n.t("mail.setUpEncryption")}
      </button>
    </div>
  )
}

// K3: at phone width, one full `AccountBanner` per suspended mailbox pushed
// the conversation list below the fold once there were two or three of them —
// the desktop layout has room for that; a 390px screen does not. This is the
// phone tier's collapse: a single 44px warning row naming the count, opening a
// bottom sheet that lists each mailbox with its own "Set up encryption"
// action (the same mutation `AccountBanner` invokes, `onSetUp`).
const CompactMailboxNotice: Component<{
  accounts: MailAccount[]
  onSetUp: (account: MailAccount) => void
  onReset: (account: MailAccount) => void
}> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const count = () => props.accounts.length
  const label = () =>
    i18n.t(
      pluralFormFor(i18n.locale(), count()) === "one"
        ? "kernel.mailboxesNeedSetupOne"
        : "kernel.mailboxesNeedSetupMany",
      { count: count() },
    )
  return (
    <>
      <button
        type="button"
        data-testid="mail-encryption-enrollment-compact"
        data-count={count()}
        class="flex min-h-11 w-full items-center gap-2 rounded-lg border border-warning-border bg-warning-glow px-4 text-[13px] font-medium text-warning"
        onClick={() => setOpen(true)}
      >
        <TriangleAlert size={16} class="shrink-0" />
        <span class="min-w-0 flex-1 truncate text-left">{label()}</span>
        <ChevronRight size={16} class="shrink-0" />
      </button>
      <OverlaySheet
        open={open()}
        onClose={() => setOpen(false)}
        variant="bottom"
        title={i18n.t("kernel.mailboxesNeedSetupTitle")}
        closeLabel={i18n.t("kernel.close")}
      >
        <div class="flex flex-col divide-y divide-border-subtle">
          <For each={props.accounts}>
            {(account) => (
              <div
                data-testid="mail-encryption-enrollment-compact.row"
                data-account-id={account.id}
                class="flex items-center justify-between gap-2 px-4 py-3"
              >
                <span class="min-w-0 flex-1 truncate text-[14px] text-text">
                  {account.emailAddress}
                </span>
                <button
                  type="button"
                  data-testid="mail-encryption-enrollment-compact.action"
                  data-action={account.encryptionState === "blocked" ? "reset" : "set-up"}
                  class="shrink-0 text-accent hover:underline"
                  onClick={() =>
                    account.encryptionState === "blocked"
                      ? props.onReset(account)
                      : props.onSetUp(account)
                  }
                >
                  {account.encryptionState === "blocked"
                    ? i18n.t("mail.resetMailbox")
                    : i18n.t("kernel.mailSetUpEncryption")}
                </button>
              </div>
            )}
          </For>
        </div>
      </OverlaySheet>
    </>
  )
}

export const MailEncryptionEnrollmentBanner: Component<MailEncryptionEnrollmentBannerProps> = (
  props,
) => {
  const i18n = useI18n()
  const suspended = () => (props.accounts ?? allAccounts()).filter(isSuspended)
  const setUp = (account: MailAccount) => {
    if (props.onSetUp) {
      props.onSetUp(account)
      return
    }
    openTab({
      type: "kernel:settings",
      entityId: "settings",
      label: i18n.t("mail.emailAccounts2"),
      routePath: appSettingsPath("mail"),
    })
  }
  const reset = (account: MailAccount) => {
    if (props.onReset) {
      props.onReset(account)
      return
    }
    requestMailboxReset()
  }
  // The wrapper, spacing included, exists only when there is something to say:
  // an always-present container would leave a padded gap above every inbox.
  return (
    <Show when={suspended().length > 0}>
      <Show
        when={shellTier() === "phone"}
        fallback={
          <div class="flex flex-col gap-2 px-3 pt-2">
            <For each={suspended()}>
              {(account) => <AccountBanner account={account} onSetUp={setUp} onReset={reset} />}
            </For>
          </div>
        }
      >
        <div class="px-3 pt-2">
          <CompactMailboxNotice accounts={suspended()} onSetUp={setUp} onReset={reset} />
        </div>
      </Show>
    </Show>
  )
}
