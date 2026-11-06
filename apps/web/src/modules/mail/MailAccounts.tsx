// SPDX-License-Identifier: FSL-1.1-ALv2
// The Mail settings page's "Your email accounts" block (custom block
// `MailAccounts`, declared in the mail manifest `settings`): personal and
// shared mailboxes with their sync state, encryption enrolment and access,
// and the encryption-aware Gmail / IMAP connect flows.

import { imapLoginFailureFromError } from "@liaison/shared"
import { A } from "@solidjs/router"
import { Mail, RefreshCw, Unplug } from "lucide-solid"
import { type Component, createEffect, createSignal, For, onMount, Show, untrack } from "solid-js"
import { onEntityChange } from "~/framework/entity-changes"
import { cn } from "~/lib/cn"
import { canAccessScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { MailEncryptionSettings } from "~/modules/mail/MailEncryptionSettings"
import {
  loadAccounts,
  type MailAccount,
  personalAccounts,
  sharedAccounts,
} from "~/modules/mail/mail-account-store"
import {
  conversionTotal,
  loadMailboxEncryptionSettings,
  mailboxEncryptionSettings,
  makeMailboxPrivate,
  makeMailboxTransparent,
  newMailboxesAreTransparent,
  requestMakeTransparentCode,
} from "~/modules/mail/mail-encryption-store"
import { getMailProvider, loadMailProviders } from "~/modules/mail/mail-provider-store"
import { MailboxEnrollment } from "~/modules/mailbox/MailboxEnrollment"
import { MailboxSecuritySettings } from "~/modules/mailbox/MailboxSecuritySettings"
import { fetchKeyring } from "~/modules/mailbox/mailbox-api"
import { isMailboxUnlocked } from "~/modules/mailbox/mailbox-store"
import { requestMailboxReset, requestMailboxUnlock } from "~/modules/mailbox/mailbox-unlock-bus"
import {
  revealSettingsSection,
  settingsSectionHref,
} from "~/modules/settings/app-page/reveal-section"
import { capLimitMessage } from "~/modules/settings/cap-limit-message"
import { DisconnectConfirmDialog } from "~/modules/settings/DisconnectConfirmDialog"
import { connectWithOAuth } from "~/modules/settings/oauth-connect"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

type ImapConnectProblem = "unreachable" | "not_found" | "timeout" | "tls"

/** The known ways an IMAP connection fails before sign-in, from the stored error. */
export function imapConnectProblem(error: string): ImapConnectProblem | null {
  if (/ENOTFOUND|EAI_AGAIN/.test(error)) return "not_found"
  if (/^IMAP timeout|ETIMEDOUT|timed out/i.test(error)) return "timeout"
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b|wrong version number/i.test(error)) return "tls"
  if (/^IMAP connection refused|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET/.test(error)) {
    return "unreachable"
  }
  return null
}

/** Gmail write-back failures, stored on the mailbox as `gmail_write_back:<kind>`. */
const GMAIL_WRITE_BACK_ERROR_KEYS: Record<string, string> = {
  "gmail_write_back:auth": "mail.gmailWriteBackAuth",
  "gmail_write_back:scope": "mail.gmailWriteBackScope",
  "gmail_write_back:rejected": "mail.gmailWriteBackRejected",
  "gmail_write_back:unavailable": "mail.gmailWriteBackUnavailable",
  "imap_write_back:auth": "mail.imapWriteBackAuth",
  "imap_write_back:rejected": "mail.imapWriteBackRejected",
  "imap_write_back:unavailable": "mail.imapWriteBackUnavailable",
}

