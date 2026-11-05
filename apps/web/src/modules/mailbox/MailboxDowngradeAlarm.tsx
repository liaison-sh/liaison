// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The visible half of the downgrade detector (spec section 9.2, blueprint task
// 13.1). A detector nobody sees is not a detector, so this sits above the mail
// list rather than inside a settings page.
//
// The threat is an operator who wants the compulsion to stay invisible, so the
// alarm has no close control, no auto-hide, and nothing the server can send
// removes it. The findings are persisted on the device, so a reload is not a way
// to silence it either.
//
// Its OWNER can clear it, on this device, and only by proving the mailbox
// secret again (`MailboxAlarmClearDialog`, `alarm-clear.ts`). The dialog lists
// exactly the findings that go and says that clearing undoes no exposure. The
// proof is the ordinary unlock: the mailbox password, or this computer's
// passkey for a keyring without one, has to open the keyring in the worker, and
// the server cannot produce a wrap that opens without that secret. The server's
// only part is to RECORD the clear in the audit trail; if it will not, nothing
// is cleared. The browser then forgets its records and sweeps again at once, so
// whatever is still wrong raises the alarm again. The posture is unchanged:
// nothing the server does can make this warning go away.
//
// It also states the bound of the check (spec section 9.6). Overselling a
// detector is its own kind of dishonesty.

import { type Component, createSignal, For, Show } from "solid-js"
import { type Translate, tNow, useI18n } from "~/modules/i18n/i18n-context"
import {
  currentDowngradeFindings,
  type DowngradeFinding,
} from "~/modules/mailbox/downgrade-detector"
import { MailboxAlarmClearDialog } from "~/modules/mailbox/MailboxAlarmClearDialog"
import {
  downgradeAlarmFooter,
  downgradeAlarmHeading,
  downgradeAlarmIntro,
  downgradeAlarmKindCopy,
  downgradeAlarmLimitNote,
} from "~/modules/mailbox/mailbox-copy"
import {
  createIndexedDbBlobStore,
  type IndexBlobStore,
} from "~/modules/mailbox/search-index/index-blob-store"

export interface MailboxDowngradeAlarmProps {
  /** Defaults to the module level alarm. Injected in tests. */
  findings?: () => DowngradeFinding[]
  /** The signed in user. Without one there is no owner to clear the alarm. */
  userId?: string | null
  /** Where the alarm is persisted. Defaults to the integrity store. Injected in tests. */
  store?: () => IndexBlobStore
}

export function downgradeFindingLabel(finding: DowngradeFinding, t: Translate = tNow): string {
  const kind = downgradeAlarmKindCopy(finding.kind, t)
  if (finding.subject === "keyring") return kind
  return t("kernel.mailboxEncryption.downgrade.findingWithSubject", {
    kind,
    subject: finding.subject,
  })
}

export const MailboxDowngradeAlarm: Component<MailboxDowngradeAlarmProps> = (props) => {
  const i18n = useI18n()
  const [clearing, setClearing] = createSignal(false)
  const findings = () => (props.findings ?? currentDowngradeFindings)()
  const store = () =>
    props.store?.() ?? createIndexedDbBlobStore("liaison-mailbox-integrity", "records")
  return (
    <Show when={findings().length > 0}>
      <section
        data-testid="mailbox-downgrade-alarm"
        role="alert"
        aria-live="assertive"
        class="m-2 rounded-lg bg-surface-sunken px-4 py-3 text-[13px] text-text-primary ring-1 ring-danger"
      >
        <h2 class="font-medium text-danger" data-testid="mailbox-downgrade-alarm.heading">
          {downgradeAlarmHeading(i18n.t)}
        </h2>
        <p class="mt-1 text-text-secondary">{downgradeAlarmIntro(i18n.t)}</p>
        <ul class="mt-2 space-y-1" data-testid="mailbox-downgrade-alarm.list">
          <For each={findings()}>
            {(finding) => (
              <li data-testid={`mailbox-downgrade-alarm.item.${finding.kind}`}>
                {downgradeFindingLabel(finding, i18n.t)}
              </li>
            )}
          </For>
        </ul>
        <p class="mt-2 text-text-secondary" data-testid="mailbox-downgrade-alarm.footer">
          {downgradeAlarmFooter(i18n.t)}
        </p>
        <p class="mt-1 text-text-secondary" data-testid="mailbox-downgrade-alarm.limits">
          {downgradeAlarmLimitNote(i18n.t)}
        </p>
        <Show when={props.userId}>
          {(userId) => (
            <>
              <button
                type="button"
                class="mt-2 text-xs text-text-tertiary underline hover:text-text-secondary"
                data-testid="mailbox-downgrade-alarm.clear"
                onClick={() => setClearing(true)}
              >
                {i18n.t("kernel.mailboxAlarmClear.open")}
              </button>
              <MailboxAlarmClearDialog
                open={clearing()}
                onOpenChange={setClearing}
                userId={userId()}
                findings={findings}
                label={(finding) => downgradeFindingLabel(finding, i18n.t)}
                store={store}
              />
            </>
          )}
        </Show>
      </section>
    </Show>
  )
}
