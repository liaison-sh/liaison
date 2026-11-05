// SPDX-License-Identifier: FSL-1.1-ALv2

import { CalendarClock } from "lucide-solid"
import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { namespaceRegistryKey } from "~/framework/app-registry"
import { relativeTime } from "~/lib/relative-time"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import Chip from "./Chip"
import { cronPreview } from "./cron-preview"
import { routineStatusLabel, routineStoppedReason, runStatusLabel } from "./routine-status-copy"
import {
  describeSchedule,
  enableRoutineTemplate,
  loadRoutines,
  loadRoutineTemplates,
  type RoutineRow,
  routinesForAgent,
  routinesStore,
  updateRoutine,
} from "./routines-store"

function formatNextFire(date: Date, locale: string, imminent: string): string {
  if (date.getTime() <= Date.now()) return imminent
  return relativeTime(date, locale)
}

type RoutinesSubTab = "mine" | "shared"

/** Open the routine create surface as a tab (never a modal). */
function openCreateRoutine(label: string) {
  openTab({
    type: namespaceRegistryKey("agents", "routine"),
    entityId: "new",
    label,
  })
}

/**
 * P4c-T36: the same list, filtered to ONE agent, is the agent page's Routines
 * tab. `ownerAgentId` replaces the Mine/Shared split (ownership is the filter
 * now) and hides the app-template section, which is an org-level offer rather
 * than something this agent owns.
 */
interface Props {
  ownerAgentId?: string
  /** Render the `New routine` action. The page's authority decides. */
  canCreate?: boolean
  onSelect?: (routine: RoutineRow) => void
  onNew?: () => void
  /** The row the master/detail pane is showing, so the list marks it. */
  selectedId?: string | null
}

