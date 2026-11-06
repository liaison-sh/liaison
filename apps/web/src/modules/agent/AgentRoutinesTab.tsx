// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * P4c-T36: the agent page's Routines tab.
 *
 * IT IS THE EXISTING VIEWS, FILTERED. `RoutinesList`, `RoutineDetail`,
 * `RoutineCreate` and `SchedulePicker` are the same components the flat
 * `/agent/routines` screen mounts; `ownerAgentId` replaces the Mine/Shared
 * split with ownership, and the store caches the answer per agent id so the
 * two screens, both mounted at once in the shell, never clobber each other.
 *
 * WRITE AUTHORITY IS NOT RECOMPUTED HERE: `canWrite` rides on every listed row
 * (T32b), and `New routine` renders on the page's own `canAdminister`.
 *
 * MASTER AND DETAIL, LIKE MEMORY. The list is the left pane, the selected
 * routine's editor the right one, and on desktop the first row is selected as
 * soon as the list lands. The PHONE keeps push navigation: the list is the
 * screen, a row pushes the detail over it and a Back control returns.
 *
 * Run now stays `POST /api/agent/routines/:id/run-now`, and the destination is
 * the routine's output thread, exactly as on the flat screen.
 *
 * A RUN OPENS HERE. A row of the routine's run history swaps the detail pane
 * for that run's transcript (`RoutineRunTranscript`), and the page's URL says
 * `?selected=<routine>&run=<run>` so the run has a direct link. The output
 * thread is a run log, never a chat row: this is where it is read.
 */
import { ChevronLeft } from "lucide-solid"
import { type Component, createEffect, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { trackOpenRecord } from "~/modules/shell/open-record"
import { shellTier } from "~/modules/shell/shell-tier"
import RoutineDetail from "./RoutineDetail"
import RoutineRunTranscript from "./RoutineRunTranscript"
import RoutinesList from "./RoutinesList"
import { findRoutineRow, routinesForAgent } from "./routines-store"

interface Props {
  agentId: string
  /** The page's `canAdminister`: may this viewer author for this agent? */
  canCreate?: boolean
  /** A deep link's `?selected=<routine id>`, from the page's own route. */
  selected?: string
  /** The viewer picked another row, so the page drops the param. */
  onSelectedCleared?: () => void
  /** A deep link's `&run=<run id>`, under the routine `selected` names. */
  run?: string
  /** The run pane opened or closed, so the page's URL can say so. */
  onRunChanged?: (routineId: string, runId: string | null) => void
}

const AgentRoutinesTab: Component<Props> = (props) => {
  const i18n = useI18n()
  // `new` is the create sentinel `RoutineDetail` already understands.
  const [selected, setSelected] = createSignal<string | null>(null)
  trackOpenRecord("kernel", "routine", selected)
  /** The run whose transcript replaces the routine's detail, if any. */
  const [run, setRun] = createSignal<string | null>(null)

  function openRun(routineId: string, runId: string | null) {
    setRun(runId)
    props.onRunChanged?.(routineId, runId)
  }

  // The deep link's row, consumed ONCE: after that the viewer's own clicks own
  // the selection, and the page drops the param.
  let consumedSelection: string | null = null
  createEffect(() => {
    const id = props.selected
    if (!id || id === consumedSelection) return
    consumedSelection = id
    setSelected(id)
    setRun(props.run ?? null)
  })

  const isPhone = () => shellTier() === "phone"

  // The default selection, once: the list arrives after mount, so the first row
  // cannot be picked at init, and picking it on every list change would fight
  // the viewer's own clicks.
  let defaulted = false
  createEffect(() => {
    if (defaulted || isPhone()) return
    if (selected() || props.selected) return
    const first = routinesForAgent(props.agentId)[0]
    if (!first) return
    defaulted = true
    setSelected(first.id)
  })

  /** Phone shows ONE pane: the list, or the routine a row pushed over it. */
  const showDetailPane = () => !isPhone() || selected() !== null
  const showListPane = () => !isPhone() || selected() === null

  return (
    <div data-testid="agent-routines-tab" class="flex h-full min-h-0">
      <div
        class="flex min-h-0 flex-col border-border-subtle"
        classList={{
          hidden: !showListPane(),
          "w-full": isPhone(),
          "w-[300px] shrink-0 border-r": !isPhone(),
        }}
      >
        <RoutinesList
          ownerAgentId={props.agentId}
          canCreate={props.canCreate}
          selectedId={selected()}
          onSelect={(routine) => {
            props.onSelectedCleared?.()
            setRun(null)
            setSelected(routine.id)
          }}
          onNew={() => {
            props.onSelectedCleared?.()
            setRun(null)
            setSelected("new")
          }}
        />
      </div>

      <div
        data-testid="agent-routines-detail"
        class="min-h-0 min-w-0 flex-1 overflow-auto"
        classList={{ hidden: !showDetailPane() }}
      >
        <Show when={isPhone() && showDetailPane()}>
          <button
            type="button"
            data-testid="agent-routines-back"
            onClick={() => setSelected(null)}
            class="flex min-h-11 items-center gap-1 px-4 text-[13px] text-text-secondary"
          >
            <ChevronLeft size={14} />
            {i18n.t("kernel.agents.backToList")}
          </button>
        </Show>

        {/* `keyed`: RoutineDetail decides between the create surface and a
            routine ONCE, at mount, so a selection that moves from a row to the
            `new` sentinel (or back) must remount it, not update its props. */}
        <Show
          when={selected()}
          keyed
          fallback={
            <Show when={!isPhone()}>
              <p
                data-testid="agent-routines-no-selection"
                class="px-6 py-6 text-[13px] text-text-tertiary"
              >
                {i18n.t("kernel.agents.selectRoutine")}
              </p>
            </Show>
          }
        >
          {(id) => (
            <Show
              when={id !== "new" && run()}
              keyed
              fallback={
                <RoutineDetail
                  entityId={id}
                  ownerAgentId={props.agentId}
                  onCreated={(routine) => setSelected(routine.id)}
                  onCancelCreate={() => setSelected(null)}
                  onOpenRun={(runId) => openRun(id, runId)}
                />
              }
            >
              {(runId) => (
                <RoutineRunTranscript
                  routineId={id}
                  routineName={findRoutineRow(id)?.name ?? ""}
                  routineKind={findRoutineRow(id)?.kind ?? null}
                  runId={runId}
                  onBack={() => openRun(id, null)}
                />
              )}
            </Show>
          )}
        </Show>
      </div>
    </div>
  )
}

export default AgentRoutinesTab
