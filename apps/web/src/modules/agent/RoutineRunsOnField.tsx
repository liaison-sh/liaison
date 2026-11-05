// SPDX-License-Identifier: FSL-1.1-ALv2
import { For, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  hasEnabledNode,
  loadNodes,
  modelsFor,
  sharedFolderNames,
} from "~/modules/nodes/nodes-store"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import type { RoutineNodePlacement, RoutineRunsOn } from "./routines-store"

export const ROUTINE_RUNS_ON_OPTIONS: RoutineRunsOn[] = ["cloud", "node", "node_else_cloud"]

export const EMPTY_PLACEMENT: RoutineNodePlacement = { folder: null, repo: null, model: null }

/** The i18n key of one place a routine runs. */
export function runsOnLabelKey(runsOn: RoutineRunsOn | null | undefined): string {
  if (runsOn === "node") return "kernel.agentForms.runsOnNode"
  if (runsOn === "node_else_cloud") return "kernel.agentForms.runsOnNodeElseCloud"
  return "kernel.agentForms.runsOnCloud"
}

/** Whether a routine runs on a node (and so has a folder, repo and model to set). */
export function runsOnNode(runsOn: RoutineRunsOn | null | undefined): boolean {
  return runsOn === "node" || runsOn === "node_else_cloud"
}

interface RoutineRunsOnFieldProps {
  value: RoutineRunsOn
  onChange: (v: RoutineRunsOn) => void
  /** The select's test id ("routine-runs-on" or "routine-edit-runs-on"). */
  testId: string
  /** Where a node run works and on which model (L26). Omitted: no placement fields. */
  placement?: RoutineNodePlacement
  onPlacementChange?: (placement: RoutineNodePlacement) => void
  /** The viewer is not the routine's owner: its folders and models are on the owner's
   *  computer, so the pickers give way to a line saying so (m7). */
  placementOwnerOnly?: boolean
}

/**
 * Where each run of a routine happens (S21): the cloud, the owner's own
 * computer (My node), or the node when it is online and the cloud otherwise.
 * Shown only to someone with an enabled node (live, L27), or for a routine
 * that already runs on one (so it can move back to the cloud). On a node, the
 * folder (one the node shares) or a repository URL, exclusive, and the model.
 * Shared by the create form and the detail page's edit form.
 */
export default function RoutineRunsOnField(props: RoutineRunsOnFieldProps) {
  const i18n = useI18n()
  const api = useOptionalApi()
  onMount(() => {
    if (api) void loadNodes(api)
  })

  const visible = () => hasEnabledNode() || props.value !== "cloud"
  const placement = () => props.placement ?? EMPTY_PLACEMENT
  const showPlacement = () =>
    runsOnNode(props.value) && props.onPlacementChange !== undefined && !props.placementOwnerOnly
  const set = (next: Partial<RoutineNodePlacement>) =>
    props.onPlacementChange?.({ ...placement(), ...next })

  /** The shared folders, plus the routine's own when no node shares it right now. */
  const folders = () => {
    const names = sharedFolderNames()
    const current = placement().folder
    return current && !names.includes(current) ? [...names, current] : names
  }
  const models = () => {
    const list = modelsFor()
    const current = placement().model
    return current && !list.some((m) => m.id === current)
      ? [...list, { id: current, label: current }]
      : list
  }

  const select =
    "rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
  const label = "flex flex-col gap-1.5 text-[12px] text-text-tertiary"

  return (
    <Show when={visible()}>
      <div class="flex flex-col gap-3">
        <label class={label}>
          {i18n.t("kernel.agentForms.runsOn")}
          <select
            data-testid={props.testId}
            class={select}
            value={props.value}
            onChange={(e) => props.onChange(e.currentTarget.value as RoutineRunsOn)}
          >
            <For each={ROUTINE_RUNS_ON_OPTIONS}>
              {(opt) => <option value={opt}>{i18n.t(runsOnLabelKey(opt))}</option>}
            </For>
          </select>
          <span class="text-[11px]">{i18n.t("kernel.agentForms.runsOnHint")}</span>
        </label>
        <Show when={runsOnNode(props.value) && props.placementOwnerOnly}>
          <p data-testid={`${props.testId}-owner-only`} class="text-[12px] text-text-tertiary">
            {i18n.t("kernel.agentForms.nodePlacementOwnerOnly")}
          </p>
        </Show>
        <Show when={showPlacement()}>
          <div data-testid={`${props.testId}-placement`} class="grid gap-3 sm:grid-cols-3">
            <label class={label}>
              {i18n.t("kernel.agentForms.nodeFolder")}
              <select
                data-testid={`${props.testId}-folder`}
                class={select}
                value={placement().folder ?? ""}
                onChange={(e) => {
                  const folder = e.currentTarget.value || null
                  // A folder or a repository: choosing one clears the other.
                  set(folder ? { folder, repo: null } : { folder: null })
                }}
              >
                <option value="">{i18n.t("kernel.agentForms.nodeFolderNone")}</option>
                <For each={folders()}>{(name) => <option value={name}>{name}</option>}</For>
              </select>
            </label>
            <label class={label}>
              {i18n.t("kernel.agentForms.nodeRepo")}
              <input
                type="url"
                data-testid={`${props.testId}-repo`}
                class={select}
                value={placement().repo ?? ""}
                onInput={(e) => {
                  const repo = e.currentTarget.value.trim() || null
                  set(repo ? { repo, folder: null } : { repo: null })
                }}
              />
            </label>
            <label class={label}>
              {i18n.t("kernel.agentForms.nodeModel")}
              <select
                data-testid={`${props.testId}-model`}
                class={select}
                value={placement().model ?? ""}
                onChange={(e) => set({ model: e.currentTarget.value || null })}
              >
                <option value="">{i18n.t("kernel.agentForms.nodeModelDefault")}</option>
                <For each={models()}>{(m) => <option value={m.id}>{m.label}</option>}</For>
              </select>
            </label>
          </div>
        </Show>
      </div>
    </Show>
  )
}
