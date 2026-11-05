// SPDX-License-Identifier: FSL-1.1-ALv2
import { useI18n } from "~/modules/i18n/i18n-context"

/**
 * The thread list could not be read. Both columns (the phone Chats root and the
 * desktop sidebar) render it in place of their empty state, so a refusal is
 * never mistaken for an empty workspace.
 */
export function ThreadsLoadFailedNotice(props: { onRetry: () => void; retrying: boolean }) {
  const i18n = useI18n()
  return (
    <div
      data-testid="threads-load-failed"
      class="flex flex-col items-center gap-2 px-4 py-8 text-center text-[13px] text-text-tertiary"
    >
      <span>{i18n.t("kernel.threadsLoadFailed")}</span>
      <button
        type="button"
        data-testid="threads-load-retry"
        // A read can take a moment, and a button that looks idle while its own
        // request is on the wire invites the press that makes it worse.
        disabled={props.retrying}
        aria-busy={props.retrying}
        class="rounded-md border border-border-subtle px-2 py-1 text-[12px] text-text transition-colors hover:bg-surface-hover disabled:cursor-default disabled:opacity-60"
        onClick={props.onRetry}
      >
        {props.retrying ? i18n.t("kernel.threadsLoadRetrying") : i18n.t("kernel.threadsLoadRetry")}
      </button>
    </div>
  )
}
