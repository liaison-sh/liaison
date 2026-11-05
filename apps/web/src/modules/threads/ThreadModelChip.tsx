// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ReasoningLevel } from "@liaison/shared"
import type { Component } from "solid-js"
import { autoEntryLabel, getModelLabel, modelShortLabel } from "~/lib/model-groups"
import ModelSelector from "~/modules/agent/ModelSelector"
import { useI18n } from "~/modules/i18n/i18n-context"
import { shellTier } from "~/modules/shell/shell-tier"

interface BalanceState {
  included: string
  purchased: string
  currency: string
  tier?: string
}

export interface ThreadModelChipProps {
  balance: BalanceState | null
  availableModelIds: Set<string> | null
  /** This conversation's override, null when it follows the agent's default. */
  agentModelId: string | null
  /** The seated agent's own default. */
  agentDefaultModelId: string | null
  reasoningLevel?: ReasoningLevel
  onSelect: (modelId: string | null) => void
  onSelectReasoning?: (level: ReasoningLevel) => void
  /** The conversation, which a local model choice is remembered against. */
  threadId?: string | null
  /** Drawn as an invisible anchor over another control (the conversation's
   *  actions trigger) and opened through `open`: see InvokedModelMenu. */
  asMenuAnchor?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * The composer's model control for a conversation with an agent.
 *
 * The agent's model is a DEFAULT, not a fixed property: the same agent is
 * worth opus through a local runtime at a desk and a cheap fast model from a
 * phone. The chip says "Default" while the chat follows the agent (the model
 * that answers is its title), else the model picked, and opens the one model
 * selector the rest of the app uses, whose first entry is "Default (<the
 * agent's model>)". Changing it applies from the next turn.
 */
const ThreadModelChip: Component<ThreadModelChipProps> = (props) => {
  const i18n = useI18n()
  // An agent on Auto says which model Auto runs ("Default (Auto · <model>)"),
  // as the bare picker's Auto row does: the admin chooses it in Settings -> AI
  // models, and "Default (Auto)" named nothing.
  const defaultLabel = () =>
    i18n.t("kernel.modelDefaultEntry", {
      model: props.agentDefaultModelId
        ? getModelLabel(props.agentDefaultModelId)
        : autoEntryLabel(),
    })
  // On a phone a picked model is its SHORT NAME, not its initials:
  // "Flash-Lite", never "GF". Two letters beside a send button read as an
  // unlabeled code. The full names, and the "Default (...)" entry, live in the
  // menu it opens, which is the same selector the desktop opens. The default
  // is "Default" at every tier.
  const compactLabel = () =>
    shellTier() === "phone" && props.agentModelId !== null
      ? modelShortLabel(props.agentModelId)
      : null
  return (
    <div
      data-testid={props.asMenuAnchor ? "thread-model-menu-anchor" : "thread-model-chip"}
      // Shrinks before the control line wraps: the name ends in an ellipsis.
      class={props.asMenuAnchor ? "pointer-events-none absolute inset-0" : "min-w-0"}
      data-effective-model={props.agentModelId ?? props.agentDefaultModelId ?? ""}
    >
      <ModelSelector
        balance={props.balance}
        availableModelIds={props.availableModelIds}
        selectedModelId={props.agentModelId}
        defaultEntryLabel={defaultLabel()}
        agentDefaultModelId={props.agentDefaultModelId}
        reasoningLevel={props.reasoningLevel}
        onSelect={props.onSelect}
        onSelectReasoning={props.onSelectReasoning}
        compactLabel={compactLabel()}
        // The chip says "Default"; the model it resolves to is its title and
        // the menu's first entry ("Default (Auto · <model>)").
        defaultChipLabel={i18n.t("kernel.modelDefaultChip")}
        capLabel
        threadId={props.threadId ?? null}
        open={props.open}
        onOpenChange={props.onOpenChange}
        hiddenTrigger={props.asMenuAnchor}
        // The chip is only ever drawn on the composer's control row, where it
        // is a bordered pill so it reads as a control, not as stray text.
        triggerClass="border border-border bg-surface px-2.5 py-1 text-[12.5px] font-medium text-text-secondary hover:border-border-strong hover:bg-surface hover:text-text"
      />
    </div>
  )
}

export default ThreadModelChip
