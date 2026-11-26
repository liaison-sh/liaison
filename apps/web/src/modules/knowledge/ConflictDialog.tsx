// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Someone saved the page while this person was writing (D7): Keep mine, Take
// theirs, or See both first. Whatever is chosen, the other text stays in Page
// history. On a phone it is a sheet.

import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { shellTier } from "~/modules/shell/shell-tier"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { OverlaySheet } from "~/ui/OverlaySheet"
import { TextDiff } from "./TextDiff"

export interface ConflictDialogProps {
  open: boolean
  /** "choose" (three choices) or "both" (the two texts side by side). */
  mode: "choose" | "both"
  /** Who saved theirs: a name, or null when it was this person in another tab. */
  theirName: string | null
  mine: string
  theirs: string
  busy?: boolean
  onMode: (mode: "choose" | "both") => void
  onKeepMine: () => void
  onTakeTheirs: () => void
  onClose: () => void
}

export const ConflictDialog: Component<ConflictDialogProps> = (props) => {
  const i18n = useI18n()
  const phone = () => shellTier() === "phone"
  const title = () =>
    props.mode === "both"
      ? i18n.t("knowledge.autosave.bothTitle")
      : props.theirName
        ? i18n.t("knowledge.autosave.conflictTitle", { name: props.theirName })
        : i18n.t("knowledge.autosave.conflictTitleSelf")

  const choice = (testid: string, label: string, hint: string, run: () => void) => (
    <button
      type="button"
      data-testid={testid}
      disabled={props.busy}
      onClick={run}
      class="flex min-h-11 w-full flex-col items-start rounded-md border border-border px-3 py-2 text-left hover:bg-surface-hover focus-visible:bg-surface-hover disabled:opacity-50"
    >
      <span class="text-[13px] font-medium text-text">{label}</span>
      <span class="text-[12px] text-text-tertiary">{hint}</span>
    </button>
  )

  const column = (
    label: string,
    before: string,
    after: string,
    button: string,
    run: () => void,
    testid: string,
  ) => (
    <section class="flex min-h-0 min-w-0 flex-1 flex-col rounded-md border border-border">
      <div class="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
        <h3 class="text-[13px] font-medium text-text">{label}</h3>
        <Button
          variant="outline"
          size="sm"
          data-testid={testid}
          disabled={props.busy}
          onClick={run}
        >
          {button}
        </Button>
      </div>
      <div
        class="min-h-0 overflow-y-auto px-3 py-2"
        style={{ "max-height": phone() ? "24vh" : "44vh" }}
      >
        <TextDiff before={before} after={after} />
      </div>
    </section>
  )

  const body = () => (
    <div data-testid="conflict-dialog" data-mode={props.mode}>
      <Show
        when={props.mode === "both"}
        fallback={
          <>
            <p class="text-sm text-text-secondary">{i18n.t("knowledge.autosave.conflictBody")}</p>
            <div class="mt-4 flex flex-col gap-2">
              {choice(
                "conflict-mine",
                i18n.t("knowledge.autosave.keepMine"),
                i18n.t("knowledge.autosave.keepMineHint"),
                props.onKeepMine,
              )}
              {choice(
                "conflict-theirs",
                i18n.t("knowledge.autosave.takeTheirs"),
                i18n.t("knowledge.autosave.takeTheirsHint"),
                props.onTakeTheirs,
              )}
              {choice(
                "conflict-both",
                i18n.t("knowledge.autosave.seeBoth"),
                i18n.t("knowledge.autosave.seeBothHint"),
                () => props.onMode("both"),
              )}
            </div>
          </>
        }
      >
        <p class="text-sm text-text-secondary">{i18n.t("knowledge.autosave.bothBody")}</p>
        <div class={`mt-4 flex gap-3 ${phone() ? "flex-col" : ""}`}>
          {column(
            i18n.t("knowledge.autosave.yours"),
            props.theirs,
            props.mine,
            i18n.t("knowledge.autosave.keepMine"),
            props.onKeepMine,
            "conflict-both-mine",
          )}
          {column(
            i18n.t("knowledge.autosave.theirs"),
            props.mine,
            props.theirs,
            i18n.t("knowledge.autosave.takeTheirs"),
            props.onTakeTheirs,
            "conflict-both-theirs",
          )}
        </div>
        <div class="mt-4 flex justify-end">
          <Button
            variant="ghost"
            data-testid="conflict-back"
            onClick={() => props.onMode("choose")}
          >
            {i18n.t("knowledge.autosave.back")}
          </Button>
        </div>
      </Show>
    </div>
  )

  return (
    <Show
      when={phone()}
      fallback={
        <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
          <Dialog.Content class={props.mode === "both" ? "max-w-4xl" : "max-w-md"}>
            <Dialog.Title>{title()}</Dialog.Title>
            <div class="mt-3">{body()}</div>
          </Dialog.Content>
        </Dialog>
      }
    >
      <OverlaySheet open={props.open} onClose={props.onClose} variant="bottom" title={title()}>
        <div class="px-4 py-3">{body()}</div>
      </OverlaySheet>
    </Show>
  )
}

export default ConflictDialog
