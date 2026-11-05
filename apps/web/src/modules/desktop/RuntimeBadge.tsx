// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T09: THE "LOCAL" PILL, PUT BACK IN THE FLOW.
//
// It used to be a fixed position element the overlay drew into a zero width
// hole in the tab bar, which is how it ended up sitting on top of the agent
// panel's new conversation button (ws06b-walk-badge-overlap-crop.png). An
// element that is positioned over the app cannot be laid out with the app, so
// it collides with whatever grows under it.
//
// Here it is an ordinary sibling in the composer's control row, next to Attach
// and the permission mode. It takes its own width, the row makes room, and
// nothing can land on top of it. It is never `fixed`, never `absolute` and
// carries no style attribute, and the tests assert exactly that, by class
// string: apps/web's vitest does not compile Tailwind, so `getComputedStyle`
// would answer "static" for a fixed element and pass against the very defect
// this is the fix for.
//
// It says the runtime only while a local session is LIVE for this
// conversation. A badge that is always there says nothing; this one appears
// when the answer stops coming from Liaison.
//
// THE FILES THE SESSION MADE LIVE ON THE PILL (2026-09-25). They used to have
// an icon button of their own beside the `+`, which read as a second attach
// button and said nothing about the local session. Once the session has
// written a file, the pill becomes a menu of those files: a row opens the
// file on this computer (the same shell opener a path in a message uses), and
// a small action on the row attaches it to the conversation through
// `uploadFile`, the same function the `+` uses, so there is still one upload
// path. With nothing produced, the pill is the plain badge it always was.
//
// RECORDED REDUCTION (migration map, against A33): `AttachToLiaisonAction`
// named two destinations, a thread or a Knowledge document. This seam reaches
// threads only; the Knowledge destination is deferred, and written down rather
// than lost.

import { ChevronDown, Cloud, MonitorSmartphone, Paperclip } from "lucide-solid"
import { type Component, createSignal, For, type JSX, Show } from "solid-js"
import type { DesktopProducedFile } from "~/lib/desktop-shell-contract"
import { type FileParent, type FileRow, uploadFile } from "~/modules/files/file-service"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { PopupMenu } from "~/ui/PopupMenu"
import { Tooltip } from "~/ui/Tooltip"
import {
  desktopState,
  isDesktop,
  localSessionFor,
  openLocalPath,
  readLocalFile,
} from "./desktop-store"

/**
 * The two words the runtime control uses, so one screen never says two things.
 * Catalog keys: "This machine" reads « Cet ordinateur » in French.
 */
export const RUNTIME_LABEL_LOCAL = "kernel.desktopUi.runtime.thisMachine"
export const RUNTIME_LABEL_LIAISON = "kernel.desktopUi.runtime.liaison"

/** The pill's hint and accessible name once it opens the produced files. */
export const PRODUCED_FILES_OPEN_LABEL = "kernel.desktopUi.producedFiles.open"
/** The heading of the menu the pill opens. */
export const PRODUCED_FILES_MENU_TITLE = "kernel.desktopUi.producedFiles.menuTitle"
/** The small action on each row that attaches the file to the conversation. */
export const PRODUCED_FILES_ATTACH_LABEL = "kernel.desktopUi.producedFiles.attach"

const PILL_CLASS =
  "inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-glow px-2 py-0.5 text-[11px] font-medium text-accent"

interface RuntimeBadgeProps {
  /** The conversation this composer writes into. */
  threadId?: string
  /**
   * Icon only, for the agent panel's 318 px footer row, where the words would
   * come out of the model selector's width. They stay in the DOM, hidden from
   * the eye and read out loud, which is where a narrow row keeps its words
   * (P6d-T08 made the same call for the runtime control). The hint on hover
   * still says them.
   */
  compact?: boolean
  /**
   * Where an attached produced file is staged: the same parent the composer's
   * `+` uses. Without it (and `onUploaded`) the rows open files and offer no
   * attach action.
   */
  parent?: FileParent | (() => Promise<FileParent>)
  onUploaded?: (row: FileRow) => void
  onError?: (err: unknown) => void
  /** The composer is disabled: attaching is too, opening a file is not. */
  disabled?: boolean
}

