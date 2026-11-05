// SPDX-License-Identifier: FSL-1.1-ALv2

import type { ReasoningLevel } from "@liaison/shared"
import { Check, Ellipsis, Pencil, Trash2 } from "lucide-solid"
import { createSignal, For, Show } from "solid-js"
import { autoEntryLabel, canChangeModel, modelAllowedByKey, modelGroups } from "~/lib/model-groups"
import ReasoningLevelRow from "~/modules/agent/ReasoningLevelRow"
import { useI18n } from "~/modules/i18n/i18n-context"
import { billingMode } from "~/modules/settings/BillingState"
import { PopupMenu } from "~/ui/PopupMenu"

interface AgentMessageMenuProps {
  currentModelId: string | null
  hasPurchasedCredits: boolean
  /** Absent → the model section is not rendered (menu carries only manage actions). */
  onSelectModel?: (modelId: string | null) => void
  currentReasoningLevel?: ReasoningLevel
  onSelectReasoning?: (level: ReasoningLevel) => void
  onOpenChange?: (open: boolean) => void
  /** Model ids the org can run (GET /credits/models). Same contract as
   *  ModelSelector: the served list is what is shown, this narrows it. */
  availableModelIds?: Set<string> | null
  /** Edit/Delete entries — shown when the viewer can manage this message. */
  canManage?: boolean
  onEdit?: () => void
  onDelete?: () => void
}

/** The single "..." menu on an agent message: manage actions (edit/delete)
 *  and the model/reasoning picker share one trigger. */
export default function AgentMessageMenu(props: AgentMessageMenuProps) {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)

  function handleOpenChange(value: boolean) {
    setOpen(value)
    props.onOpenChange?.(value)
  }

  const modelSectionUnlocked = () => canChangeModel(billingMode(), props.hasPurchasedCredits)

  return (
    <PopupMenu open={open()} onOpenChange={handleOpenChange}>
      <PopupMenu.Trigger
        class="flex h-6 w-6 items-center justify-center rounded bg-surface shadow-sm ring-1 ring-border-subtle hover:bg-surface-hover"
        aria-label={i18n.t("kernel.messageActions")}
      >
        <Ellipsis size={14} class="text-text-secondary" />
      </PopupMenu.Trigger>
      <PopupMenu.Content>
        <Show when={props.canManage}>
          <PopupMenu.Item onSelect={() => props.onEdit?.()}>
            <Pencil size={13} /> {i18n.t("kernel.common.edit")}
          </PopupMenu.Item>
          <PopupMenu.Item onSelect={() => props.onDelete?.()} variant="danger">
            <Trash2 size={13} /> {i18n.t("kernel.common.delete")}
          </PopupMenu.Item>
          <Show when={props.onSelectModel}>
            <PopupMenu.Separator />
          </Show>
        </Show>
        <Show when={props.onSelectModel}>
          <Show
            when={modelSectionUnlocked()}
            fallback={
              <div class="px-3 py-2 text-[12px] text-text-tertiary">
                {i18n.t("kernel.upgradeToChangeModel")}
              </div>
            }
          >
            <div class="w-48">
              <For each={modelGroups()}>
                {(group) => {
                  const entries = () =>
                    group.models.filter((m) => modelAllowedByKey(m, props.availableModelIds))
                  return (
                    <Show when={entries().length > 0}>
                      <PopupMenu.Group>
                        <Show when={group.provider !== "Auto"}>
                          <PopupMenu.Label>{group.provider}</PopupMenu.Label>
                        </Show>
                        <For each={entries()}>
                          {(model) => (
                            <PopupMenu.Item
                              onSelect={() => {
                                props.onSelectModel?.(model.id)
                                setOpen(false)
                              }}
                              class={
                                props.currentModelId === model.id
                                  ? "font-medium text-accent"
                                  : undefined
                              }
                            >
                              <Show when={props.currentModelId === model.id}>
                                <Check size={12} class="shrink-0 text-accent" />
                              </Show>
                              <Show when={props.currentModelId !== model.id}>
                                <span class="w-3 shrink-0" />
                              </Show>
                              {model.id === null ? autoEntryLabel() : model.label}
                            </PopupMenu.Item>
                          )}
                        </For>
                      </PopupMenu.Group>
                    </Show>
                  )
                }}
              </For>
              <ReasoningLevelRow
                modelId={props.currentModelId}
                level={props.currentReasoningLevel ?? "off"}
                onSelect={(level) => props.onSelectReasoning?.(level)}
              />
            </div>
          </Show>
        </Show>
      </PopupMenu.Content>
    </PopupMenu>
  )
}
