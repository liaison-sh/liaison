// SPDX-License-Identifier: FSL-1.1-ALv2
// Board toolbar "Release" chip (spec S22): a single-select menu of release
// values plus "No release". Values come from the org-wide /releases list and
// from the loaded board; the count beside each value is computed from the
// board with the same effective-release match the board filter uses, so the
// count equals the rows that value alone shows (projects charter parity rule).
import { Check, X } from "lucide-solid"
import { type Component, createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { projectsFilterStore } from "~/modules/projects/projects-filter-store"
import {
  fetchReleases,
  matchesRelease,
  RELEASE_NONE,
  type ReleaseCount,
  type ReleaseNode,
} from "~/modules/projects/release-filter"
import { PopupMenu } from "~/ui/PopupMenu"

/**
 * Menu options: every known value (org-wide suggestions and the board's own
 * releases, deduplicated case-insensitively, sorted) with its board count,
 * then RELEASE_NONE.
 */
export function releaseOptions(
  tasks: readonly ReleaseNode[],
  known: readonly ReleaseCount[],
): ReleaseCount[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const values = new Map<string, string>()
  for (const raw of [...tasks.map((t) => t.release), ...known.map((k) => k.value)]) {
    const v = raw?.trim()
    if (v && !values.has(v.toLowerCase())) values.set(v.toLowerCase(), v)
  }
  const count = (value: string) => tasks.filter((t) => matchesRelease(t, byId, value)).length
  const sorted = [...values.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  )
  return [
    ...sorted.map((value) => ({ value, count: count(value) })),
    { value: RELEASE_NONE, count: count(RELEASE_NONE) },
  ]
}

interface ReleaseFilterChipProps {
  api: ApiClient
  tasks: readonly ReleaseNode[]
  /** Controlled open state, for a parent that opens the picker from
   *  elsewhere (the project menu's "Filter by release" at phone width). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Phone row: the active chip shows the release value alone, truncated. */
  compact?: boolean
}

export const ReleaseFilterChip: Component<ReleaseFilterChipProps> = (props) => {
  const i18n = useI18n()
  const [localOpen, setLocalOpen] = createSignal(false)
  const open = () => props.open ?? localOpen()
  const setOpen = (next: boolean) => {
    setLocalOpen(next)
    props.onOpenChange?.(next)
  }
  const [known, setKnown] = createSignal<ReleaseCount[]>([])
  const options = createMemo(() => releaseOptions(props.tasks, known()))
  const selected = () => projectsFilterStore.release ?? null
  const label = (value: string) =>
    value === RELEASE_NONE ? i18n.t("projects.release.filter.none") : value
  const isSelected = (value: string) => {
    const cur = selected()
    return cur !== null && cur.toLowerCase() === value.toLowerCase()
  }

  const onOpenChange = (next: boolean) => {
    setOpen(next)
  }
  // Fetch the org's releases whenever the picker opens, however it was
  // opened (its own trigger, or a parent through `open`).
  createEffect(
    on(open, (isOpen) => {
      if (!isOpen) return
      fetchReleases(props.api).then(setKnown, () => {
        /* the board's own values still fill the menu */
      })
    }),
  )

  return (
    <span class="inline-flex items-center">
      <PopupMenu open={open()} onOpenChange={onOpenChange}>
        <PopupMenu.Trigger
          data-testid="project-workspace.release-filter"
          aria-label={i18n.t("projects.release.filter.menuLabel")}
          class={cn(
            "flex h-7 items-center rounded-sm border px-2 text-[12px]",
            props.compact && "max-w-[96px] truncate",
            selected() !== null
              ? "border-accent-border bg-accent-glow text-accent"
              : "border-transparent text-text-tertiary hover:bg-surface-hover hover:text-text-secondary",
          )}
        >
          {/* Plain expression, not a Show callback: the callback's string is
              computed once and would keep the first value across switches. */}
          {selected() !== null
            ? props.compact
              ? label(selected()!)
              : i18n.t("projects.release.filter.active", { release: label(selected()!) })
            : i18n.t("projects.release.label")}
        </PopupMenu.Trigger>
        <PopupMenu.Content
          aria-label={i18n.t("projects.release.filter.menuLabel")}
          class="max-h-80 min-w-44 overflow-auto"
        >
          <For each={options()}>
            {(o) => (
              <PopupMenu.Item
                data-testid="release-filter.option"
                textValue={label(o.value)}
                onSelect={() => projectsFilterStore.setRelease(o.value)}
              >
                <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  <Show when={isSelected(o.value)}>
                    <Check class="h-3.5 w-3.5" />
                  </Show>
                </span>
                <span class={cn("flex-1 truncate", o.value !== RELEASE_NONE && "font-mono")}>
                  {label(o.value)}
                </span>
                <span class="tabular-nums text-text-tertiary">{o.count}</span>
              </PopupMenu.Item>
            )}
          </For>
        </PopupMenu.Content>
      </PopupMenu>
      <Show when={selected() !== null}>
        <button
          type="button"
          data-testid="project-workspace.release-filter-clear"
          aria-label={i18n.t("projects.release.filter.clear")}
          onClick={() => projectsFilterStore.setRelease(null)}
          class="flex h-7 w-6 items-center justify-center rounded-sm text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
        >
          <X class="h-3 w-3" />
        </button>
      </Show>
    </span>
  )
}