const RuntimeBadge: Component<RuntimeBadgeProps> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [open, setOpen] = createSignal(false)
  const live = () => localSessionFor(props.threadId ?? null, desktopState().agentId)
  const isLocal = () => desktopState().runtimeLocation === "local"
  const label = () => i18n.t(isLocal() ? RUNTIME_LABEL_LOCAL : RUNTIME_LABEL_LIAISON)
  const files = () => desktopState().producedFiles ?? []
  const canAttach = () =>
    api !== undefined && props.parent !== undefined && props.onUploaded !== undefined

  function openFile(produced: DesktopProducedFile) {
    void openLocalPath(produced.path).then((outcome) => {
      if (outcome === "opened") return
      const key =
        outcome === "not_found"
          ? "kernel.desktopUi.localPath.notFound"
          : outcome === "network"
            ? "kernel.desktopUi.localPath.network"
            : "kernel.desktopUi.localPath.failed"
      addToast({ message: i18n.t(key), type: "warning" })
    })
  }

  async function attach(produced: DesktopProducedFile) {
    const parentProp = props.parent
    const onUploaded = props.onUploaded
    if (!api || !parentProp || !onUploaded) return
    try {
      const blob = await readLocalFile(produced.path)
      // The shell refused, or the file is gone. Nothing to upload, and no
      // empty file invented to stand in for one.
      if (!blob) return
      const file = new File([blob], produced.name, {
        type: blob.type || "application/octet-stream",
      })
      const parent = typeof parentProp === "function" ? await parentProp() : parentProp
      const row = await uploadFile(api, file, parent, {
        disposition: file.type.startsWith("image/") ? "inline" : "attachment",
      })
      onUploaded(row)
    } catch (err) {
      props.onError?.(err)
    }
  }

  const icon = (): JSX.Element => (
    <Show when={isLocal()} fallback={<Cloud size={11} class="shrink-0" />}>
      <MonitorSmartphone size={11} class="shrink-0" />
    </Show>
  )

  /*
    Compact hides the words from the eye, never from a screen reader: an
    aria-label on a plain span is not supported by its role, and the words
    are the only thing that says which machine answered.
  */
  const words = (): JSX.Element => (
    <span class={props.compact ? "sr-only" : undefined}>{label()}</span>
  )

  return (
    <Show when={isDesktop() && live()}>
      <Show
        when={files().length > 0}
        fallback={
          <Tooltip content={label()} triggerClass={PILL_CLASS} data-testid="desktop-runtime-badge">
            {icon()}
            {words()}
          </Tooltip>
        }
      >
        <Tooltip
          content={i18n.t(PRODUCED_FILES_OPEN_LABEL)}
          triggerClass="shrink-0"
          data-testid="desktop-runtime-badge"
        >
          <PopupMenu open={open()} onOpenChange={setOpen}>
            <PopupMenu.Trigger
              aria-label={i18n.t(PRODUCED_FILES_OPEN_LABEL)}
              data-testid="desktop-produced-files-trigger"
              class={`${PILL_CLASS} transition-colors hover:bg-accent/20`}
            >
              {icon()}
              {words()}
              <span data-testid="desktop-produced-files-count" class="shrink-0 tabular-nums">
                {files().length}
              </span>
              <ChevronDown size={10} class="shrink-0" />
            </PopupMenu.Trigger>
            <PopupMenu.Content class="w-72" aria-label={i18n.t(PRODUCED_FILES_MENU_TITLE)}>
              <PopupMenu.Group>
                <PopupMenu.Label>{i18n.t(PRODUCED_FILES_MENU_TITLE)}</PopupMenu.Label>
              </PopupMenu.Group>
              <For each={files()}>
                {(produced) => (
                  <div class="flex items-center" data-testid="desktop-produced-file-row">
                    <PopupMenu.Item
                      class="min-w-0 flex-1"
                      onSelect={() => openFile(produced)}
                      textValue={produced.name}
                    >
                      <span class="min-w-0 flex-1 truncate" title={produced.path}>
                        {produced.name}
                      </span>
                    </PopupMenu.Item>
                    <Show when={canAttach()}>
                      <PopupMenu.Item
                        class="w-auto shrink-0 px-1.5"
                        onSelect={() => void attach(produced)}
                        textValue={`${produced.name} ${i18n.t(PRODUCED_FILES_ATTACH_LABEL)}`}
                        disabled={props.disabled}
                        aria-label={`${i18n.t(PRODUCED_FILES_ATTACH_LABEL)}: ${produced.name}`}
                        title={i18n.t(PRODUCED_FILES_ATTACH_LABEL)}
                        data-testid="desktop-produced-file-attach"
                      >
                        <Paperclip size={13} class="shrink-0" />
                      </PopupMenu.Item>
                    </Show>
                  </div>
                )}
              </For>
            </PopupMenu.Content>
          </PopupMenu>
        </Tooltip>
      </Show>
    </Show>
  )
}

export default RuntimeBadge
