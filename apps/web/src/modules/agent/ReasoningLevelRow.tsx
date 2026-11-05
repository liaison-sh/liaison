// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  AUTO_REASONING_LEVEL,
  type ReasoningLevel,
  resolveTurnReasoningLevel,
} from "@liaison/shared"
import { For, Show } from "solid-js"
import { modelReasoning, servedModels } from "~/lib/model-groups"
import { useI18n } from "~/modules/i18n/i18n-context"

/** The i18n key of each level's label (the model menu, the AI models page). */
export const REASONING_LABEL_KEY: Record<ReasoningLevel, string> = {
  off: "kernel.reasoningOff",
  low: "kernel.reasoningLow",
  medium: "kernel.reasoningMedium",
  high: "kernel.reasoningHigh",
}

interface ReasoningLevelRowProps {
  /** The model the level applies to. Null / non-reasoning models hide the row,
   *  unless `auto` says Auto runs it (null: the model is not known yet). */
  modelId: string | null
  /** The level asked for; unset means the model's default. */
  level?: ReasoningLevel
  onSelect: (level: ReasoningLevel) => void
  /** Auto picks this model, so the server runs it at its own level, whatever
   *  is asked: the row shows that one level, read only. */
  auto?: boolean
}

/**
 * Segmented Off / Low / Medium / High control, shown inside the model popover for
 * the currently-selected model — only when that model supports reasoning, or
 * when Auto runs it, where it shows the one level Auto runs at. Acting
 * on a level does NOT close the popover (the parent menu items handle selection).
 */
export default function ReasoningLevelRow(props: ReasoningLevelRowProps) {
  const i18n = useI18n()
  // The served capability (GET /credits/models): an added OpenRouter model
  // offers exactly the levels the server says it takes, a model whose
  // reasoning cannot be switched off has no Off.
  const capability = () => modelReasoning(props.modelId)

  /** The org's level for a turn that asks for none (null: the model's own default). */
  const orgDefault = (): ReasoningLevel | null => servedModels()?.defaultReasoningLevel ?? null

  /** The level Auto runs at, as the server serves it (a demo box key's Low, the org's
   *  default level), else High. */
  const autoLevel = (): ReasoningLevel => servedModels()?.autoReasoningLevel ?? AUTO_REASONING_LEVEL

  /**
   * THE LEVEL THE TURN RUNS AT, by the server's own rule: Auto runs at its
   * level (a model that cannot reason, Off), a pick at the level asked, a level
   * the model does not take falls back to its default. Before the model Auto
   * runs is known, Auto's level stands.
   */
  const shown = (): ReasoningLevel =>
    props.auto && !props.modelId
      ? autoLevel()
      : resolveTurnReasoningLevel({
          capability: capability(),
          requested: props.level,
          autoPicked: props.auto === true,
          autoLevel: autoLevel(),
          orgDefault: orgDefault(),
        })
  /** On Auto the person has nothing to choose: only the level it runs at. */
  const levels = (): ReasoningLevel[] => (props.auto ? [shown()] : capability().allowedLevels)

  return (
    <Show when={props.auto || capability().supportsReasoning}>
      <div class="mt-1 border-t border-border-subtle px-2 pb-1 pt-1.5" data-testid="reasoning-row">
        <div class="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
          {i18n.t("kernel.reasoning")}
        </div>
        <div class="flex gap-0.5 rounded-md bg-surface-hover p-0.5">
          <For each={levels()}>
            {(lvl) => (
              <button
                type="button"
                data-testid={`reasoning-level-${lvl}`}
                disabled={props.auto}
                onClick={() => props.onSelect(lvl)}
                aria-pressed={shown() === lvl}
                class="flex-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors disabled:cursor-default"
                classList={{
                  "bg-surface text-text-primary shadow-sm": shown() === lvl,
                  "text-text-secondary hover:text-text-primary": shown() !== lvl,
                }}
              >
                {i18n.t(REASONING_LABEL_KEY[lvl])}
              </button>
            )}
          </For>
        </div>
        <Show when={props.auto}>
          <div data-testid="reasoning-auto-note" class="mt-1 px-1 text-[10px] text-text-tertiary">
            {i18n.t("kernel.reasoningAutoNote")}
          </div>
        </Show>
      </div>
    </Show>
  )
}
