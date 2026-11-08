// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings → Organization → Usage and limits: read-only rows (seats,
// mailboxes, storage, background jobs this hour; plans do not limit mailboxes,
// so no mailbox row in the managed edition; then app runs, app calls and app
// CPU today, shown once the org has a cap on them or used them), each "used of limit" or
// "used · unlimited" (`GET /api/org/usage`), and one line saying the limits are
// set by whoever runs the server. Calm on purpose: no edit control and no alarm
// colour; a cap at or past its limit gets one neutral emphasis (stronger text
// and a "Limit reached" note), nothing red or orange.
import type { OrgUsage, OrgUsageEntry } from "@liaison/shared"
import { type Component, createResource, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { billingMode } from "./BillingState"

type Row = {
  id: "seats" | "mailboxes" | "storage" | "jobs" | "appRuns" | "appBridgeCalls" | "appCpuMs"
  /** Undefined: a server that does not report it. */
  entry: (u: OrgUsage) => OrgUsageEntry | undefined
  /** Shown only with a cap or some use (the app rows). */
  quiet?: boolean
  label: string
  help: string
  gb?: boolean
}

const ROWS: Row[] = [
  {
    id: "seats",
    entry: (u) => u.seats,
    label: "kernel.orgUsage.seats",
    help: "kernel.orgUsage.seatsHelp",
  },
  {
    id: "mailboxes",
    entry: (u) => u.mailboxes,
    label: "kernel.orgUsage.mailboxes",
    help: "kernel.orgUsage.mailboxesHelp",
  },
  {
    id: "storage",
    entry: (u) => u.storageGb,
    label: "kernel.orgUsage.storage",
    help: "kernel.orgUsage.storageHelp",
    gb: true,
  },
  {
    id: "jobs",
    entry: (u) => u.jobsThisHour,
    label: "kernel.orgUsage.jobs",
    help: "kernel.orgUsage.jobsHelp",
  },
  {
    id: "appRuns",
    entry: (u) => u.appRunsToday,
    label: "kernel.orgUsage.appRuns",
    help: "kernel.orgUsage.appRunsHelp",
    quiet: true,
  },
  {
    id: "appBridgeCalls",
    entry: (u) => u.appBridgeCallsToday,
    label: "kernel.orgUsage.appBridgeCalls",
    help: "kernel.orgUsage.appBridgeCallsHelp",
    quiet: true,
  },
  {
    id: "appCpuMs",
    entry: (u) => u.appCpuMsToday,
    label: "kernel.orgUsage.appCpuMs",
    help: "kernel.orgUsage.appCpuMsHelp",
    quiet: true,
  },
]

/** Whether a row is shown for this usage. */
export function rowShown(row: Pick<Row, "entry" | "quiet">, u: OrgUsage): boolean {
  const e = row.entry(u)
  if (!e) return false
  return !row.quiet || e.limit !== null || e.used > 0
}

/**
 * At or past the limit. An unlimited cap (null) never is; a cap is a whole
 * number >= 1, so anything under 1 is treated as unlimited too.
 */
export function atLimit(e: OrgUsageEntry): boolean {
  return e.limit !== null && e.limit >= 1 && e.used >= e.limit
}

const OrgUsageSection: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [usage] = createResource(async () => {
    const res = await api.getEnvelope<OrgUsage>("/org/usage")
    return res.data
  })

  const num = (n: number) => n.toLocaleString(i18n.locale())

  const valueText = (row: Row, e: OrgUsageEntry) => {
    if (e.limit === null) {
      return i18n.t(row.gb ? "kernel.orgUsage.storageUnlimited" : "kernel.orgUsage.unlimited", {
        used: num(e.used),
      })
    }
    return i18n.t(row.gb ? "kernel.orgUsage.storageUsedOfLimit" : "kernel.orgUsage.usedOfLimit", {
      used: num(e.used),
      limit: num(e.limit),
    })
  }

  return (
    <div data-testid="org-usage" class="flex flex-col gap-3">
      <p data-testid="org-usage-help" class="text-sm text-text-secondary">
        {i18n.t(
          billingMode() === "managed" ? "kernel.orgUsage.helpManaged" : "kernel.orgUsage.help",
        )}
      </p>
      <Show when={usage.error}>
        <p data-testid="org-usage-load-failed" class="text-sm text-text-secondary">
          {i18n.t("kernel.orgUsage.loadFailed")}
        </p>
      </Show>
      <Show when={!usage.error && usage()}>
        {(u) => (
          <ul data-testid="org-usage-list" class="flex flex-col divide-y divide-border-subtle">
            <For
              each={ROWS.filter(
                (r) => (billingMode() !== "managed" || r.id !== "mailboxes") && rowShown(r, u()),
              )}
            >
              {(row) => {
                const e = () => row.entry(u()) as OrgUsageEntry
                const reached = () => atLimit(e())
                return (
                  <li
                    data-testid={`org-usage-${row.id}`}
                    data-state={e().limit === null ? "unlimited" : reached() ? "at-limit" : "under"}
                    class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm"
                  >
                    <span class="flex flex-col">
                      <span class="text-text">{i18n.t(row.label)}</span>
                      <span class="text-xs text-text-secondary">{i18n.t(row.help)}</span>
                    </span>
                    <span class="flex items-baseline gap-2">
                      <Show when={reached()}>
                        <span
                          class="text-xs text-text-secondary"
                          data-testid={`org-usage-${row.id}-reached`}
                        >
                          {i18n.t("kernel.orgUsage.atLimit")}
                        </span>
                      </Show>
                      <span
                        data-testid={`org-usage-${row.id}-value`}
                        class={reached() ? "font-medium text-text" : "text-text-secondary"}
                      >
                        {valueText(row, e())}
                      </span>
                    </span>
                  </li>
                )
              }}
            </For>
            <Show when={u().storageEstimate}>
              {(est) => (
                <li
                  data-testid="org-usage-storage-estimate"
                  data-state={est().overCap ? "over" : "under"}
                  class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm"
                >
                  <span class="flex flex-col">
                    <span class="text-text">{i18n.t("kernel.orgUsage.storageEstimate")}</span>
                    <span class="text-xs text-text-secondary">
                      {i18n.t("kernel.orgUsage.storageEstimateHelp")}
                    </span>
                    <span
                      class="text-xs text-text-secondary"
                      data-testid="org-usage-storage-estimate-measured"
                    >
                      {i18n.t(
                        est().partial
                          ? "kernel.orgUsage.storageEstimatePartial"
                          : "kernel.orgUsage.storageEstimateMeasured",
                        {
                          date: new Date(est().measuredAt).toLocaleDateString(i18n.locale()),
                        },
                      )}
                    </span>
                  </span>
                  <span class="flex items-baseline gap-2">
                    <Show when={est().overCap}>
                      <span
                        class="text-xs text-text-secondary"
                        data-testid="org-usage-storage-estimate-over"
                      >
                        {i18n.t("kernel.orgUsage.storageEstimateOver")}
                      </span>
                    </Show>
                    <span
                      data-testid="org-usage-storage-estimate-value"
                      class={est().overCap ? "font-medium text-text" : "text-text-secondary"}
                    >
                      {(() => {
                        const limit = est().limitGb
                        return limit === null
                          ? i18n.t("kernel.orgUsage.storageEstimateValueUnlimited", {
                              used: num(est().usedGb),
                            })
                          : i18n.t("kernel.orgUsage.storageEstimateValue", {
                              used: num(est().usedGb),
                              limit: num(limit),
                            })
                      })()}
                    </span>
                  </span>
                </li>
              )}
            </Show>
          </ul>
        )}
      </Show>
    </div>
  )
}

export default OrgUsageSection
