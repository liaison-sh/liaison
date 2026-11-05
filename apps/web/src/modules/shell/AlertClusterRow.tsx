// SPDX-License-Identifier: FSL-1.1-ALv2
// AlertClusterRow — one row standing in for N identical alerts.
//
// A support inbox breaching SLA emits one `sla_risk` attention item per
// ticket, and the urgent strip rendered every one of them: 24 rows of
// "SLA approaching for ticket-N" above everything else, with the Approvals
// card pushed off-screen behind them (2026-09-11). Identical alerts collapse
// into this single counted row; clicking it expands the real AttentionRows
// underneath, so nothing is hidden, it just stops costing 24 rows of height.
//
// Deliberately NOT an AttentionRow variant: this row has no entity, no
// metric and no approve/reject affordance — only a count, a span of ages and
// a disclosure. Keeping it separate leaves AttentionRow's already dense
// approval logic untouched.

import { ChevronDown } from "lucide-solid"
import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import AttentionRow from "~/modules/shell/AttentionRow"
import { type AlertCluster, alertClusterLabel } from "~/modules/shell/attention-groups"
import {
  formatRelativeTime,
  getAppLabel,
  getKindIcon,
  rowLocaleFrom,
} from "~/modules/shell/attention-row-format"

interface AlertClusterRowProps {
  cluster: AlertCluster
}

const AlertClusterRow: Component<AlertClusterRowProps> = (props) => {
  const i18n = useI18n()
  const rowLocale = () => rowLocaleFrom(i18n)
  const [expanded, setExpanded] = createSignal(false)

  // Oldest item in the cluster: "22h ago" on the summary answers the only
  // question a collapsed row has to answer — how long has this been rotting.
  const oldest = createMemo(() => {
    const times = props.cluster.items.map((i) => new Date(i.occurredAt).getTime())
    return new Date(Math.min(...times)).toISOString()
  })

  const KindIcon = (): ReturnType<Component> => {
    const k = getKindIcon(props.cluster.kind as never)
    const Icon = k.icon as Component<{ size?: number; class?: string }>
    return (
      <Icon
        size={14}
        class={
          k.tone === "warning"
            ? "text-warning"
            : "text-text-tertiary transition-colors duration-150 group-hover/row:text-text-secondary"
        }
      />
    )
  }

  return (
    <li data-testid={`alert-cluster-${props.cluster.key}`} data-kind={props.cluster.kind}>
      <button
        type="button"
        aria-expanded={expanded()}
        onClick={() => setExpanded((v) => !v)}
        class="group/row relative flex w-full items-start gap-x-3 py-3 pl-0 pr-4 text-left transition-colors hover:bg-surface-hover/50"
      >
        <span
          aria-hidden="true"
          class="pointer-events-none absolute left-0 top-2 bottom-2 w-[2px] rounded-r bg-accent opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
        />
        <span class="flex h-5 w-10 shrink-0 items-center justify-center">
          <KindIcon />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-[13px] font-medium leading-snug text-text">
            {alertClusterLabel(props.cluster.kind, props.cluster.items.length, rowLocale())}
          </span>
          <span class="mt-0.5 block text-[11px] leading-snug text-text-tertiary">
            {getAppLabel(props.cluster.app, props.cluster.kind, rowLocale())} ·{" "}
            {i18n.t("kernel.homeClusterOldest")}{" "}
            {formatRelativeTime(oldest(), { i18n: rowLocale() })}
          </span>
        </span>
        <span class="flex h-5 shrink-0 items-center gap-1.5 text-[11px] text-text-tertiary">
          {expanded() ? i18n.t("kernel.homeClusterHide") : i18n.t("kernel.homeClusterShow")}
          <ChevronDown
            size={13}
            class="transition-transform duration-150"
            classList={{ "rotate-180": expanded() }}
          />
        </span>
      </button>
      <Show when={expanded()}>
        <ul
          data-testid={`alert-cluster-items-${props.cluster.key}`}
          class="divide-y divide-border-subtle border-t border-border-subtle bg-surface-sunken/40 pl-6"
        >
          <For each={props.cluster.items}>{(item) => <AttentionRow item={item} />}</For>
        </ul>
      </Show>
    </li>
  )
}

export default AlertClusterRow
