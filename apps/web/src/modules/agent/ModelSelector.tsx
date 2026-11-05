// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  currentNodeModels,
  defaultLocalModel,
  offeredLocalModelFor,
  type ReasoningLevel,
  tierAtLeast,
} from "@liaison/shared"
import { ChevronUp } from "lucide-solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { desktopLocalModelLabel } from "~/lib/desktop-shell-contract"
import type { ModelEntry } from "~/lib/model-groups"
import {
  autoEntryLabel,
  COMPACT_MODEL_CHIP_MAX_PX,
  canChangeModel,
  getModelLabel,
  modelAllowedByKey,
  modelGroups,
  modelNameWithoutProvider,
  servedModels,
} from "~/lib/model-groups"
import {
  chooseLocalModel,
  desktopState,
  isDesktop,
  localModelFor,
  localModelOptions,
  runnableLocalModels,
  setRuntimeLocation,
} from "~/modules/desktop/desktop-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { modelsFor, nodeForRun } from "~/modules/nodes/nodes-store"
import { myNodeRuntimeIn, setThreadNodeRuntime } from "~/modules/nodes/thread-node-runtime"
import { billingMode } from "~/modules/settings/BillingState"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { PopupMenu } from "~/ui/PopupMenu"
import ReasoningLevelRow from "./ReasoningLevelRow"

/**
 * NORMATIVE, spec.md's "User-facing copy" table. Moved here from
 * apps/desktop/src/session/desktop-copy.ts with no paraphrase: S14's two
 * section headers and the one entry the local section holds.
 */
/** Catalog keys for the picker's two group headings and its local entry. */
export const MODEL_GROUP_LOCAL_KEY = "kernel.agentForms.modelGroupLocal"
export const MODEL_GROUP_LIAISON_KEY = "kernel.agentForms.modelGroupLiaison"
export const MODEL_LOCAL_ENTRY_KEY = "kernel.agentForms.modelLocalEntry"
/** The heading over a node's own models, naming the node (My node). */
export const MODEL_GROUP_NODE_KEY = "kernel.agentForms.modelGroupNode"

interface BalanceState {
  included: string
  purchased: string
  currency: string
  tier?: string
}

interface ModelSelectorProps {
  balance: BalanceState | null
  selectedModelId: string | null
  onSelect: (modelId: string | null) => void
  reasoningLevel?: ReasoningLevel
  onSelectReasoning?: (level: ReasoningLevel) => void
  /** Model ids the org can run (from GET /credits/models). The menu lists the
   *  served models themselves (`modelGroups`); when this set is provided it
   *  narrows them further (plus Auto). */
  availableModelIds?: Set<string> | null
  /** What picking NOTHING means here, when it means something better than
   *  "Auto": in a conversation with an agent it falls back to that agent's own
   *  default, so the entry reads "Default (Claude Opus 4.5)" and the chip says
   *  which model is actually answering. */
  defaultEntryLabel?: string
  /** The seated agent's own model preference: what a node chat with no model
   *  picked runs on, when the node offers it (else the node's default). */
  agentDefaultModelId?: string | null
  /** A short stand-in shown INSTEAD of the model's name, for a row too narrow
   *  to carry it (the phone composer). The full names live in the menu. */
  compactLabel?: string | null
  /** What the chip itself says while the default is the selection, when the
   *  menu's entry ("Default (Claude Opus 4.6)") is too long for the host's row
   *  (the composer's "Default"). The entry stays the chip's title and the
   *  menu's first item. */
  defaultChipLabel?: string
  /** Cap the chip's name at a width, with an ellipsis (the composer's row);
   *  the full name is its title. */
  capLabel?: boolean
  /** The conversation this control belongs to, which is what a LOCAL model is
   *  remembered against. Null where there is no conversation yet. */
  threadId?: string | null
  /** Merged over the chip's default look, for a host that draws it as a
   *  bordered pill (the chat composer). Other hosts keep the bare chip. */
  triggerClass?: string
  /** Controlled open state, for a host that opens the menu from elsewhere
   *  (a conversation's actions menu). Uncontrolled when omitted. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** The trigger is an invisible anchor laid over the host's own control:
   *  the menu is opened through `open`, never by clicking the chip. */
  hiddenTrigger?: boolean
}

