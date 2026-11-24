// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The header of a Knowledge page: its title (editable in place for whoever may
// edit), its badges, who edited it last, and on the right the save state, the
// writing helpers, references, Share and the page's actions. There is no Edit
// and no Save: a page saves itself.

import {
  Archive,
  ArchiveRestore,
  ArrowLeftRight,
  CheckCircle,
  History,
  MoreHorizontal,
  Share2,
} from "lucide-solid"
import { type Component, createSignal, For, Show } from "solid-js"
import { rovingFocus } from "~/lib/roving-focus"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import type { useDictation } from "~/modules/assist/useDictation"
import type { RichEditorHandle } from "~/modules/editor"
import { useI18n } from "~/modules/i18n/i18n-context"
import { FloatingPanel } from "~/ui/FloatingPanel"
import type { SaverStatus } from "./autosave"
import type { KnowledgeBacklink } from "./knowledge-api"

export interface PageHeaderDoc {
  id: string
  title: string
  reviewStatus?: string
  documentScope?: "personal" | "organization"
  sensitivity?: string
  status?: string
}

export interface PageHeaderProps {
  doc: PageHeaderDoc
  /** The title and the text are edited in place (the editor is mounted). */
  editable: boolean
  /** The page's history can be opened (edit right, not a synced page). */
  hasHistory: boolean
  phone: boolean
  status: SaverStatus
  /** "Edited by X, 2 minutes ago", when known. */
  edited: string | null
  backlinks: KnowledgeBacklink[]
  dictation: ReturnType<typeof useDictation>
  editor: () => RichEditorHandle | undefined
  titleRef: (el: HTMLHeadingElement) => void
  onTitleInput: () => void
  onTitleDone: () => void
  onShare: () => void
  onHistory: () => void
  onVerify: () => void
  onArchive: () => void
  onRestore: () => void
}

const REVIEW_KEYS: Record<string, string> = {
  verified: "knowledge.autosave.reviewVerified",
  unverified: "knowledge.autosave.reviewUnverified",
  needs_review: "knowledge.autosave.reviewNeedsReview",
  stale: "knowledge.autosave.reviewStale",
}

const SCOPE_KEYS: Record<string, string> = {
  personal: "knowledge.personal",
  internal: "knowledge.internal",
  confidential: "knowledge.confidential",
}

const MENU_ITEM =
  "flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"

/** Saving, Saved, or Not saved with the reason (S6). */
export const SaveState: Component<{ status: SaverStatus }> = (props) => {
  const i18n = useI18n()
  const reason = () => {
    const s = props.status
    switch (s.state) {
      case "offline":
        return i18n.t("knowledge.autosave.reasonOffline")
      case "error":
        return i18n.t("knowledge.autosave.reasonError")
      case "too-large":
        return i18n.t("knowledge.autosave.reasonTooLarge", {
          size: (s.size ?? 0).toLocaleString(i18n.locale()),
        })
      case "no-access":
        return i18n.t("knowledge.autosave.reasonNoAccess")
      case "title-too-long":
        return i18n.t("knowledge.autosave.reasonTitleTooLong", {
          size: (s.size ?? 0).toLocaleString(i18n.locale()),
        })
      case "rejected":
        return s.message
          ? i18n.t("knowledge.autosave.reasonRejected", { message: s.message })
          : i18n.t("knowledge.autosave.reasonRejectedPlain")
      case "conflict":
        return i18n.t("knowledge.autosave.reasonConflict")
      default:
        return null
    }
  }
  const text = () => {
    const r = reason()
    if (r) return i18n.t("knowledge.autosave.notSaved", { reason: r })
    const state = props.status.state
    return state === "dirty" || state === "saving"
      ? i18n.t("knowledge.saving")
      : i18n.t("knowledge.autosave.saved")
  }
  return (
    <span
      data-testid="save-state"
      data-state={props.status.state}
      role="status"
      class="min-w-0 truncate px-1 text-[12px]"
      classList={{ "text-warning": reason() !== null, "text-text-tertiary": reason() === null }}
    >
      {text()}
    </span>
  )
}

