// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ReasoningLevel } from "@liaison/shared"
import { CalendarPlus } from "lucide-solid"
import { type Component, createSignal, Show } from "solid-js"
import { namespaceRegistryKey } from "~/framework/app-registry"
import { ensureAvailableModels } from "~/modules/agent/credits/credits-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { closeTab, makeTabId, openTab } from "~/modules/shell/tab-store"
import ModelOptions from "./ModelOptions"
import ReasoningLevelRow from "./ReasoningLevelRow"
import RoutineApproverField from "./RoutineApproverField"
import RoutineRunsOnField, { EMPTY_PLACEMENT, runsOnNode } from "./RoutineRunsOnField"
import RoutineScopesField from "./RoutineScopesField"
import RoutineSenderFilterField, { SENDER_FILTER_EVENT } from "./RoutineSenderFilterField"
import RoutineTokenFields, { parseTokenField } from "./RoutineTokenFields"
import {
  type CreateRoutineInput,
  createRoutine,
  kebabCase,
  localTimezone,
  type RoutineApprover,
  type RoutineEventFilter,
  type RoutineKind,
  type RoutineNodePlacement,
  type RoutineRunsOn,
  type RoutineVisibility,
} from "./routines-store"
import SchedulePicker, { type ScheduleValue } from "./SchedulePicker"

/**
 * Routine creation as a full tab surface — not a modal. Liaison is agent-native:
 * the agent chat must stay reachable while the user fills this form, so anything
 * requiring thought is a surface, never a popup.
 */
interface Props {
  /** P4c-T36: create the routine FOR this agent. A15 decides on the server. */
  ownerAgentId?: string
  /** Called with the created routine instead of opening its own tab, so the
   *  agent page's Routines tab settles onto it in place. */
  onCreated?: (routine: { id: string; name: string }) => void
  /** Called instead of closing the create TAB, which the agent page has not
   *  opened: its create form lives inside the Routines tab. */
  onCancel?: () => void
}

