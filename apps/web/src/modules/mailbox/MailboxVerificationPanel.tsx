// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one place a person can run the full-mailbox decrypt sweep (spec section 7
// step 6, SC6).
//
// What the copy has to be honest about, because the consequence is
// irreversible: this proves the encrypted copy of every message opens, and it
// is the only thing that lets the readable copies be removed later. So a
// refusal is stated as a refusal, with the messages that failed named, and a
// partial run says it did not finish rather than showing a reassuring number.

import { type Component, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  localSweepResumeStore,
  MailboxSweepError,
  type SweepProgress,
} from "~/modules/mailbox/verification-sweep"
import { startMailboxVerificationSweep } from "~/modules/mailbox/verification-sweep-host"
import { useApi } from "~/modules/shell/ApiContext"

export interface MailboxVerificationPanelProps {
  accountId: string
}

export const MailboxVerificationPanel: Component<MailboxVerificationPanelProps> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [running, setRunning] = createSignal(false)
  const [progress, setProgress] = createSignal<SweepProgress | null>(null)
  const [result, setResult] = createSignal<string | null>(null)
  const [refused, setRefused] = createSignal<string | null>(null)

  async function run(): Promise<void> {
    setRunning(true)
    setResult(null)
    setRefused(null)
    setProgress(null)
    try {
      const outcome = await startMailboxVerificationSweep({
        api,
        accountId: props.accountId,
        onProgress: (value) => setProgress(value),
      })
      if (outcome.completed) {
        setResult(
          i18n.t("kernel.mailboxEncryption.verification.completed", { count: outcome.verified }),
        )
      } else {
        setResult(
          outcome.stoppedBecause === "locked"
            ? i18n.t("kernel.mailboxEncryption.verification.notFinishedLocked", {
                count: outcome.verified,
              })
            : i18n.t("kernel.mailboxEncryption.verification.notFinishedStopped", {
                count: outcome.verified,
              }),
        )
      }
    } catch (error) {
      if (error instanceof MailboxSweepError) {
        const ids = error.failures.map((f) => f.id).join(", ")
        setRefused(
          i18n.t("kernel.mailboxEncryption.verification.refused", {
            ids: ids || i18n.t("kernel.mailboxEncryption.verification.refusedNoIds"),
          }),
        )
      } else {
        setRefused(
          i18n.t("kernel.mailboxEncryption.verification.couldNotRun", {
            reason: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    } finally {
      setRunning(false)
    }
  }

  /**
   * The saved position is cleared only by a run that finished, so a run that
   * cannot finish would otherwise be a dead end with no remedy on screen.
   * Discarding it costs one full re-walk and nothing else: the state holds a
   * cursor and message ids, never anything the server does not already have,
   * and nothing is signed until the whole mailbox opens again.
   */
  async function discardResume(): Promise<void> {
    await localSweepResumeStore().clear()
    setProgress(null)
    setRefused(null)
    setResult(i18n.t("kernel.mailboxEncryption.verification.discarded"))
  }

  return (
    <div class="space-y-2" data-testid="mailbox-verification-panel">
      <h4 class="text-sm font-medium text-text">
        {i18n.t("kernel.mailboxEncryption.verification.title")}
      </h4>
      <p class="text-sm text-text-secondary">
        {i18n.t("kernel.mailboxEncryption.verification.intro")}
      </p>
      <button
        type="button"
        class="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-hover disabled:opacity-50"
        data-testid="mailbox-verify.start"
        disabled={running()}
        onClick={() => void run()}
      >
        {running()
          ? i18n.t("kernel.mailboxEncryption.verification.checking")
          : i18n.t("kernel.mailboxEncryption.verification.start")}
      </button>
      <button
        type="button"
        class="ml-2 rounded-md px-3 py-1.5 text-sm text-text-secondary underline hover:text-text disabled:opacity-50"
        data-testid="mailbox-verify.discard-resume"
        disabled={running()}
        onClick={() => void discardResume()}
      >
        {i18n.t("kernel.mailboxEncryption.verification.startOver")}
      </button>
      <p class="text-xs text-text-tertiary">
        {i18n.t("kernel.mailboxEncryption.verification.startOverHint")}
      </p>
      <Show when={progress()}>
        {(value) => (
          <p class="text-xs text-text-tertiary" data-testid="mailbox-verify.progress">
            {value().total != null
              ? i18n.t("kernel.mailboxEncryption.verification.progressOf", {
                  verified: value().verified,
                  total: value().total as number,
                })
              : i18n.t("kernel.mailboxEncryption.verification.progress", {
                  verified: value().verified,
                })}
          </p>
        )}
      </Show>
      <Show when={result()}>
        {(text) => (
          <p class="text-sm text-text-secondary" data-testid="mailbox-verify.result">
            {text()}
          </p>
        )}
      </Show>
      <Show when={refused()}>
        {(text) => (
          <p class="text-sm text-red-600" role="alert" data-testid="mailbox-verify.refused">
            {text()}
          </p>
        )}
      </Show>
    </div>
  )
}