const RoutinesList: Component<Props> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [subTab, setSubTab] = createSignal<RoutinesSubTab>("mine")

  const scoped = () => props.ownerAgentId

  onMount(() => {
    const owner = scoped()
    if (owner) {
      void loadRoutines(api as any, { ownerAgentId: owner })
      return
    }
    // Load both buckets once on mount; sub-tabs filter client-side from the
    // union so toggling Mine/Shared never round-trips.
    void loadRoutines(api as any, { visibility: "all" })
    void loadRoutineTemplates(api as any)
  })

  const showNew = () => (scoped() ? props.canCreate === true : true)

  function onNew() {
    if (props.onNew) props.onNew()
    else openCreateRoutine(i18n.t("kernel.agentUi.newRoutineTab"))
  }

  async function onEnableTemplate(appName: string, templateKey: string) {
    try {
      await enableRoutineTemplate(api as any, appName, templateKey)
    } catch (err) {
      console.error("Enable routine template failed", err)
    }
  }

  function switchSubTab(tab: RoutinesSubTab) {
    if (subTab() === tab) return
    setSubTab(tab)
  }

  const currentUserId = createMemo(() => userFromToken()?.userId ?? null)

  // Completed one-shots sort below active routines.
  const rows = createMemo(() => {
    const owner = scoped()
    const me = currentUserId()
    const all = (owner ? routinesForAgent(owner) : routinesStore.routines).filter((r) => {
      if (owner) return true
      if (subTab() === "shared") return r.visibility === "shared"
      // "mine" — routines the user owns (covers both personal scope and any
      // org-shared routines they happen to own).
      return r.ownerUserId === me
    })
    all.sort((a, b) => {
      const aDone = a.status === "completed" ? 1 : 0
      const bDone = b.status === "completed" ? 1 : 0
      if (aDone !== bDone) return aDone - bDone
      return a.name.localeCompare(b.name)
    })
    return all
  })

  /** THE AGENT-SCOPED LIST IS GROUPED BY WHETHER THE ROUTINE RUNS, when both
   *  groups exist: a switched-off routine is not the same kind of thing as a
   *  live one, and reading them as one list is what hid that. A single group
   *  draws no header. */
  type ListItem = { header: string; id: string } | { routine: RoutineRow }
  const listItems = createMemo<ListItem[]>(() => {
    const all = rows()
    if (!scoped()) return all.map((routine) => ({ routine }))
    const groups = [
      {
        id: "on",
        label: i18n.t("kernel.agents.groupRoutinesOn"),
        routines: all.filter((r) => r.enabled),
      },
      {
        id: "off",
        label: i18n.t("kernel.agents.groupRoutinesOff"),
        routines: all.filter((r) => !r.enabled),
      },
    ].filter((g) => g.routines.length > 0)
    if (groups.length < 2) return all.map((routine) => ({ routine }))
    return groups.flatMap<ListItem>((g) => [
      { header: g.label, id: g.id },
      ...g.routines.map((routine) => ({ routine })),
    ])
  })

  async function toggleEnabled(r: RoutineRow) {
    try {
      await updateRoutine(api as any, r.id, { enabled: !r.enabled })
    } catch (err) {
      console.error("Toggle routine failed", err)
    }
  }

  function openDetail(r: RoutineRow) {
    if (props.onSelect) {
      props.onSelect(r)
      return
    }
    openTab({
      type: namespaceRegistryKey("agents", "routine"),
      entityId: r.id,
      label: r.name,
    })
  }

  return (
    <div data-testid="routines-list" class="flex h-full flex-col">
      <div class="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <h1 class="text-[15px] font-medium text-text">{i18n.t("kernel.agents.routinesTitle")}</h1>
        <Show when={showNew()}>
          <button
            type="button"
            data-testid="routines-new-routine"
            class="rounded-md border border-border-subtle bg-surface px-3 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover"
            onClick={onNew}
          >
            {scoped() ? i18n.t("kernel.agents.newRoutine") : i18n.t("kernel.agents.newRoutinePlus")}
          </button>
        </Show>
      </div>

      {/* Mine / Shared sub-tabs: ownership is the filter on an agent's list. */}
      <Show when={!scoped()}>
        <div class="flex items-center gap-1 border-b border-border-subtle px-4 py-1">
          <For
            each={[
              { id: "mine" as const, label: i18n.t("kernel.agents.filterMine") },
              { id: "shared" as const, label: i18n.t("kernel.agents.filterShared") },
            ]}
          >
            {(item) => (
              <button
                type="button"
                data-testid={`routines-subtab-${item.id}`}
                onClick={() => switchSubTab(item.id)}
                class={`px-3 py-1.5 text-[12px] outline-none transition-colors ${
                  subTab() === item.id
                    ? "border-b-2 border-accent text-text"
                    : "border-b-2 border-transparent text-text-tertiary hover:text-text-secondary"
                }`}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="min-h-0 flex-1 overflow-auto">
        <Show
          when={rows().length > 0}
          fallback={
            <div
              data-testid="routines-empty-state"
              class="flex flex-col items-center gap-2 px-6 py-12 text-center text-text-tertiary"
            >
              <CalendarClock size={20} class="text-text-tertiary" />
              <p class="text-[13px]">
                <Show
                  when={scoped()}
                  fallback={
                    subTab() === "shared"
                      ? i18n.t("kernel.agents.routinesSharedEmpty")
                      : i18n.t("kernel.agents.routinesFlatEmpty")
                  }
                >
                  {i18n.t("kernel.agents.routinesEmpty")}
                </Show>
              </p>
              <Show when={scoped() ? showNew() : subTab() === "mine"}>
                <button
                  type="button"
                  data-testid="routines-empty-cta"
                  class="text-[12px] text-accent underline"
                  onClick={onNew}
                >
                  {scoped()
                    ? i18n.t("kernel.agents.newRoutine")
                    : i18n.t("kernel.agents.createFirstRoutine")}
                </button>
              </Show>
            </div>
          }
        >
          <For each={listItems()}>
            {(item) => {
              if ("header" in item) {
                return (
                  <div
                    data-testid={`routines-group-${item.id}`}
                    class="border-b border-border-subtle bg-surface px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-text-tertiary"
                  >
                    {item.header}
                  </div>
                )
              }
              const r = item.routine
              // A SWITCHED-OFF ROUTINE HAS NO NEXT RUN. The cron string still
              // parses when `enabled` is false, so the projection kept
              // advertising "Next run in 9h" for a routine the scheduler will
              // never fire.
              const next =
                r.enabled && r.kind === "recurring" && r.cron
                  ? cronPreview(r.cron, r.timezone ?? "UTC", 1)[0]
                  : undefined
              const paused = r.status !== "active" && r.status !== "completed"
              const done = r.status === "completed"
              return (
                <div
                  data-testid={`routine-row-${r.name}`}
                  data-status={r.status}
                  class={`flex items-center gap-3 border-b border-border-subtle px-4 py-3 transition-colors ${
                    paused || done ? "opacity-60" : ""
                  }`}
                  classList={{ "bg-surface-active": props.selectedId === r.id }}
                >
                  <button
                    type="button"
                    data-testid={`routine-open-${r.name}`}
                    onClick={() => openDetail(r)}
                    class="min-w-0 flex-1 text-left"
                  >
                    {/* THE TITLE OWNS ITS OWN LINE. Sharing one flex row with
                        the schedule chip let a long cron sentence ("Every
                        weekday at 8 AM - Europe/Paris") wrap to three lines
                        inside the pill and ride up over the name. Title
                        truncates on one line; the chips sit on a second row and
                        wrap between themselves, never into the title. */}
                    <div
                      data-testid={`routine-title-${r.name}`}
                      class="truncate text-[13px] font-medium text-text"
                    >
                      {r.name}
                    </div>
                    <div
                      data-testid={`routine-chips-${r.name}`}
                      class="mt-1 flex flex-wrap items-center gap-2"
                    >
                      <Chip
                        data-testid={`routine-schedule-${r.name}`}
                        class="block max-w-full truncate"
                      >
                        {describeSchedule(r, { i18n: { t: i18n.t, locale: i18n.locale() } })}
                      </Chip>
                      <Show when={r.visibility === "shared"}>
                        <Chip data-testid={`routine-shared-${r.name}`}>
                          {i18n.t("kernel.agents.sharedChip")}
                        </Chip>
                      </Show>
                      <Show when={done}>
                        <Chip tone="done" data-testid={`routine-done-${r.name}`}>
                          {i18n.t("kernel.agents.doneChip")}
                        </Chip>
                      </Show>
                      <Show when={paused}>
                        <Chip tone="warn" data-testid={`routine-paused-${r.name}`}>
                          {routineStatusLabel(i18n.t, r.status)}
                        </Chip>
                      </Show>
                      <Show when={!done && r.lastRunStatus}>
                        <Chip data-testid={`routine-last-status-${r.name}`}>
                          {runStatusLabel(i18n.t, r.lastRunStatus as string)}
                        </Chip>
                      </Show>
                    </div>
                    {/* A paused routine explains itself HERE, in the row, with
                        the worker's own sentence naming what is missing: the
                        chip above only says that it stopped. */}
                    <Show
                      when={paused}
                      fallback={
                        <p class="mt-0.5 text-[12px] text-text-tertiary">
                          <Show
                            when={done}
                            fallback={
                              <Show when={next} fallback={<>{r.description}</>}>
                                {i18n.t("kernel.agents.nextRun", {
                                  when: formatNextFire(
                                    next!,
                                    i18n.locale(),
                                    i18n.t("kernel.agentUi.nextFireImminent"),
                                  ),
                                })}
                              </Show>
                            }
                          >
                            {i18n.t("kernel.agents.completed")}
                          </Show>
                        </p>
                      }
                    >
                      <p
                        data-testid={`routine-paused-reason-${r.name}`}
                        class="mt-0.5 text-[12px] text-amber-500"
                      >
                        {routineStoppedReason(i18n.t, r.status, r.lastRunError)}
                      </p>
                    </Show>
                  </button>
                  {/* The On/Off toggle is a WRITE. On an agent's list the
                      server already answered who may make it, per row. */}
                  <Show when={!done && (scoped() ? r.canWrite === true : true)}>
                    <button
                      type="button"
                      data-testid={`routine-enable-toggle-${r.name}`}
                      // On or Off, read by assistive tech and by a guided
                      // tour's "switch it on" (it never flips one already on).
                      aria-pressed={r.enabled ? "true" : "false"}
                      onClick={() => void toggleEnabled(r)}
                      class="rounded border border-border-subtle px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-surface-hover"
                    >
                      {r.enabled ? i18n.t("kernel.agents.on") : i18n.t("kernel.agents.off")}
                    </button>
                  </Show>
                </div>
              )
            }}
          </For>
        </Show>

        {/* App-provided routine templates (Component A §3.5). An org-level
            offer, not something this agent owns, so the agent tab has none. */}
        <Show when={!scoped() && routinesStore.templates.length > 0}>
          <div data-testid="routine-templates-section">
            <div class="border-y border-border-subtle bg-surface px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
              {i18n.t("kernel.agents.appTemplates")}
            </div>
            <For each={routinesStore.templates}>
              {(t) => (
                <div
                  data-testid={`routine-template-${t.appName}-${t.templateKey}`}
                  class="flex items-center gap-3 border-b border-border-subtle px-4 py-3"
                >
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="text-[13px] font-medium text-text">{t.templateKey}</span>
                      {/* A kernel template is the platform's own, not an app's (S28). */}
                      <Chip>
                        {t.appName === "kernel"
                          ? i18n.t("kernel.agents.builtInTemplate")
                          : t.appName}
                      </Chip>
                      <Chip>{t.kind}</Chip>
                    </div>
                    <p class="mt-0.5 truncate text-[12px] text-text-tertiary">{t.description}</p>
                  </div>
                  <button
                    type="button"
                    data-testid={`routine-template-enable-${t.appName}-${t.templateKey}`}
                    disabled={t.enabled}
                    onClick={() => void onEnableTemplate(t.appName, t.templateKey)}
                    class={`shrink-0 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                      t.enabled
                        ? "cursor-default border-border-subtle bg-surface text-text-tertiary"
                        : "border-accent bg-accent-glow text-accent hover:opacity-80"
                    }`}
                  >
                    {t.enabled ? i18n.t("kernel.agents.enabled") : i18n.t("kernel.agents.enable")}
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

export default RoutinesList