const RoutineCreate: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  void ensureAvailableModels(api)
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [kind, setKind] = createSignal<RoutineKind>("recurring")
  const [visibility, setVisibility] = createSignal<RoutineVisibility>("personal")
  const [agentModelId, setAgentModelId] = createSignal<string | null>(null)
  const [agentReasoningLevel, setAgentReasoningLevel] = createSignal<ReasoningLevel>("off")
  const [tokenBudget, setTokenBudget] = createSignal("")
  const [hardTokenLimit, setHardTokenLimit] = createSignal("")
  const [runsOn, setRunsOn] = createSignal<RoutineRunsOn>("cloud")
  const [placement, setPlacement] = createSignal<RoutineNodePlacement>(EMPTY_PLACEMENT)
  const [eventFilter, setEventFilter] = createSignal<RoutineEventFilter | null>(null)
  const [approver, setApprover] = createSignal<RoutineApprover>("default")
  const [scopes, setScopes] = createSignal<string[]>([])
  const [schedule, setSchedule] = createSignal<ScheduleValue>({
    kind: "recurring",
    cron: "0 9 * * 1-5",
    timezone: localTimezone(),
  })
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | null>(null)

  const createTabId = () => makeTabId(namespaceRegistryKey("agents", "routine"), "new")

  function cancel() {
    if (props.onCancel) props.onCancel()
    else closeTab(createTabId())
  }

  async function handleSave() {
    setSaveError(null)
    const normalizedName = kebabCase(name())
    if (!normalizedName) {
      setSaveError(i18n.t("kernel.agentForms.nameInvalid"))
      return
    }
    if (!prompt().trim()) {
      setSaveError(i18n.t("kernel.agentForms.promptRequired"))
      return
    }
    const sched = schedule()
    if (sched.kind === "scheduled" && !sched.runAt) {
      setSaveError(i18n.t("kernel.agentForms.oneShotDateRequired"))
      return
    }
    if (sched.kind === "event" && !sched.event) {
      setSaveError(i18n.t("kernel.agentForms.eventRequired"))
      return
    }
    const budget = parseTokenField(tokenBudget())
    const limit = parseTokenField(hardTokenLimit())
    if (budget === "invalid" || limit === "invalid") {
      setSaveError(i18n.t("kernel.agentForms.tokenNumberInvalid"))
      return
    }
    setSaving(true)
    try {
      const input: CreateRoutineInput = {
        name: normalizedName,
        description: description() || normalizedName,
        kind: kind(),
        prompt: prompt(),
        // D20: exactly the scopes picked; nothing is added from the prompt.
        scopes: scopes(),
        visibility: visibility(),
        agentModelId: agentModelId(),
        agentReasoningLevel: agentModelId() ? agentReasoningLevel() : null,
        // Sent only when set: an absent field is no budget / no limit.
        ...(budget !== null ? { tokenBudget: budget } : {}),
        ...(limit !== null ? { hardTokenLimit: limit } : {}),
        // The cloud is the default: sent only when the routine runs elsewhere.
        ...(runsOn() !== "cloud" ? { runsOn: runsOn() } : {}),
        // The default audience is the default: sent only when the owner approves.
        ...(approver() !== "default" ? { approver: approver() } : {}),
        // One branch per kind, and each carries ONLY its own columns: the DB
        // check constraint refuses a row holding a cron AND an event.
        ...(sched.kind === "recurring"
          ? { cron: sched.cron, timezone: sched.timezone }
          : sched.kind === "scheduled"
            ? { runAt: sched.runAt }
            : {
                event: sched.event,
                // Only a new-mail routine takes a sender filter (S26).
                ...(sched.event === SENDER_FILTER_EVENT && eventFilter()
                  ? { eventFilter: eventFilter() }
                  : {}),
              }),
        ...(props.ownerAgentId ? { ownerAgentId: props.ownerAgentId } : {}),
        // L26, m7: where a node run works and on which model, in the same request, so a
        // refused placement creates nothing and a retry makes no second routine.
        ...(runsOnNode(runsOn()) && (placement().folder || placement().repo || placement().model)
          ? { nodePlacement: placement() }
          : {}),
      }
      const created = await createRoutine(api as any, input)
      if (props.onCreated) {
        props.onCreated(created)
        return
      }
      // Settle onto the created routine's own tab (permanent, not a preview),
      // then close the create tab.
      openTab({
        type: namespaceRegistryKey("agents", "routine"),
        entityId: created.id,
        label: created.name,
        preview: false,
      })
      closeTab(createTabId())
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : i18n.t("kernel.agents.saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-testid="routine-create" class="flex h-full flex-col">
      <div class="flex items-center gap-2 border-b border-border-subtle px-6 py-4">
        <CalendarPlus size={16} class="text-text-secondary" />
        <h1 class="text-[15px] font-medium text-text">{i18n.t("kernel.agents.newRoutine")}</h1>
      </div>

      <div
        data-testid="routine-form"
        class="min-h-0 flex-1 overflow-auto px-6 pt-4 pb-dock-runway [--dock-pad-base:1rem]"
      >
        <div class="flex max-w-[560px] flex-col gap-4">
          {/* Kind segmented control */}
          <div class="flex flex-col gap-1.5">
            <span class="text-[12px] text-text-tertiary">{i18n.t("kernel.agentForms.type")}</span>
            <div class="flex gap-1.5">
              <button
                type="button"
                data-testid="routine-kind-recurring"
                data-selected={kind() === "recurring" ? "true" : "false"}
                onClick={() => {
                  setKind("recurring")
                  setSchedule({
                    kind: "recurring",
                    cron: "0 9 * * 1-5",
                    timezone: localTimezone(),
                  })
                }}
                class={`flex-1 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                  kind() === "recurring"
                    ? "border-accent bg-accent/10 text-text"
                    : "border-border-subtle bg-surface text-text-tertiary hover:bg-surface-hover"
                }`}
              >
                {i18n.t("kernel.agentForms.recurring")}
              </button>
              <button
                type="button"
                data-testid="routine-kind-scheduled"
                data-selected={kind() === "scheduled" ? "true" : "false"}
                onClick={() => {
                  setKind("scheduled")
                  setSchedule({ kind: "scheduled", runAt: "" })
                }}
                class={`flex-1 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                  kind() === "scheduled"
                    ? "border-accent bg-accent/10 text-text"
                    : "border-border-subtle bg-surface text-text-tertiary hover:bg-surface-hover"
                }`}
              >
                {i18n.t("kernel.agentForms.oneShot")}
              </button>
              <button
                type="button"
                data-testid="routine-kind-event"
                data-selected={kind() === "event" ? "true" : "false"}
                onClick={() => {
                  setKind("event")
                  setSchedule({ kind: "event", event: "" })
                }}
                class={`flex-1 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                  kind() === "event"
                    ? "border-accent bg-accent/10 text-text"
                    : "border-border-subtle bg-surface text-text-tertiary hover:bg-surface-hover"
                }`}
              >
                {i18n.t("kernel.agentForms.onEvent")}
              </button>
            </div>
          </div>

          <label class="flex flex-col gap-1.5 text-[12px] text-text-tertiary">
            {i18n.t("kernel.agents.fieldName")}
            <input
              data-testid="routines-new-name"
              type="text"
              placeholder={i18n.t("kernel.agentUi.routineNamePlaceholder")}
              class="rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </label>

          <label class="flex flex-col gap-1.5 text-[12px] text-text-tertiary">
            {i18n.t("kernel.agents.fieldDescription")}
            <input
              data-testid="routines-new-description"
              type="text"
              placeholder={i18n.t("kernel.agentForms.routineDescriptionPlaceholder")}
              class="rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
            />
          </label>

          <div class="flex flex-col gap-1.5">
            <span class="text-[12px] text-text-tertiary">
              {kind() === "event"
                ? i18n.t("kernel.agentForms.trigger")
                : i18n.t("kernel.agentForms.schedule")}
            </span>
            <SchedulePicker kind={kind()} onChange={setSchedule} />
          </div>

          <Show
            when={(() => {
              const sched = schedule()
              return sched.kind === "event" && sched.event === SENDER_FILTER_EVENT
            })()}
          >
            <RoutineSenderFilterField
              value={eventFilter()}
              onChange={setEventFilter}
              testIdPrefix="routine"
            />
          </Show>

          <label class="flex flex-col gap-1.5 text-[12px] text-text-tertiary">
            {i18n.t("kernel.agentForms.prompt")}
            <textarea
              data-testid="routines-new-prompt"
              rows={5}
              placeholder={i18n.t("kernel.agentForms.routinePromptPlaceholder")}
              class="rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
            />
          </label>

          <div class="flex flex-col gap-1.5">
            <span class="text-[12px] text-text-tertiary">
              {i18n.t("kernel.agentForms.visibility")}
            </span>
            <div class="flex gap-1.5">
              <button
                type="button"
                data-testid="routine-visibility-personal"
                data-selected={visibility() === "personal" ? "true" : "false"}
                onClick={() => setVisibility("personal")}
                class={`flex-1 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                  visibility() === "personal"
                    ? "border-accent bg-accent/10 text-text"
                    : "border-border-subtle bg-surface text-text-tertiary hover:bg-surface-hover"
                }`}
              >
                {i18n.t("kernel.agentForms.personal")}
              </button>
              <button
                type="button"
                data-testid="routine-visibility-shared"
                data-selected={visibility() === "shared" ? "true" : "false"}
                onClick={() => setVisibility("shared")}
                class={`flex-1 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                  visibility() === "shared"
                    ? "border-accent bg-accent/10 text-text"
                    : "border-border-subtle bg-surface text-text-tertiary hover:bg-surface-hover"
                }`}
              >
                {i18n.t("kernel.agentForms.shared")}
              </button>
            </div>
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-[12px] text-text-tertiary">
              {i18n.t("kernel.agentForms.agentModel")}
            </span>
            <select
              data-testid="routine-model-select"
              class="rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
              value={agentModelId() ?? ""}
              onChange={(e) => setAgentModelId(e.currentTarget.value || null)}
            >
              <ModelOptions current={agentModelId()} />
            </select>
            <Show when={agentModelId()}>
              <ReasoningLevelRow
                modelId={agentModelId()}
                level={agentReasoningLevel()}
                onSelect={setAgentReasoningLevel}
              />
            </Show>
          </div>

          <RoutineScopesField value={scopes()} onChange={setScopes} />

          <RoutineRunsOnField
            value={runsOn()}
            onChange={setRunsOn}
            testId="routine-runs-on"
            placement={placement()}
            onPlacementChange={setPlacement}
          />

          <RoutineApproverField
            value={approver()}
            onChange={setApprover}
            testId="routine-approver"
          />

          <RoutineTokenFields
            budget={tokenBudget()}
            limit={hardTokenLimit()}
            onBudget={setTokenBudget}
            onLimit={setHardTokenLimit}
            testIdPrefix="routine"
          />

          <Show when={saveError()}>
            <p data-testid="routines-new-error" class="text-[12px] text-amber-500">
              {saveError()}
            </p>
          </Show>

          <div class="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              data-testid="routines-new-cancel"
              onClick={cancel}
              class="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-surface-hover"
            >
              {i18n.t("kernel.agents.cancel")}
            </button>
            <button
              type="button"
              data-testid="routines-new-save"
              onClick={() => void handleSave()}
              disabled={saving()}
              class="rounded-md bg-accent px-3 py-1.5 text-[12px] text-accent-foreground transition-colors disabled:opacity-50"
            >
              {saving()
                ? i18n.t("kernel.agentForms.savingEllipsis")
                : i18n.t("kernel.agentForms.createRoutine")}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default RoutineCreate
