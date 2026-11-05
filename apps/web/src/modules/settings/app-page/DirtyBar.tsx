// SPDX-License-Identifier: FSL-1.1-ALv2
// The ONE dirty Save/Discard bar of a block that stages its edits (S10: `list`
// and `tree` blocks): how many changes wait, Discard puts the stored state
// back, Save commits them through the block's declared ops.
import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"

const P = "kernel.settingsPage"

export const DirtyBar: Component<{
  /** Test id prefix: `<prefix>-dirty-bar`, `-dirty-count`, `-discard`, `-save`. */
  testId: string
  count: number
  saving: boolean
  onDiscard: () => void
  onSave: () => void
}> = (props) => {
  const i18n = useI18n()
  return (
    <div
      class="sticky bottom-2 flex items-center gap-2 rounded-md border border-border bg-elevated px-3 py-2 shadow-popover"
      data-testid={`${props.testId}-dirty-bar`}
    >
      <span class="min-w-0 flex-1 text-[13px]" data-testid={`${props.testId}-dirty-count`}>
        {props.count === 1
          ? i18n.t(`${P}.unsavedOne`)
          : i18n.t(`${P}.unsaved`, { count: props.count })}
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={props.saving}
        data-testid={`${props.testId}-discard`}
        onClick={() => props.onDiscard()}
      >
        {i18n.t(`${P}.discard`)}
      </Button>
      <Button
        size="sm"
        loading={props.saving}
        data-testid={`${props.testId}-save`}
        onClick={() => props.onSave()}
      >
        {i18n.t(`${P}.save`)}
      </Button>
    </div>
  )
}