export const MailAccounts: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [connecting, setConnecting] = createSignal(false)
  const [showImapForm, setShowImapForm] = createSignal(false)
  const [adminConnectMode, setAdminConnectMode] = createSignal<"user" | "org">("user")
  // Which personal mailbox has its security panel open, if any.
  const [securityAccountId, setSecurityAccountId] = createSignal<string | null>(null)
  // Non-null while the enrollment wizard is holding up a connect flow.
  const [enrollmentFor, setEnrollmentFor] = createSignal<"user" | null>(null)
  // Which EXISTING personal mailbox has the enrollment wizard open under it.
  const [enrollAccountId, setEnrollAccountId] = createSignal<string | null>(null)
  // A connect the server refused (e.g. a mailbox outside the org's allowed
  // domains) comes back from the OAuth callback as ?oauth_error=…
  const [connectError, setConnectError] = createSignal<string | null>(null)

  async function hasMailboxKeyring(): Promise<boolean> {
    try {
      const keyring = await fetchKeyring(api)
      return keyring.identities.some((identity) => identity.status === "active")
    } catch {
      // A surface that cannot answer must not wave the connect through: a
      // mailbox that syncs before it has keys writes plaintext.
      return false
    }
  }

  const gmailProvider = () => getMailProvider("gmail")
  const gmailConfigured = () => gmailProvider()?.integrationConfigured === true
  const gmailEnabled = () => gmailProvider()?.enabled === true
  const gmailAvailable = () => gmailEnabled() && gmailConfigured()
  // "Open Mail Setup" lands on the Gmail switch (the Mailbox types section of
  // this same settings page): a plain link to the page would do nothing here.
  const mailSetupHref = settingsSectionHref("mail", "providers")
  const revealMailSetup = () => revealSettingsSection("mail", "providers")

  const gmailAvailability = () => {
    const provider = gmailProvider()
    const isMailAdmin = canAccessScope("mail:accounts:admin")

    if (!provider) {
      return {
        available: false,
        message: i18n.t("mail.checkingGmailWorkspaceSetup"),
        ctaLabel: null,
      }
    }

    if (!provider.integrationConfigured) {
      return {
        available: false,
        message: isMailAdmin
          ? i18n.t("mail.googleCredentialsAreNotSetUp")
          : i18n.t("mail.googleCredentialsAreNotSetUp2"),
        ctaLabel: isMailAdmin ? i18n.t("mail.openMailSetup") : null,
      }
    }

    if (!provider.enabled) {
      return {
        available: false,
        message: isMailAdmin
          ? i18n.t("mail.gmailIsTurnedOffForThis")
          : i18n.t("mail.gmailConnectionsAreTurnedOffFor"),
        ctaLabel: isMailAdmin ? i18n.t("mail.openMailSetup") : null,
      }
    }

    return {
      available: true,
      message: i18n.t("mail.connectAGmailAccountUsingYour"),
      ctaLabel: null,
    }
  }

  // A mailbox connected or disconnected (here, on a card in a conversation, or
  // by the agent) and the Gmail switch flipped elsewhere show without a reload.
  onEntityChange(["mail:account", "mail:provider", "kernel:connected_account"], () => {
    void loadAccounts(api)
    void loadMailProviders(api)
  })

  onMount(() => {
    void loadAccounts(api)
    void loadMailProviders(api)
    void loadMailboxEncryptionSettings(api)
    const params = new URLSearchParams(window.location.search)
    if (params.get("oauth_error")) {
      setConnectError(
        capLimitMessage((k, p) => i18n.t(k, p), params.get("oauth_error")) ??
          (params.get("oauth_error_description") || params.get("oauth_error")),
      )
    }
  })

  async function connectGmail(ownerType: "user" | "org"): Promise<void> {
    // Spec section 5.1: no mail sync may start until the mailbox keys exist.
    // A personal mailbox therefore enrols FIRST and the OAuth handoff is the
    // step after the keys are persisted, never before. A shared org mailbox is
    // not encrypted this way, so it connects directly.
    // A transparent (server-managed) mailbox has no keys to set up first: the
    // server seals it under the mailbox's own key from the first message.
    if (ownerType === "user" && !newMailboxesAreTransparent() && !(await hasMailboxKeyring())) {
      setEnrollmentFor("user")
      return
    }
    setConnecting(true)
    try {
      await connectWithOAuth(
        api,
        "/connections/mail/gmail/authorize",
        { mode: ownerType === "org" ? "org" : "personal" },
        {
          navigate: (url) => {
            window.location.href = url
          },
        },
      )
    } finally {
      setConnecting(false)
    }
  }

  function needsReauth(account: MailAccount): boolean {
    return account.connectionHealth?.status === "needs_reconnect"
  }

  /** A Gmail write-back failure arrives as a code; any other sync error as the server's text. */
  function syncErrorText(error: string): string {
    const key = GMAIL_WRITE_BACK_ERROR_KEYS[error]
    if (key) return i18n.t(key)
    // A refused IMAP sign-in names its reason; the sentence says what to do.
    const login = imapLoginFailureFromError(error)
    if (login) return i18n.t(`mail.imapLogin.${login}`)
    // A server that could not be reached reads as a sentence in the UI
    // language; the raw cause stays in the line's title for whoever debugs.
    const connect = imapConnectProblem(error)
    if (connect) return i18n.t(`mail.imapConnect.${connect}`)
    return i18n.t("mail.lastSyncFailed")
  }

  /** The words beside the status dot of a mailbox that never synced. */
  function neverSyncedText(account: MailAccount): string {
    if (needsEncryptionSetup(account)) return i18n.t("mail.syncState.waitingForSetup")
    if (account.syncStatus === "syncing") return i18n.t("mail.syncState.syncing")
    return i18n.t("mail.syncState.notYet")
  }

  /** A sync that keeps failing waits before it tries again: when, calmly. */
  function retryText(account: MailAccount): string | null {
    if (!account.nextRetryAt) return null
    const at = new Date(account.nextRetryAt)
    if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) return null
    // In the page's language, and only the time when the retry is today.
    const today = at.toDateString() === new Date().toDateString()
    const time = at.toLocaleString(i18n.locale(), {
      ...(today ? {} : { day: "numeric", month: "short" }),
      hour: "2-digit",
      minute: "2-digit",
    })
    return i18n.t("mail.syncPausedUntil", { time })
  }

  /** What an IMAP mailbox keeps in step with its server, one calm line. */
  function serverSyncText(account: MailAccount): string | null {
    const sync = account.serverSync
    if (!sync) return null
    const items = [
      i18n.t("mail.serverSync.readAndStar"),
      ...(sync.archive ? [i18n.t("mail.serverSync.archive")] : []),
      ...(sync.trash ? [i18n.t("mail.serverSync.trash")] : []),
      ...(sync.sent ? [i18n.t("mail.serverSync.sent")] : []),
    ]
    const line = i18n.t("mail.serverSync.summary", {
      items: items.join(", "),
      minutes: sync.pollMinutes,
    })
    if (!sync.archive) return `${line} ${i18n.t("mail.serverSync.archiveLocal")}`
    return sync.archiveReadBack === false
      ? `${line} ${i18n.t("mail.serverSync.archiveNotReadBack")}`
      : line
  }

  function reauthHint(account: MailAccount): string {
    const health = account.connectionHealth
    if (health?.reason === "missing_scopes") {
      return i18n.t("mail.reauthHint", { scopes: (health.missingScopes ?? []).join(", ") })
    }
    return health?.statusMessage ?? i18n.t("mail.theAccountIsNoLongerAuthorized")
  }

  async function reauthorize(account: MailAccount): Promise<void> {
    if (account.provider === "imap") {
      // IMAP has no OAuth flow: re-enter credentials.
      if (account.ownerType === "org") setAdminConnectMode("org")
      setShowImapForm(true)
      return
    }
    // Same authorize flow as Connect Gmail: the OAuth callback rebinds the
    // existing mail account (matched by email address) to the fresh grant.
    await connectGmail(account.ownerType)
  }

  function inError(account: MailAccount): boolean {
    return account.syncStatus === "error" || Boolean(account.lastSyncError)
  }

  // The IMAP form the connect button opens, for this mailbox: saving it
  // replaces the stored settings and password (the same route as a connect).
  // It opens with what the account stores (hosts, ports, username; never the
  // password), so the person changes only what is wrong.
  const [imapInitial, setImapInitial] = createSignal<ImapFormInitial | null>(null)
  async function editImapCredentials(account: MailAccount): Promise<void> {
    setAdminConnectMode(account.ownerType)
    let stored: Record<string, string> = {}
    if (account.connectedAccountId) {
      try {
        const res = await api.get<{ settings: Record<string, string> }>(
          `/connections/${account.connectedAccountId}/settings`,
          { suppressGlobalError: true },
        )
        stored = res.settings ?? {}
      } catch {
        // The form still opens: the person types what could not be loaded.
      }
    }
    setImapInitial({ ...stored, email: stored.email ?? account.emailAddress })
    setShowImapForm(true)
  }

  // A sync the server refused (a missing scope, a disconnected account) is
  // said on the mailbox's row, never dropped.
  const [syncError, setSyncError] = createSignal<{ accountId: string; message: string } | null>(
    null,
  )
  async function syncAccount(accountId: string): Promise<void> {
    setSyncError(null)
    try {
      await api.post(`/mail/accounts/${accountId}/sync`, undefined, { suppressGlobalError: true })
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : i18n.t("mail.syncFailed")
      setSyncError({ accountId, message })
      return
    }
    await loadAccounts(api)
  }
  const syncErrorFor = (accountId: string) => {
    const e = syncError()
    return e && e.accountId === accountId ? e.message : null
  }

  /**
   * A personal mailbox the server reports as not `ready` fetches no mail. The
   * inbox banner says so and sends the user here, so this page has to offer
   * the way out. It never runs the OAuth connect again: the grant is fine,
   * only the keys are missing, and a reconnect used to restart the mailbox
   * import from scratch.
   */
  function needsEncryptionSetup(account: MailAccount): boolean {
    if (account.ownerType !== "user") return false
    const state = account.encryptionState
    return state === "pending_enrollment" || state === "paused" || state === "none"
  }

  /**
   * A `blocked` personal mailbox: its keys exist but new mail could not be
   * stored with them, so setting up again has nothing to do. The way out the
   * server offers is the reset (`blocked -> pending_enrollment`), after which
   * the new password arms the mailbox and it downloads again from the provider.
   */
  function needsReset(account: MailAccount): boolean {
    return account.ownerType === "user" && account.encryptionState === "blocked"
  }

  async function setUpEncryption(account: MailAccount): Promise<void> {
    if (await hasMailboxKeyring()) {
      // The keys exist (enrolled for another mailbox, or a grace window that
      // elapsed): arm this mailbox to them and fetch what is waiting.
      await api.post("/mailbox-keys/arm")
      await syncAccount(account.id)
      return
    }
    setEnrollAccountId(account.id)
  }

  // Switching a mailbox between transparent and private asks first, inline.
  // Starting a move to transparent (not resuming one) needs a step-up: a code
  // emailed for that purpose, entered here before the move starts.
  const [modeSwitch, setModeSwitch] = createSignal<{
    accountId: string
    to: "private" | "transparent"
    needsStepUp?: boolean
  } | null>(null)
  const [stepUpCode, setStepUpCode] = createSignal("")
  const [stepUpCodeSent, setStepUpCodeSent] = createSignal(false)
  const stepUpCodeReady = () => /^\d{6}$/.test(stepUpCode().trim())

  function openModeSwitch(next: {
    accountId: string
    to: "private" | "transparent"
    needsStepUp?: boolean
  }): void {
    setStepUpCode("")
    setStepUpCodeSent(false)
    setModeSwitch(next)
  }

  async function sendStepUpCode(accountId: string): Promise<void> {
    if (modeSwitchBusy()) return
    setModeSwitchBusy(true)
    try {
      await requestMakeTransparentCode(api)
      setStepUpCode("")
      setStepUpCodeSent(true)
      setModeSwitchMessage({ accountId, text: i18n.t("mail.encryption.codeSent") })
    } catch (err) {
      setModeSwitchMessage({
        accountId,
        text: i18n.t("mail.encryption.failed", { message: (err as Error)?.message ?? String(err) }),
      })
    } finally {
      setModeSwitchBusy(false)
    }
  }
  const [modeSwitchBusy, setModeSwitchBusy] = createSignal(false)
  const [modeSwitchMessage, setModeSwitchMessage] = createSignal<{
    accountId: string
    text: string
  } | null>(null)

  function canMakePrivate(account: MailAccount): boolean {
    return (
      account.ownerType === "user" &&
      account.encryptionState === "managed" &&
      !account.encryptionConversion &&
      mailboxEncryptionSettings()?.allowPrivate === true
    )
  }

  function canMakeTransparent(account: MailAccount): boolean {
    return (
      account.ownerType === "user" &&
      account.encryptionState === "ready" &&
      !account.encryptionConversion &&
      mailboxEncryptionSettings()?.canMakeTransparent === true
    )
  }

  /** A move between modes that stopped part way: its owner finishes it. */
  function unfinishedMove(account: MailAccount): "private" | "transparent" | null {
    if (account.ownerType !== "user") return null
    if (account.encryptionConversion === "to_private") return "private"
    if (account.encryptionConversion === "to_managed") return "transparent"
    return null
  }

  // A "make transparent" waiting on the unlock popup resumes by itself when
  // the mailbox opens. Dismissing the popup leaves the panel up to try again.
  const [awaitingUnlock, setAwaitingUnlock] = createSignal<string | null>(null)
  createEffect(() => {
    const accountId = awaitingUnlock()
    if (!accountId || !isMailboxUnlocked()) return
    setAwaitingUnlock(null)
    if (modeSwitch()?.accountId === accountId) untrack(() => void confirmModeSwitch())
  })

  async function confirmModeSwitch(): Promise<void> {
    const pending = modeSwitch()
    if (!pending || modeSwitchBusy()) return
    const say = (text: string) => setModeSwitchMessage({ accountId: pending.accountId, text })
    if (pending.to === "transparent" && pending.needsStepUp && !stepUpCodeReady()) {
      say(i18n.t("mail.encryption.codeNeeded"))
      return
    }
    if (pending.to === "private" && !(await hasMailboxKeyring())) {
      setModeSwitch(null)
      say(i18n.t("mail.encryption.needsPassword"))
      setEnrollAccountId(pending.accountId)
      return
    }
    if (pending.to === "transparent" && !isMailboxUnlocked()) {
      // The browser re-encrypts, so it needs the mailbox open: ask for the
      // password or passkey right here, then carry on once it is unlocked.
      say(i18n.t("mail.encryption.needsUnlock"))
      setAwaitingUnlock(pending.accountId)
      requestMailboxUnlock()
      return
    }
    setModeSwitchBusy(true)
    try {
      if (pending.to === "private") {
        say(i18n.t("mail.encryption.convertingPrivate"))
        const result = await makeMailboxPrivate(api, pending.accountId)
        say(i18n.t("mail.encryption.converted", { count: conversionTotal(result) }))
      } else {
        const result = await makeMailboxTransparent(
          api,
          pending.accountId,
          (count) => say(i18n.t("mail.encryption.converting", { count })),
          pending.needsStepUp ? { stepUpCode: stepUpCode().trim() } : undefined,
        )
        say(
          result.done
            ? i18n.t("mail.encryption.converted", { count: result.converted })
            : i18n.t("mail.encryption.notFinished", { count: result.remaining }),
        )
      }
      setModeSwitch(null)
    } catch (err) {
      // A code is used once, right or wrong: the next try takes a fresh one.
      setStepUpCode("")
      say(i18n.t("mail.encryption.failed", { message: (err as Error)?.message ?? String(err) }))
    } finally {
      setModeSwitchBusy(false)
      await loadAccounts(api)
    }
  }

  // Disconnecting deletes the mailbox's imported mail: it asks first.
  const [pendingDisconnect, setPendingDisconnect] = createSignal<{
    connectionId: string
    name: string
  } | null>(null)
  const [disconnectBusy, setDisconnectBusy] = createSignal(false)

  async function disconnectAccount(connectionId: string): Promise<void> {
    await api.delete(`/connections/${connectionId}`)
    await loadAccounts(api)
  }

  async function confirmDisconnect(): Promise<void> {
    const pending = pendingDisconnect()
    if (!pending || disconnectBusy()) return
    setDisconnectBusy(true)
    try {
      await disconnectAccount(pending.connectionId)
      setPendingDisconnect(null)
    } finally {
      setDisconnectBusy(false)
    }
  }

  return (
    <div class="space-y-6" data-testid="mail-account-settings">
      <DisconnectConfirmDialog
        open={pendingDisconnect() !== null}
        name={pendingDisconnect()?.name ?? ""}
        body={i18n.t("mail.disconnectConfirmBody")}
        busy={disconnectBusy()}
        testId="mail-account-disconnect-dialog"
        onConfirm={() => void confirmDisconnect()}
        onCancel={() => setPendingDisconnect(null)}
      />
      <Show when={connectError()}>
        <div
          role="alert"
          data-testid="mail-connect-error"
          class="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm"
        >
          <p class="font-medium text-danger">{i18n.t("mail.mailboxNotConnected")}</p>
          <p class="mt-1 text-text-secondary">{connectError()}</p>
        </div>
      </Show>
      <Show when={enrollmentFor() && userFromToken()?.userId}>
        {(userId) => (
          <div class="rounded-lg border border-border bg-surface p-4">
            <MailboxEnrollment
              userId={userId()}
              emailAddress=""
              onEnrolled={() => {
                setEnrollmentFor(null)
                void connectGmail("user")
              }}
            />
          </div>
        )}
      </Show>
      <MailEncryptionSettings />
      <div class="space-y-2" data-testid="mail-account-list">
        <For each={personalAccounts()}>
          {(account) => (
            <div class="rounded-lg border border-border bg-surface px-4 py-3">
              {/* The identity keeps at least 16rem: when the actions do not fit
                  beside it they wrap below it, never squeeze it to "ad…". */}
              <div data-testid="mail-account-row" class="flex items-start gap-3">
                <Mail size={20} class="mt-0.5 text-text-tertiary shrink-0" />
                <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
                  <div data-testid="mail-account-identity" class="min-w-0 flex-[1_1_16rem]">
                    <p
                      data-testid="mail-account-address"
                      class="truncate text-sm font-medium text-text"
                      title={account.emailAddress}
                    >
                      {account.emailAddress}
                    </p>
                    <div
                      data-testid="mail-account-chips"
                      class="mt-1 flex flex-wrap items-center gap-1.5"
                    >
                      <span class="whitespace-nowrap rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-text-tertiary">
                        {account.provider}
                      </span>
                      <span class="whitespace-nowrap rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-text-tertiary">
                        {i18n.t("mail.personal")}
                      </span>
                      <Show
                        when={
                          account.encryptionState === "managed" ||
                          account.encryptionState === "ready"
                        }
                      >
                        <span
                          class="whitespace-nowrap rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-text-tertiary"
                          data-testid="mail-account-encryption-mode"
                          data-mode={account.encryptionState === "managed" ? "managed" : "private"}
                        >
                          {i18n.t(
                            account.encryptionState === "managed"
                              ? "mail.encryption.transparent"
                              : "mail.encryption.private",
                          )}
                        </span>
                      </Show>
                      <Show when={needsReauth(account)}>
                        <span
                          class="whitespace-nowrap rounded-full bg-warning-glow border border-warning-border px-2 py-0.5 text-[10px] font-medium text-warning"
                          data-testid="mail-account-health-badge"
                        >
                          {account.connectionHealth?.reason === "missing_scopes"
                            ? i18n.t("mail.reAuthorizationRequired")
                            : i18n.t("mail.needsReconnection")}
                        </span>
                      </Show>
                      <Show when={needsEncryptionSetup(account)}>
                        <span
                          class="whitespace-nowrap rounded-full bg-warning-glow border border-warning-border px-2 py-0.5 text-[10px] font-medium text-warning"
                          data-testid="mail-account-encryption-badge"
                        >
                          {i18n.t("mail.encryptionSetupNeeded")}
                        </span>
                      </Show>
                      <Show when={needsReset(account)}>
                        <span
                          class="whitespace-nowrap rounded-full bg-warning-glow border border-warning-border px-2 py-0.5 text-[10px] font-medium text-warning"
                          data-testid="mail-account-stopped-badge"
                        >
                          {i18n.t("mail.mailStopped")}
                        </span>
                      </Show>
                    </div>
                    <div class="mt-1 flex min-w-0 items-center gap-2">
                      <SyncStatusIndicator status={account.syncStatus} />
                      {/* A mailbox waiting for its keys has fetched nothing: no
                          "Last synced", whatever the row carries. */}
                      <Show
                        when={
                          account.lastSyncAt && account.encryptionState !== "pending_enrollment"
                        }
                      >
                        <span
                          class="whitespace-nowrap text-xs text-text-tertiary"
                          data-testid="mail-account-last-synced"
                        >
                          {i18n.t("mail.lastSynced")}{" "}
                          {i18n.fmtDate(new Date(account.lastSyncAt!), {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </span>
                      </Show>
                      <Show
                        when={
                          (!account.lastSyncAt ||
                            account.encryptionState === "pending_enrollment") &&
                          !account.lastSyncError
                        }
                      >
                        <span
                          class="whitespace-nowrap text-xs text-text-tertiary"
                          data-testid="mail-account-never-synced"
                        >
                          {neverSyncedText(account)}
                        </span>
                      </Show>
                      <Show when={account.lastSyncError}>
                        <span
                          class="min-w-0 truncate text-xs text-text-secondary"
                          data-testid="mail-account-sync-error"
                          title={account.lastSyncError!}
                        >
                          {syncErrorText(account.lastSyncError!)}
                        </span>
                      </Show>
                    </div>
                    <Show when={retryText(account)}>
                      {(text) => (
                        <p
                          class="mt-0.5 text-xs text-text-tertiary"
                          data-testid="mail-account-sync-retry"
                        >
                          {text()}
                        </p>
                      )}
                    </Show>
                    <Show when={serverSyncText(account)}>
                      {(text) => (
                        <p
                          class="mt-0.5 text-xs text-text-tertiary"
                          data-testid="mail-account-server-sync"
                        >
                          {text()}
                        </p>
                      )}
                    </Show>
                    <Show when={syncErrorFor(account.id)}>
                      {(message) => (
                        <p
                          role="alert"
                          class="mt-1 text-xs text-red-500"
                          data-testid="mail-account-sync-refused"
                        >
                          {message()}
                        </p>
                      )}
                    </Show>
                    <Show when={needsReauth(account)}>
                      <p class="mt-1 text-xs text-warning" data-testid="mail-account-health-hint">
                        {reauthHint(account)}
                      </p>
                    </Show>
                  </div>
                  <div
                    data-testid="mail-account-actions"
                    class="flex flex-wrap items-center gap-1 whitespace-nowrap"
                  >
                    <Show when={needsReauth(account)}>
                      <Button
                        size="sm"
                        data-testid="mail-account-reauthorize"
                        onClick={() => void reauthorize(account)}
                      >
                        {i18n.t("mail.reAuthorize")}
                      </Button>
                    </Show>
                    <Show when={needsEncryptionSetup(account)}>
                      <Button
                        size="sm"
                        data-testid="mail-account-enroll"
                        onClick={() => void setUpEncryption(account)}
                      >
                        {i18n.t("mail.setUpEncryption")}
                      </Button>
                    </Show>
                    <Show when={needsReset(account)}>
                      <Button
                        size="sm"
                        data-testid="mail-account-reset"
                        onClick={() => requestMailboxReset()}
                      >
                        {i18n.t("mail.resetMailbox")}
                      </Button>
                    </Show>
                    <Show when={canMakePrivate(account)}>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid="mail-account-make-private"
                        onClick={() => openModeSwitch({ accountId: account.id, to: "private" })}
                      >
                        {i18n.t("mail.encryption.makePrivate")}
                      </Button>
                    </Show>
                    <Show when={unfinishedMove(account)}>
                      {(to) => (
                        <Button
                          size="sm"
                          data-testid="mail-account-finish-mode-switch"
                          onClick={() => openModeSwitch({ accountId: account.id, to: to() })}
                        >
                          {i18n.t(
                            to() === "private"
                              ? "mail.encryption.finishPrivate"
                              : "mail.encryption.finishTransparent",
                          )}
                        </Button>
                      )}
                    </Show>
                    <Show when={canMakeTransparent(account)}>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid="mail-account-make-transparent"
                        onClick={() =>
                          openModeSwitch({
                            accountId: account.id,
                            to: "transparent",
                            needsStepUp: true,
                          })
                        }
                      >
                        {i18n.t("mail.encryption.makeTransparent")}
                      </Button>
                    </Show>
                    {/* The security panel is the private (zero-access) mailbox's:
                        keys, mailbox password, passkeys. A transparent mailbox
                        has none of them. */}
                    <Show
                      when={account.ownerType === "user" && account.encryptionState !== "managed"}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid="mail-account-security"
                        onClick={() =>
                          setSecurityAccountId(
                            securityAccountId() === account.id ? null : account.id,
                          )
                        }
                      >
                        {i18n.t("mail.mailboxSecurity")}
                      </Button>
                    </Show>
                    {/* No sync before the keys exist: the setup action above is
                        the way forward, and a sync would download nothing. */}
                    <Show when={!needsEncryptionSetup(account)}>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid="mail-account-sync"
                        onClick={() => void syncAccount(account.id)}
                      >
                        <RefreshCw size={14} />
                        <span>
                          {account.syncStatus === "error"
                            ? i18n.t("mail.retrySync")
                            : i18n.t("mail.syncNow")}
                        </span>
                      </Button>
                    </Show>
                    <button
                      type="button"
                      data-testid="mail-account-disconnect"
                      class="rounded p-1.5 text-text-tertiary hover:bg-surface-hover hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-text-tertiary"
                      disabled={!account.connectedAccountId}
                      onClick={() =>
                        account.connectedAccountId &&
                        setPendingDisconnect({
                          connectionId: account.connectedAccountId,
                          name: account.emailAddress,
                        })
                      }
                      title={
                        account.connectedAccountId
                          ? i18n.t("kernel.common.disconnect")
                          : i18n.t("mail.thisLegacyAccountIsMissingIts")
                      }
                      aria-label={i18n.t("kernel.common.disconnect")}
                    >
                      <Unplug size={14} />
                    </button>
                  </div>
                </div>
              </div>
              <Show when={modeSwitch()?.accountId === account.id ? modeSwitch() : null}>
                {(pending) => (
                  <div
                    class="mt-3 border-t border-border pt-3 space-y-2"
                    data-testid="mail-account-mode-switch"
                  >
                    <p class="text-xs text-text-secondary">
                      {i18n.t(
                        pending().to === "private"
                          ? "mail.encryption.makePrivateConfirm"
                          : "mail.encryption.makeTransparentConfirm",
                      )}
                    </p>
                    <Show when={pending().needsStepUp}>
                      <div class="space-y-2" data-testid="mail-account-mode-switch-step-up">
                        <p class="text-xs text-text-secondary">
                          {i18n.t("mail.encryption.stepUpPrompt")}
                        </p>
                        <div class="flex flex-wrap items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            data-testid="mail-account-mode-switch-send-code"
                            disabled={modeSwitchBusy()}
                            onClick={() => void sendStepUpCode(pending().accountId)}
                          >
                            {i18n.t("mail.encryption.emailCode")}
                          </Button>
                          <Show when={stepUpCodeSent()}>
                            <input
                              data-testid="mail-account-mode-switch-code"
                              inputmode="numeric"
                              autocomplete="one-time-code"
                              maxLength={6}
                              aria-label={i18n.t("mail.encryption.codeLabel")}
                              placeholder={i18n.t("mail.encryption.codeLabel")}
                              class="w-40 rounded border border-border bg-surface px-2 py-1 text-xs"
                              value={stepUpCode()}
                              onInput={(event) => setStepUpCode(event.currentTarget.value)}
                            />
                          </Show>
                        </div>
                      </div>
                    </Show>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        data-testid="mail-account-mode-switch-confirm"
                        disabled={modeSwitchBusy() || (pending().needsStepUp && !stepUpCodeReady())}
                        onClick={() => void confirmModeSwitch()}
                      >
                        {i18n.t(
                          pending().to === "private"
                            ? "mail.encryption.makePrivate"
                            : "mail.encryption.makeTransparent",
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={modeSwitchBusy()}
                        onClick={() => setModeSwitch(null)}
                      >
                        {i18n.t("kernel.common.cancel")}
                      </Button>
                    </div>
                  </div>
                )}
              </Show>
              <Show
                when={
                  modeSwitchMessage()?.accountId === account.id ? modeSwitchMessage()?.text : null
                }
              >
                {(text) => (
                  <p
                    class="mt-2 text-xs text-text-secondary"
                    data-testid="mail-account-mode-switch-message"
                  >
                    {text()}
                  </p>
                )}
              </Show>
              <Show when={enrollAccountId() === account.id && userFromToken()?.userId}>
                {(userId) => (
                  <div class="mt-3 border-t border-border pt-3">
                    <MailboxEnrollment
                      userId={userId()}
                      emailAddress={account.emailAddress}
                      onEnrolled={() => {
                        // The enroll route arms every mailbox this user owns;
                        // one sync fetches what accumulated at the provider.
                        setEnrollAccountId(null)
                        void syncAccount(account.id)
                      }}
                    />
                  </div>
                )}
              </Show>
              <Show when={securityAccountId() === account.id && userFromToken()?.userId}>
                {(userId) => (
                  <div class="mt-3 border-t border-border pt-3">
                    <MailboxSecuritySettings
                      userId={userId()}
                      emailAddress={account.emailAddress}
                      mode={account.ownerType === "user" ? "personal" : "shared"}
                      accountId={account.id}
                      pendingSetup={account.encryptionState === "pending_enrollment"}
                    />
                  </div>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>

      <div>
        <h4 class="text-sm font-medium text-text mb-1">{i18n.t("mail.connectAnAccount")}</h4>
        {/* Said BEFORE the connect: a personal mailbox is encrypted, and the
            enrollment that follows asks for a mailbox password. */}
        <p class="mb-3 text-xs text-text-secondary" data-testid="mail-connect-encryption-notice">
          {i18n.t(
            newMailboxesAreTransparent()
              ? "mail.personalMailboxTransparentNotice"
              : "mail.personalMailboxEncryptionNotice",
          )}
        </p>
        <div class="grid grid-cols-2 gap-3">
          <div
            class={cn(
              "rounded-lg border p-4 transition-colors",
              gmailAvailable()
                ? "border-border hover:bg-surface-hover"
                : "border-border bg-surface",
            )}
          >
            <button
              type="button"
              data-testid="mail-connect-gmail"
              class="flex w-full flex-col items-center gap-2"
              onClick={() => void connectGmail("user")}
              disabled={connecting() || !gmailAvailable()}
            >
              <Mail
                size={24}
                class={gmailAvailable() ? "text-text-secondary" : "text-text-tertiary"}
              />
              <span
                class={cn(
                  "text-sm font-medium",
                  gmailAvailable() ? "text-text" : "text-text-secondary",
                )}
              >
                {i18n.t("mail.connectGmail")}
              </span>
            </button>
            <p class="mt-3 text-xs text-text-secondary">{gmailAvailability().message}</p>
            <Show when={gmailAvailability().ctaLabel}>
              <A
                href={mailSetupHref}
                onClick={revealMailSetup}
                data-testid="mail-open-setup"
                class="mt-2 inline-block text-xs text-accent hover:underline"
              >
                {gmailAvailability().ctaLabel}
              </A>
            </Show>
          </div>
          <button
            type="button"
            data-testid="mail-connect-imap"
            class="flex flex-col items-center gap-2 rounded-lg border border-border p-4 hover:bg-surface-hover transition-colors"
            onClick={() => setShowImapForm(true)}
          >
            <Mail size={24} class="text-text-secondary" />
            <span class="text-sm font-medium text-text">{i18n.t("mail.connectImapSmtp")}</span>
          </button>
        </div>
      </div>

      <Show when={canAccessScope("mail:accounts:admin")}>
        <div class="rounded-lg border border-border bg-surface p-4 space-y-3">
          <div class="flex items-center justify-between">
            <div>
              <h4 class="text-sm font-medium text-text">
                {i18n.t("mail.organizationOwnedAccounts")}
              </h4>
              <p class="text-xs text-text-secondary">
                {i18n.t("mail.visibleOnlyToMailAdministrators")}
              </p>
            </div>
            <button
              type="button"
              data-testid="mail-connect-shared-gmail"
              class="rounded border border-border px-3 py-1.5 text-xs hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
              onClick={() => void connectGmail("org")}
              disabled={!gmailAvailable()}
            >
              {i18n.t("mail.connectSharedGmail")}
            </button>
          </div>
          <Show when={!gmailAvailable()}>
            <div class="text-xs text-text-secondary">
              {gmailAvailability().message}{" "}
              <Show when={gmailAvailability().ctaLabel}>
                <A
                  href={mailSetupHref}
                  onClick={revealMailSetup}
                  data-testid="mail-open-setup-shared"
                  class="text-accent hover:underline"
                >
                  {gmailAvailability().ctaLabel}
                </A>
              </Show>
            </div>
          </Show>
          <button
            type="button"
            data-testid="mail-connect-shared-imap"
            class="text-xs text-accent hover:underline"
            onClick={() => {
              setAdminConnectMode("org")
              setShowImapForm(true)
            }}
          >
            {i18n.t("mail.connectSharedImapSmtp")}
          </button>
          <div class="space-y-2">
            <For each={sharedAccounts()}>
              {(account) => (
                <div
                  data-testid="mail-shared-account-row"
                  class="flex items-start gap-3 rounded-lg border border-border px-4 py-3"
                >
                  <Mail size={18} class="mt-0.5 text-text-tertiary shrink-0" />
                  <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
                    <div class="min-w-0 flex-[1_1_16rem]">
                      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span
                          class="min-w-0 max-w-full truncate text-sm font-medium text-text"
                          title={account.emailAddress}
                        >
                          {account.emailAddress}
                        </span>
                        <Show when={needsReauth(account)}>
                          <span
                            class="whitespace-nowrap rounded-full bg-warning-glow border border-warning-border px-2 py-0.5 text-[10px] font-medium text-warning"
                            data-testid="mail-shared-account-health-badge"
                          >
                            {account.connectionHealth?.reason === "missing_scopes"
                              ? i18n.t("mail.reAuthorizationRequired")
                              : i18n.t("mail.needsReconnection")}
                          </span>
                        </Show>
                      </div>
                      <div class="text-xs text-text-tertiary">{account.provider}</div>
                      <Show when={serverSyncText(account)}>
                        {(text) => (
                          <p
                            class="text-xs text-text-tertiary"
                            data-testid="mail-shared-account-server-sync"
                          >
                            {text()}
                          </p>
                        )}
                      </Show>
                      <Show when={account.lastSyncError}>
                        <p
                          class="text-xs text-text-secondary"
                          data-testid="mail-shared-account-sync-error"
                          title={account.lastSyncError!}
                        >
                          {syncErrorText(account.lastSyncError!)}
                        </p>
                      </Show>
                      <Show when={retryText(account)}>
                        {(text) => (
                          <p
                            class="text-xs text-text-tertiary"
                            data-testid="mail-shared-account-sync-retry"
                          >
                            {text()}
                          </p>
                        )}
                      </Show>
                      <Show when={syncErrorFor(account.id)}>
                        {(message) => (
                          <p
                            role="alert"
                            class="text-xs text-red-500"
                            data-testid="mail-shared-account-sync-refused"
                          >
                            {message()}
                          </p>
                        )}
                      </Show>
                      <Show when={needsReauth(account)}>
                        <p
                          class="text-xs text-warning"
                          data-testid="mail-shared-account-health-hint"
                        >
                          {reauthHint(account)}
                        </p>
                      </Show>
                      <A
                        data-testid="mail-shared-account-manage-access"
                        href={`/settings/admin/roles?dimension=${encodeURIComponent("mail:inbox")}&value=${encodeURIComponent(account.id)}`}
                        class="text-[12px] text-accent hover:underline"
                      >
                        {i18n.t("mail.manageAccess")}
                      </A>
                    </div>
                    <div class="flex flex-wrap items-center gap-1 whitespace-nowrap">
                      <Show when={needsReauth(account)}>
                        <Button
                          size="sm"
                          data-testid="mail-shared-account-reauthorize"
                          onClick={() => void reauthorize(account)}
                        >
                          {i18n.t("mail.reAuthorize")}
                        </Button>
                      </Show>
                      {/* A mailbox in error is retried on its own later; these let
                      an admin retry now, or fix the settings that fail. */}
                      <Show when={inError(account)}>
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid="mail-shared-account-retry"
                          onClick={() => void syncAccount(account.id)}
                        >
                          <RefreshCw size={14} />
                          <span>{i18n.t("mail.retryNow")}</span>
                        </Button>
                        <Show when={account.provider === "imap" && !needsReauth(account)}>
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid="mail-shared-account-edit"
                            onClick={() => void editImapCredentials(account)}
                          >
                            {i18n.t("mail.editCredentials")}
                          </Button>
                        </Show>
                      </Show>
                      <button
                        type="button"
                        data-testid="mail-shared-account-disconnect"
                        class="rounded p-1.5 text-text-tertiary hover:bg-surface-hover hover:text-red-500"
                        aria-label={i18n.t("kernel.common.disconnect")}
                        title={i18n.t("kernel.common.disconnect")}
                        onClick={() =>
                          account.connectedAccountId &&
                          setPendingDisconnect({
                            connectionId: account.connectedAccountId,
                            name: account.emailAddress,
                          })
                        }
                      >
                        <Unplug size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={showImapForm()}>
        <ImapForm
          ownerType={adminConnectMode()}
          initial={imapInitial() ?? undefined}
          api={api}
          onClose={() => {
            setShowImapForm(false)
            setImapInitial(null)
          }}
          onSuccess={() => {
            setShowImapForm(false)
            setImapInitial(null)
            void loadAccounts(api)
          }}
        />
      </Show>
    </div>
  )
}

const SyncStatusIndicator: Component<{ status: string }> = (props) => {
  const color = () => {
    if (props.status === "error") return "bg-red-500"
    if (props.status === "syncing") return "bg-yellow-500 animate-pulse"
    return "bg-green-500"
  }
  return <div class={cn("h-2 w-2 rounded-full", color())} />
}

const IMAP_PRESETS: Record<
  string,
  { imapHost: string; imapPort: string; smtpHost: string; smtpPort: string }
> = {
  Fastmail: {
    imapHost: "imap.fastmail.com",
    imapPort: "993",
    smtpHost: "smtp.fastmail.com",
    smtpPort: "465",
  },
  Yahoo: {
    imapHost: "imap.mail.yahoo.com",
    imapPort: "993",
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: "465",
  },
  iCloud: {
    imapHost: "imap.mail.me.com",
    imapPort: "993",
    smtpHost: "smtp.mail.me.com",
    smtpPort: "587",
  },
  "ProtonMail Bridge": {
    imapHost: "127.0.0.1",
    imapPort: "1143",
    smtpHost: "127.0.0.1",
    smtpPort: "1025",
  },
}

/** The stored settings an edit opens with (never a password). */
export type ImapFormInitial = Partial<
  Record<"email" | "imapHost" | "imapPort" | "smtpHost" | "smtpPort" | "username", string>
>

/** How SMTP is secured. The server reads it from the port: 465 is implicit TLS, any other STARTTLS. */
export type SmtpSecurity = "starttls" | "tls"

/** The SMTP port each security mode uses by default. */
export const SMTP_DEFAULT_PORT: Record<SmtpSecurity, string> = { starttls: "587", tls: "465" }

export function smtpSecurityOf(port: string): SmtpSecurity {
  return port.trim() === "465" ? "tls" : "starttls"
}

const ImapForm: Component<{
  api: ReturnType<typeof useApi>
  ownerType: "user" | "org"
  /** The mailbox whose settings are edited; absent for a new connection. */
  initial?: ImapFormInitial
  onClose: () => void
  onSuccess: () => void
}> = (props) => {
  const i18n = useI18n()
  const initial = props.initial ?? {}
  const [fields, setFields] = createSignal({
    email: initial.email ?? "",
    imapHost: initial.imapHost ?? "",
    imapPort: initial.imapPort ?? "993",
    smtpHost: initial.smtpHost ?? "",
    smtpPort: initial.smtpPort ?? SMTP_DEFAULT_PORT.starttls,
    username: initial.username ?? "",
    password: "",
  })
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  function applyPreset(name: string): void {
    const p = IMAP_PRESETS[name]
    if (p) setFields((f) => ({ ...f, ...p }))
  }

  /** A new security mode moves a default port to the mode's own; a custom port stays. */
  function setSmtpSecurity(mode: SmtpSecurity): void {
    setFields((f) => {
      const port = f.smtpPort.trim()
      const isDefault = port === "" || Object.values(SMTP_DEFAULT_PORT).includes(port)
      return isDefault ? { ...f, smtpPort: SMTP_DEFAULT_PORT[mode] } : f
    })
  }

  async function submit(): Promise<void> {
    setSubmitting(true)
    setError(null)
    try {
      await props.api.post("/connections/mail/imap/credentials", {
        ...fields(),
        mode: props.ownerType === "org" ? "org" : "personal",
      })
      props.onSuccess()
    } catch (err: any) {
      setError(
        capLimitMessage((k, p) => i18n.t(k, p), err?.code) ?? err.message ?? "Connection failed",
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      data-testid="mail-imap-form"
      class="rounded-lg border border-border bg-surface p-4 space-y-3"
    >
      <div class="flex items-center justify-between">
        <h4 class="text-sm font-medium text-text">{i18n.t("mail.imapSmtpConnection")}</h4>
        <div class="flex gap-1">
          {Object.keys(IMAP_PRESETS).map((name) => (
            <button
              type="button"
              data-testid={`mail-imap-preset-${name.toLowerCase()}`}
              class="text-xs text-accent hover:underline"
              onClick={() => applyPreset(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <input
        data-testid="mail-imap-email"
        class="w-full rounded border border-border px-2 py-1.5 text-sm"
        placeholder={i18n.t("mail.email")}
        value={fields().email}
        onInput={(e) => setFields((f) => ({ ...f, email: e.currentTarget.value }))}
      />
      <div class="grid grid-cols-2 gap-2">
        <input
          data-testid="mail-imap-host"
          class="rounded border border-border px-2 py-1.5 text-sm"
          placeholder={i18n.t("mail.imapHost")}
          value={fields().imapHost}
          onInput={(e) => setFields((f) => ({ ...f, imapHost: e.currentTarget.value }))}
        />
        <input
          data-testid="mail-imap-port"
          class="rounded border border-border px-2 py-1.5 text-sm"
          placeholder={i18n.t("mail.imapPort")}
          value={fields().imapPort}
          onInput={(e) => setFields((f) => ({ ...f, imapPort: e.currentTarget.value }))}
        />
        <input
          data-testid="mail-smtp-host"
          class="rounded border border-border px-2 py-1.5 text-sm"
          placeholder={i18n.t("mail.smtpHost")}
          value={fields().smtpHost}
          onInput={(e) => setFields((f) => ({ ...f, smtpHost: e.currentTarget.value }))}
        />
        <input
          data-testid="mail-smtp-port"
          class="rounded border border-border px-2 py-1.5 text-sm"
          placeholder={i18n.t("mail.smtpPort")}
          value={fields().smtpPort}
          onInput={(e) => setFields((f) => ({ ...f, smtpPort: e.currentTarget.value }))}
        />
      </div>
      <label class="flex items-center gap-2 text-xs text-text-secondary">
        <span>{i18n.t("mail.smtpSecurity")}</span>
        <select
          data-testid="mail-smtp-security"
          class="rounded border border-border bg-surface px-2 py-1 text-sm text-text"
          value={smtpSecurityOf(fields().smtpPort)}
          onChange={(e) => setSmtpSecurity(e.currentTarget.value as SmtpSecurity)}
        >
          <option value="starttls">{i18n.t("mail.smtpStarttls")}</option>
          <option value="tls">{i18n.t("mail.smtpImplicitTls")}</option>
        </select>
      </label>
      <input
        data-testid="mail-imap-username"
        class="w-full rounded border border-border px-2 py-1.5 text-sm"
        placeholder={i18n.t("mail.username")}
        value={fields().username}
        onInput={(e) => setFields((f) => ({ ...f, username: e.currentTarget.value }))}
      />
      <input
        data-testid="mail-imap-password"
        class="w-full rounded border border-border px-2 py-1.5 text-sm"
        type="password"
        placeholder={i18n.t("mail.password")}
        value={fields().password}
        onInput={(e) => setFields((f) => ({ ...f, password: e.currentTarget.value }))}
      />
      <Show when={error()}>
        <p class="text-xs text-red-500">{error()}</p>
      </Show>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="text-sm text-text-secondary hover:text-text"
          onClick={props.onClose}
        >
          {i18n.t("kernel.common.cancel")}
        </button>
        <button
          type="button"
          data-testid="mail-imap-submit"
          class="rounded bg-accent px-3 py-1.5 text-sm text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
          disabled={submitting()}
          onClick={() => void submit()}
        >
          {submitting() ? i18n.t("mail.connecting") : i18n.t("kernel.common.connect")}
        </button>
      </div>
    </div>
  )
}
