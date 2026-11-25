// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The header of a Knowledge page: its title (editable in place for whoever may
// edit), its badges, who edited it last, and on the right the save state, the
// writing helpers, references, Share and the page's actions. There is no Edit
// and no Save: a page saves itself.

import {
  ArrowLeftRight,
  CheckCircle,
  FileText,
  History,
  MessageSquare,
  MoreHorizontal,
  Share2,
  Trash2,
} from "lucide-solid"
import { type Component, createSignal, For, Show } from "solid-js"
import { rovingFocus } from "~/lib/roving-focus"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import type { useDictation } from "~/modules/assist/useDictation"
import type { RichEditorHandle } from "~/modules/editor"
import { useI18n } from "~/modules/i18n/i18n-context"
import { openTab } from "~/modules/shell/tab-store"
import { FloatingPanel } from "~/ui/FloatingPanel"
import { OverlaySheet } from "~/ui/OverlaySheet"
import type { SaverStatus } from "./autosave"
import Breadcrumb from "./Breadcrumb"
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
  /** The "Linked from" list was opened: it is asked again. */
  onBacklinksOpen?: () => void
  dictation: ReturnType<typeof useDictation>
  editor: () => RichEditorHandle | undefined
  titleRef: (el: HTMLHeadingElement) => void
  onTitleInput: () => void
  onTitleDone: () => void
  onShare: () => void
  onHistory: () => void
  onVerify: () => void
  /** "Move to trash" is offered (archive scope, edit right, not a synced page). */
  canTrash: boolean
  onTrash: () => void
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
        <Breadcrumb docId={props.doc.id} />
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
          <BacklinksButton
            backlinks={props.backlinks}
            phone={props.phone}
            onOpen={props.onBacklinksOpen}
          />
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

/** A page that links here (else a conversation that references the page). */
function isPageBacklink(link: KnowledgeBacklink): boolean {
  return link.kind
    ? link.kind === "page"
    : link.app === "knowledge" && link.entityType === "document"
}

/** Open what links here in its own tab. */
function openBacklink(link: KnowledgeBacklink): void {
  if (isPageBacklink(link)) {
    openTab({ type: "knowledge:document", entityId: link.entityId, label: link.title })
  } else openTab({ type: "kernel:thread", entityId: link.entityId, label: link.title })
}

const BacklinksButton: Component<{
  backlinks: KnowledgeBacklink[]
  phone: boolean
  onOpen?: () => void
}> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const pages = () => props.backlinks.filter(isPageBacklink)
  const threads = () => props.backlinks.filter((l) => !isPageBacklink(l))
  const show = (next: boolean) => {
    setOpen(next)
    if (next) props.onOpen?.()
  }
  const label = () =>
    props.backlinks.length === 1
      ? i18n.t("knowledge.autosave.oneReference")
      : i18n.t("knowledge.autosave.references", { count: props.backlinks.length })
  const heading = (text: string) => (
    <div class="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
      {text}
    </div>
  )
  const row = (link: KnowledgeBacklink) => (
    <button
      type="button"
      data-roving
      data-testid={isPageBacklink(link) ? "knowledge-backlink-page" : "knowledge-backlink-thread"}
      data-entity-id={link.entityId}
      onClick={() => {
        setOpen(false)
        openBacklink(link)
      }}
      class={`flex w-full items-center gap-2 px-3 text-left hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none ${props.phone ? "min-h-11" : "py-1.5"}`}
    >
      {isPageBacklink(link) ? (
        <FileText size={13} class="shrink-0 text-text-tertiary" />
      ) : (
        <MessageSquare size={13} class="shrink-0 text-text-tertiary" />
      )}
      <span class="truncate text-[13px] text-text">
        {link.title || i18n.t("knowledge.untitled")}
      </span>
    </button>
  )
  const list = () => (
    <div data-testid="knowledge-backlinks-panel" onKeyDown={rovingFocus}>
      <Show when={pages().length > 0}>
        {heading(i18n.t("knowledge.links.linkedFrom"))}
        <For each={pages()}>{row}</For>
      </Show>
      <Show when={threads().length > 0}>
        {heading(i18n.t("knowledge.links.conversations"))}
        <For each={threads()}>{row}</For>
      </Show>
    </div>
  )
  const trigger =
    "flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
  return (
    <Show
      when={!props.phone}
      fallback={
        <>
          <button
            type="button"
            data-testid="knowledge-backlinks-button"
            aria-haspopup="dialog"
            class={`${trigger} min-h-11`}
            onClick={() => show(true)}
          >
            <ArrowLeftRight size={12} />
            {label()}
          </button>
          <OverlaySheet
            open={open()}
            onClose={() => setOpen(false)}
            variant="bottom"
            title={i18n.t("knowledge.links.linkedFrom")}
            closeLabel={i18n.t("kernel.close")}
          >
            <div class="py-2">{list()}</div>
          </OverlaySheet>
        </>
      }
    >
      <FloatingPanel open={open()} onOpenChange={show}>
        <FloatingPanel.Trigger data-testid="knowledge-backlinks-button" class={trigger}>
          <ArrowLeftRight size={12} />
          {label()}
        </FloatingPanel.Trigger>
        <FloatingPanel.Content class="w-64 py-2">{list()}</FloatingPanel.Content>
      </FloatingPanel>
    </Show>
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
        <button
          type="button"
          data-roving
          data-testid="knowledge-doc-verify"
          class={MENU_ITEM}
          onClick={run(() => props.onVerify())}
        >
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
        <Show when={props.canTrash}>
          <div class="my-1 h-px bg-border-subtle" />
          <button
            type="button"
            data-roving
            data-testid="knowledge-doc-trash"
            class={MENU_ITEM}
            onClick={run(() => props.onTrash())}
          >
            <Trash2 size={14} />
            {i18n.t("knowledge.trash.moveToTrash")}
          </button>
        </Show>
      </FloatingPanel.Content>
    </FloatingPanel>
  )
}

export default PageHeader