// Full menu: self_hosted (BYOK) OR tier >= "team" OR purchased > 0.
// The self_hosted/purchased half of this gate is shared with AgentMessageMenu
// via canChangeModel — kept in sync so the two surfaces can't drift again.
//
// A NULL BALANCE IS "UNKNOWN", NOT "NO CREDITS". It is what the session
// credits store holds before its single read lands, and what it keeps
// holding whenever /credits/balance is parked behind a 429 backoff. Reading
// that as a locked org turned the model control of a whole conversation into
// a dead grey word with no picker behind it, in a session whose chat was
// answering on a perfectly ordinary model. Only a balance we actually have
// may lock the menu.
export function fullModelMenuUnlocked(balance: BalanceState | null): boolean {
  if (canChangeModel(billingMode(), Number(balance?.purchased ?? 0) > 0)) return true
  if (!balance) return true
  return tierAtLeast(balance.tier ?? "starter", "team")
}

/** Whether the picker opens at all: unlocked, or on the desktop, whose local
 *  section is never gated (see `menuReachable` below). */
export function modelMenuReachable(balance: BalanceState | null): boolean {
  return fullModelMenuUnlocked(balance) || isDesktop()
}

export default function ModelSelector(props: ModelSelectorProps) {
  const i18n = useI18n()
  const api = useOptionalApi()
  /** The viewer's own node runtime in this conversation (My node), or null. */
  const nodeRun = () => myNodeRuntimeIn(props.threadId)
  const [ownOpen, setOwnOpen] = createSignal(false)
  const open = () => props.open ?? ownOpen()
  function setOpen(next: boolean) {
    setOwnOpen(next)
    props.onOpenChange?.(next)
  }

  // Self-hosted is BYOK with NO credit/tier gating — billing is a managed-only
  // concept (lib/edition.ts). In self_hosted the full menu is always unlocked
  // and every model is selectable; balance is never consulted.
  const selfHosted = () => billingMode() === "self_hosted"

  const fullMenuUnlocked = createMemo(() => fullModelMenuUnlocked(props.balance))

  // A model is offered only if its provider has a configured key (BYOK or
  // managed env), per GET /credits/models — shared with AgentMessageMenu via
  // modelAllowedByKey so the two pickers cannot drift.
  const allowedByKey = (m: ModelEntry): boolean => modelAllowedByKey(m, props.availableModelIds)

  // Filter a model group's entries to those the org can access.
  // self_hosted → all models with a configured key (BYOK); managed: purchased > 0
  // unlocks all (still key-gated), otherwise apply tier_minimum gating.
  function visibleModels(models: ModelEntry[]): ModelEntry[] {
    // Reachable while LOCKED only on the desktop, where the menu opens for the
    // sake of the local section (see `menuReachable`). The Liaison side then
    // offers Auto alone, which is exactly what the desktop's own picker did.
    if (!fullMenuUnlocked()) return models.filter((m) => allowedByKey(m) && m.id === null)
    // Unknown balance: every key-backed model is offered. Tier gating resumes
    // the moment the balance lands.
    if (selfHosted() || !props.balance) return models.filter(allowedByKey)
    const bal = props.balance
    const hasPurchased = Number(bal.purchased) > 0
    const orgTier = bal.tier ?? "starter"
    return models.filter(
      (m) => allowedByKey(m) && (hasPurchased || tierAtLeast(orgTier, m.tierMinimum)),
    )
  }

  /**
   * THE LOCAL SECTION IS NOT GATED, so the menu opens on a desktop even when
   * the Liaison side is locked down to Auto. A local model runs on the user's
   * own Claude Code login, which is the point of S14: there is no credit and
   * no tier to check, and a locked org would otherwise have no way to reach
   * the machine in front of it.
   */
  const menuReachable = createMemo(() => modelMenuReachable(props.balance) || nodeRun() !== null)

  /** What the chip says: the compact stand in, else the conversation's own
   *  default entry label, else the selected model's name. Shared by the open
   *  trigger and the locked pill so the two can never disagree. */
  const chipLabel = () =>
    props.defaultChipLabel && defaultPicked()
      ? props.defaultChipLabel
      : nodeRun()
        ? props.compactLabel
          ? nodeShortLabel()
          : nodeChipLabel()
        : props.compactLabel
          ? props.compactLabel
          : fullChipLabel()

  /** The whole name of what answers: the chip's title, whatever it shows. */
  const fullChipLabel = () =>
    nodeRun()
      ? nodeChipLabel()
      : localRuntime()
        ? localChipLabel()
        : props.selectedModelId === null
          ? (props.defaultEntryLabel ?? autoEntryLabel())
          : getModelLabel(props.selectedModelId)

  /** Nothing picked and no agent model to follow: Auto picks the model, so
   *  the turn runs at Auto's level (resolveTurnReasoningLevel). */
  const onAuto = () => props.selectedModelId === null && !props.agentDefaultModelId

  /** Nothing picked: the conversation follows its default. */
  const defaultPicked = () => {
    const run = nodeRun()
    if (run) return !run.model
    return !localRuntime() && props.selectedModelId === null
  }

  /**
   * THE TURN RUNS ON THIS MACHINE, so the chip names the local model, never the
   * Liaison one: the Liaison model is not what answers while the runtime is
   * local, and a chip still saying "Default (Gemini Pro)" after the user picked
   * a local entry read as a control that does nothing.
   */
  const localRuntime = () =>
    nodeRun() === null && isDesktop() && desktopState().runtimeLocation === "local"

  /**
   * MY NODE: THE TURN RUNS ON ONE OF THE VIEWER'S NODES, so the menu offers
   * that node's own Claude models and nothing else: a Liaison model is not
   * what answers there. The pick is stored on the conversation's node runtime
   * (the server checks the node offers it); none picked runs the agent's own
   * Claude preference when the node offers it, else the node's default.
   */
  const runNode = () => {
    const run = nodeRun()
    return run ? nodeForRun(run.nodeId) : undefined
  }
  const nodeModels = () => currentNodeModels(modelsFor(runNode()?.id ?? null))
  const nodeName = () => runNode()?.name ?? null
  const nodeModelLabel = (id: string) => nodeModels().find((m) => m.id === id)?.label ?? id
  /** What a node chat with no model picked runs on (the node's own rule). */
  const nodeDefaultModel = () => {
    const offered = nodeModels()
    const preference = props.agentDefaultModelId
    return (
      (preference?.startsWith("claude-") ? offeredLocalModelFor(preference, offered) : null) ??
      defaultLocalModel(offered)
    )
  }
  const nodeDefaultLabel = () =>
    i18n.t("kernel.modelDefaultEntry", { model: nodeModelLabel(nodeDefaultModel()) })
  const nodeChipLabel = () => {
    const picked = nodeRun()?.model
    return picked ? nodeModelLabel(picked) : nodeDefaultLabel()
  }
  /** The phone's stand in: the model's name without "Claude" ("Opus 5.5"). */
  const nodeShortLabel = () =>
    nodeModelLabel(nodeRun()?.model ?? nodeDefaultModel()).replace(/^Claude\s+/, "")

  async function selectNodeModel(modelId: string | null) {
    setOpen(false)
    const run = nodeRun()
    if (!api || !props.threadId || !run) return
    try {
      await setThreadNodeRuntime(api, props.threadId, {
        agentId: run.agentId,
        runsOn: run.runsOn,
        model: modelId,
      })
    } catch {
      addToast({ message: i18n.t("kernel.agentForms.nodeModelNotChanged"), type: "warning" })
    }
  }
  const localModel = () => localModelFor(props.threadId)
  /**
   * The local entries: what is offered (each family's current model), plus the
   * conversation's own model when it is an older version the shell still runs
   * (`localModelFor` keeps it there), so the chip names it and its entry shows
   * as the checked one instead of nothing at all.
   */
  const localEntries = () => {
    const offered = localModelOptions()
    const id = localModel()
    if (offered.length === 0 || offered.some((model) => model.id === id)) return offered
    const kept = runnableLocalModels().find((model) => model.id === id)
    return kept ? [...offered, kept] : offered
  }
  const localChipLabel = () =>
    localModelOptions().length > 0
      ? (desktopLocalModelLabel(localModel(), localEntries()) ?? i18n.t(MODEL_LOCAL_ENTRY_KEY))
      : i18n.t(MODEL_LOCAL_ENTRY_KEY)

  /** Picking a model is also picking where the turn runs, on a desktop. */
  function selectLiaisonModel(modelId: string | null) {
    if (isDesktop()) setRuntimeLocation("liaison")
    props.onSelect(modelId)
    setOpen(false)
  }

  /** A shell that predates the model choice: the single legacy entry. */
  function selectLocalRuntime() {
    setRuntimeLocation("local")
    setOpen(false)
  }

  /** A local model for THIS conversation, which also moves the turn here. */
  function selectLocalModel(modelId: string) {
    chooseLocalModel(props.threadId, modelId)
    setRuntimeLocation("local")
    setOpen(false)
  }

  /**
   * The served provider groups (S6: Auto, Anthropic, OpenAI, Google, Mistral,
   * OpenRouter, then each of the org's own servers). Extracted so the desktop's own
   * section wrapper can be put AROUND them without the browser paying for it:
   * `data-testid={isDesktop() ? ... : undefined}` on a wrapper still rendered
   * the wrapper, which is a new element in a browser's popup markup and the
   * one thing this slice promised not to add (P6d-FX1, SK-7).
   */
  const liaisonGroups = () => (
    <For each={modelGroups()}>
      {(group) => {
        const entries = visibleModels(group.models)
        return (
          <Show when={entries.length > 0}>
            <PopupMenu.Group>
              <Show when={group.provider !== "Auto"}>
                <PopupMenu.Label>{group.provider}</PopupMenu.Label>
              </Show>
              <For each={entries}>
                {(model) => (
                  <PopupMenu.Item
                    onSelect={() => selectLiaisonModel(model.id)}
                    data-testid={`model-option-${model.id ?? "auto"}`}
                    class={
                      !localRuntime() && props.selectedModelId === model.id
                        ? "font-medium text-accent"
                        : undefined
                    }
                  >
                    {model.id === null
                      ? (props.defaultEntryLabel ?? autoEntryLabel())
                      : model.label}
                  </PopupMenu.Item>
                )}
              </For>
            </PopupMenu.Group>
          </Show>
        )
      }}
    </For>
  )

  return (
    <Show
      when={menuReachable()}
      fallback={
        props.hiddenTrigger ? null : (
          // LOCKED STILL SAYS WHICH MODEL IS ANSWERING, and says why it cannot be
          // changed. The old fallback was the literal word "Auto", which was
          // wrong about the model whenever the conversation carried one and told
          // nobody why the picker was gone.
          <span
            data-testid="model-selector-label"
            data-locked="true"
            // The reason rides the pill itself: a span carrying an aria-label
            // without a role announces nothing, and the model's name is already
            // the pill's text.
            title={i18n.t("kernel.upgradeToChangeModel")}
            class={cn(
              "cursor-default rounded-full px-2 py-0.5 text-[11px] font-medium text-text-tertiary",
              // Locked stays locked-looking inside a host's pill: no hover.
              props.triggerClass && [
                props.triggerClass,
                "cursor-default text-text-tertiary hover:border-border hover:text-text-tertiary",
              ],
            )}
          >
            {chipLabel()}
          </span>
        )
      }
    >
      <PopupMenu open={open()} onOpenChange={setOpen}>
        <PopupMenu.Trigger
          id={props.hiddenTrigger ? undefined : "model-selector"}
          aria-label={i18n.t("kernel.selectModel")}
          class={
            props.hiddenTrigger
              ? "pointer-events-none absolute inset-0 opacity-0"
              : props.capLabel
                ? "flex min-w-0 max-w-full"
                : undefined
          }
          tabIndex={props.hiddenTrigger ? -1 : undefined}
        >
          <button
            type="button"
            title={fullChipLabel()}
            tabIndex={props.hiddenTrigger ? -1 : undefined}
            data-compact={props.compactLabel ? "true" : "false"}
            // The cap is an INLINE style on purpose: it is the guarantee the
            // composer's editor is measured against, so it belongs where a
            // test can read it back rather than in a class name.
            style={
              props.compactLabel ? { "max-width": `${COMPACT_MODEL_CHIP_MAX_PX}px` } : undefined
            }
            class={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary",
              props.capLabel && "min-w-0 max-w-full",
              props.triggerClass,
            )}
          >
            <span
              data-testid="model-selector-label"
              class={props.capLabel ? "min-w-0 max-w-[16ch] truncate" : undefined}
            >
              {/* A capped chip names the model, not its provider ("Gemini 3.1…",
                  never "Google:…"); the title and the menu keep the full name. */}
              {props.capLabel ? modelNameWithoutProvider(chipLabel() ?? "") : chipLabel()}
            </span>
            <ChevronUp class="h-3 w-3 shrink-0" />
          </button>
        </PopupMenu.Trigger>
        <PopupMenu.Content>
          <div class="w-48">
            {/*
              P6d-T10: ONE model control, not two. The desktop's local entry is
              its own SECTION above the provider groups, and the five provider
              groups are not regrouped: they render exactly as they did, one
              level deeper, under a header of their own. A browser sees neither
              header and neither section wrapper.
            */}
            <Show when={nodeRun()}>
              <div data-testid="model-section-node">
                <PopupMenu.Group>
                  <PopupMenu.Label>
                    {nodeName()
                      ? i18n.t(MODEL_GROUP_NODE_KEY, { node: nodeName() ?? "" })
                      : i18n.t(MODEL_GROUP_LOCAL_KEY)}
                  </PopupMenu.Label>
                  <PopupMenu.Item
                    onSelect={() => void selectNodeModel(null)}
                    textValue={nodeDefaultLabel()}
                    class={!nodeRun()?.model ? "font-medium text-accent" : undefined}
                  >
                    {nodeDefaultLabel()}
                  </PopupMenu.Item>
                  <For each={nodeModels()}>
                    {(model) => (
                      <PopupMenu.Item
                        onSelect={() => void selectNodeModel(model.id)}
                        textValue={model.label}
                        class={
                          nodeRun()?.model === model.id ? "font-medium text-accent" : undefined
                        }
                      >
                        {model.label}
                      </PopupMenu.Item>
                    )}
                  </For>
                </PopupMenu.Group>
              </div>
            </Show>
            <Show when={!nodeRun() && isDesktop()}>
              <div data-testid="model-section-local">
                <PopupMenu.Group>
                  <PopupMenu.Label>{i18n.t(MODEL_GROUP_LOCAL_KEY)}</PopupMenu.Label>
                  <Show
                    when={localModelOptions().length > 0}
                    fallback={
                      <PopupMenu.Item
                        onSelect={selectLocalRuntime}
                        textValue={i18n.t(MODEL_LOCAL_ENTRY_KEY)}
                      >
                        {i18n.t(MODEL_LOCAL_ENTRY_KEY)}
                      </PopupMenu.Item>
                    }
                  >
                    <For each={localEntries()}>
                      {(model) => (
                        <PopupMenu.Item
                          onSelect={() => selectLocalModel(model.id)}
                          textValue={model.label}
                          class={
                            localRuntime() && localModel() === model.id
                              ? "font-medium text-accent"
                              : undefined
                          }
                        >
                          {model.label}
                        </PopupMenu.Item>
                      )}
                    </For>
                  </Show>
                </PopupMenu.Group>
              </div>
              <PopupMenu.Separator />
              <PopupMenu.Group>
                <PopupMenu.Label>{i18n.t(MODEL_GROUP_LIAISON_KEY)}</PopupMenu.Label>
              </PopupMenu.Group>
            </Show>
            <Show when={!nodeRun()}>
              <Show when={isDesktop()} fallback={liaisonGroups()}>
                <div data-testid="model-section-liaison">{liaisonGroups()}</div>
              </Show>
            </Show>
            {/*
              LOCKED MEANS LOCKED (P6d-FX1, SK-7). The menu opens on a desktop
              even when the Liaison side is locked, for the sake of the local
              section, and that put this control in reach of an org that could
              never open a menu at all before: its chat carries a reasoning
              capable model id, and the reasoning level became changeable. The
              model list was gated; this was not.
            */}
            <Show when={fullMenuUnlocked() && !localRuntime() && !nodeRun()}>
              <ReasoningLevelRow
                modelId={
                  onAuto() ? (servedModels()?.autoResolvedKey ?? null) : props.selectedModelId
                }
                auto={onAuto()}
                level={props.reasoningLevel}
                onSelect={(level) => {
                  props.onSelectReasoning?.(level)
                  setOpen(false)
                }}
              />
            </Show>
          </div>
        </PopupMenu.Content>
      </PopupMenu>
    </Show>
  )
}