export const PageHeader: Component<PageHeaderProps> = (props) => {
  const i18n = useI18n()
  const review = () => {
    const status = props.doc.reviewStatus
    if (!status || props.doc.documentScope === "personal") return null
    const key = REVIEW_KEYS[status]
    return key ? i18n.t(key) : null
  }
  const scope = () => {
    const value = props.doc.sensitivity ?? props.doc.documentScope
    if (!value) return null
    const key = SCOPE_KEYS[value]
    return key ? i18n.t(key) : value
  }

  return (
    <div
      data-testid="knowledge-doc-header"
      class="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-2.5"
    >
      <div class="flex min-w-0 flex-col gap-0.5">
        <h1
          ref={props.titleRef}
          data-testid="knowledge-doc-title"
          contenteditable={props.editable ? "true" : "false"}
          role={props.editable ? "textbox" : undefined}
          aria-label={props.editable ? i18n.t("knowledge.autosave.titleLabel") : undefined}
          spellcheck={false}
          class="truncate text-[15px] font-semibold text-text outline-none focus:rounded-sm focus:ring-1 focus:ring-accent/20"
          onInput={() => props.onTitleInput()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault()
              props.onTitleDone()
            }
          }}
        />
        <div class="flex flex-wrap items-center gap-1.5">
          <Show when={review()}>
            {(label) => (
              <span
                data-testid="knowledge-doc-review-status"
                class="rounded bg-surface-hover px-1.5 text-[11px] text-text-secondary"
              >
                {label()}
              </span>
            )}
          </Show>
          <Show when={scope()}>
            {(label) => (
              <span
                data-testid="knowledge-doc-scope-badge"
                class="rounded bg-surface-hover px-1.5 text-[11px] text-text-secondary"
              >
                {label()}
              </span>
            )}
          </Show>
          <Show when={props.doc.status === "archived"}>
            <span
              data-testid="knowledge-doc-archived-badge"
              class="rounded bg-surface-hover px-1.5 text-[11px] text-warning"
            >
              {i18n.t("knowledge.archived")}
            </span>
          </Show>
          {/* On a phone the save state sits under the title, the right side is short. */}
          <Show when={props.editable && props.phone}>
            <SaveState status={props.status} />
          </Show>
          <Show when={props.edited && !props.phone}>
            <span data-testid="knowledge-doc-edited" class="text-[12px] text-text-tertiary">
              {props.edited}
            </span>
          </Show>
        </div>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <Show when={props.editable && !props.phone}>
          <SaveState status={props.status} />
        </Show>
        <Show when={props.backlinks.length > 0}>
          <BacklinksButton backlinks={props.backlinks} />
        </Show>
        <Show when={props.editable}>
          <RecorderRow dictation={props.dictation} barClass="w-[18rem] max-w-[60vw]">
            <ComposerAssist target={props.editor} />
            <DictationMic dictation={props.dictation} />
          </RecorderRow>
        </Show>
        <button
          type="button"
          data-testid="knowledge-share-button"
          aria-label={i18n.t("knowledge.share")}
          onClick={() => props.onShare()}
          class="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
        >
          <Share2 size={14} />
        </button>
        <PageMenu {...props} />
      </div>
    </div>
  )
}

const BacklinksButton: Component<{ backlinks: KnowledgeBacklink[] }> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  return (
    <FloatingPanel open={open()} onOpenChange={setOpen}>
      <FloatingPanel.Trigger class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-text-tertiary hover:bg-surface-hover hover:text-text-secondary">
        <ArrowLeftRight size={12} />
        {props.backlinks.length === 1
          ? i18n.t("knowledge.autosave.oneReference")
          : i18n.t("knowledge.autosave.references", { count: props.backlinks.length })}
      </FloatingPanel.Trigger>
      <FloatingPanel.Content class="w-64 py-2">
        <div class="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
          {i18n.t("knowledge.referencedBy")}
        </div>
        <For each={props.backlinks}>
          {(link) => (
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-hover"
            >
              <span class="text-[11px] text-text-tertiary">
                {link.app}:{link.entityType}
              </span>
              <span class="truncate text-[13px] text-text">{link.title}</span>
            </button>
          )}
        </For>
      </FloatingPanel.Content>
    </FloatingPanel>
  )
}

const PageMenu: Component<PageHeaderProps> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  /** An item closes the menu first, then acts. */
  const run = (action: () => void) => () => {
    setOpen(false)
    action()
  }
  return (
    <FloatingPanel open={open()} onOpenChange={setOpen}>
      <FloatingPanel.Trigger
        data-testid="knowledge-doc-menu"
        aria-label={i18n.t("knowledge.autosave.pageActions")}
        class="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
      >
        <MoreHorizontal size={16} />
      </FloatingPanel.Trigger>
      <FloatingPanel.Content class="w-48" onKeyDown={rovingFocus}>
        <button type="button" data-roving class={MENU_ITEM} onClick={run(() => props.onVerify())}>
          <CheckCircle size={14} />
          {i18n.t("knowledge.verify")}
        </button>
        <Show when={props.hasHistory}>
          <button
            type="button"
            data-roving
            data-testid="knowledge-doc-history"
            class={MENU_ITEM}
            onClick={run(() => props.onHistory())}
          >
            <History size={14} />
            {i18n.t("knowledge.autosave.history")}
          </button>
        </Show>
        <div class="my-1 h-px bg-border-subtle" />
        <Show
          when={props.doc.status === "archived"}
          fallback={
            <button
              type="button"
              data-roving
              class={MENU_ITEM}
              onClick={run(() => props.onArchive())}
            >
              <Archive size={14} />
              {i18n.t("kernel.common.archive")}
            </button>
          }
        >
          <button
            type="button"
            data-roving
            class={MENU_ITEM}
            onClick={run(() => props.onRestore())}
          >
            <ArchiveRestore size={14} />
            {i18n.t("kernel.common.restore")}
          </button>
        </Show>
      </FloatingPanel.Content>
    </FloatingPanel>
  )
}

export default PageHeader
