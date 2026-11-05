// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The pending-jobs badge (spec section 5.3c, blueprint task 11.3).
//
// This surface exists because the user-visible contract changed. Work that used
// to say "runs at 07:00" now says "runs when you are next online", and a promise
// like that is only honest if the person can see what is waiting. So this shows
// the count, the list, each job's kind and age, and a manual run control while
// the mailbox is unlocked.
//
// It also shows what LAPSED. A job that expired or ran out of attempts is the
// one outcome this queue may not hide: the user asked for the work, and would
// otherwise never learn it did not happen.

import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { relativeTime } from "~/lib/relative-time"
import { englishT, type Translate, tNow, useI18n } from "~/modules/i18n/i18n-context"
import type { ClientJobDrainer, ClientJobView } from "~/modules/mailbox/client-job-drainer"
import { shellTier } from "~/modules/shell/shell-tier"

export interface MailboxPendingJobsProps {
  drainer: ClientJobDrainer
  /** The store's lock state, so the run control matches what the drainer will do. */
  unlocked: boolean
  /** Injectable for the tests. */
  now?: () => number
}

const KIND_KEYS: Record<string, string> = {
  summarise: "kernel.mailboxEncryption.jobs.kinds.summarise",
  triage_label: "kernel.mailboxEncryption.jobs.kinds.triageLabels",
  index_backfill: "kernel.mailboxEncryption.jobs.kinds.buildIndex",
  migration_verify: "kernel.mailboxEncryption.jobs.kinds.verifyEncryption",
}

export function jobKindLabel(kind: string, t: Translate = tNow): string {
  const key = KIND_KEYS[kind]
  return key ? t(key) : kind
}

/** Plain words, no dash punctuation, no false precision. */
export function jobAgeLabel(createdAt: string, now: number, locale = "en"): string {
  // Other languages phrase it through Intl ("il y a 15 minutes").
  if (!locale.startsWith("en")) {
    return relativeTime(createdAt, locale, { now: new Date(now), style: "long" })
  }
  const t = englishT
  const ms = Math.max(0, now - Date.parse(createdAt))
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return t("kernel.mailboxEncryption.jobs.justNow")
  if (minutes < 60) return t("kernel.mailboxEncryption.jobs.minutesAgo", { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t("kernel.mailboxEncryption.jobs.hoursAgo", { count: hours })
  const days = Math.floor(hours / 24)
  return days === 1
    ? t("kernel.mailboxEncryption.jobs.dayAgo")
    : t("kernel.mailboxEncryption.jobs.daysAgo", { count: days })
}

function statusNote(job: ClientJobView, t: Translate): string | null {
  if (job.status === "expired") return t("kernel.mailboxEncryption.jobs.lapsed")
  if (job.status === "failed") return t("kernel.mailboxEncryption.jobs.stopped")
  if (job.status === "claimed") return t("kernel.mailboxEncryption.jobs.runningNow")
  return null
}

export const MailboxPendingJobs: Component<MailboxPendingJobsProps> = (props) => {
  const i18n = useI18n()
  const now = props.now ?? (() => Date.now())
  const [running, setRunning] = createSignal(false)
  const jobs = createMemo(() => props.drainer.jobs())
  const pending = createMemo(() => jobs().filter((job) => job.status === "pending"))
  const attention = createMemo(() => props.drainer.needsAttention())
  // M2-2 T16. At phone width "Run now" is the only control on this surface,
  // and inline text between two sentences is not something a thumb can hit:
  // it becomes a full width row of its own, above the list.
  const phone = () => shellTier() === "phone"

  const runControl = () => (
    <Show when={props.unlocked}>
      <button
        type="button"
        data-testid="mailbox-pending-jobs.run"
        data-phone={phone() ? "true" : "false"}
        class={
          phone()
            ? "mt-2 flex min-h-11 w-full items-center justify-center rounded-lg border border-border text-[15px] text-accent disabled:opacity-50"
            : "text-accent hover:underline disabled:opacity-50"
        }
        disabled={running() || pending().length === 0}
        onClick={async () => {
          setRunning(true)
          try {
            await props.drainer.wake()
          } finally {
            setRunning(false)
          }
        }}
      >
        {running()
          ? i18n.t("kernel.mailboxEncryption.jobs.running")
          : i18n.t("kernel.mailboxEncryption.jobs.runNow")}
      </button>
    </Show>
  )

  return (
    <Show when={jobs().length > 0}>
      <section
        data-testid="mailbox-pending-jobs"
        class="rounded-lg bg-surface-sunken px-4 py-3 text-[13px] text-text-secondary ring-1 ring-border"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span data-testid="mailbox-pending-jobs.count" class="font-medium text-text-primary">
            {i18n.t("kernel.mailboxEncryption.jobs.waiting", { count: pending().length })}
          </span>
          <span>{i18n.t("kernel.mailboxEncryption.jobs.explainer")}</span>
          <Show when={!phone()}>{runControl()}</Show>
        </div>
        <Show when={phone()}>{runControl()}</Show>

        <ul class="mt-2 space-y-1" data-testid="mailbox-pending-jobs.list">
          <For each={jobs()}>
            {(job) => (
              <li
                data-testid={`mailbox-pending-jobs.item.${job.id}`}
                // A long status note next to a long kind label used to push the
                // row past the viewport at phone width, taking the whole page
                // sideways with it.
                class={phone() ? "flex flex-col gap-0.5" : "flex flex-wrap gap-2"}
              >
                <span class="text-text-primary">{jobKindLabel(job.kind, i18n.t)}</span>
                <span>{jobAgeLabel(job.createdAt, now(), i18n.locale())}</span>
                <Show when={statusNote(job, i18n.t)}>
                  {(note) => (
                    <span data-testid={`mailbox-pending-jobs.note.${job.id}`}>{note()}</span>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>

        <Show when={attention().length > 0}>
          <p data-testid="mailbox-pending-jobs.attention" class="mt-2">
            {i18n.t("kernel.mailboxEncryption.jobs.attention", { count: attention().length })}
          </p>
        </Show>
      </section>
    </Show>
  )
}
