// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Calm Knowledge home: a single recently-touched feed, a conditional
 * "Needs review" filter strip, and one primary CTA — "Create knowledge
 * from…" — that opens the personal agent DM (dock tab, or the thread tab on
 * Home) and posts one viewer-authored message asking to discuss it, rather
 * than a full-screen tab. The stat-card grid and per-connector "Connect
 * Drive" CTAs are gone; connector auth lives in `AdminIntegrations`
 * (settings). The "Recently touched" feed refreshes live as the agent
 * creates/updates documents (see exports.ts's `handleKnowledgeDocumentWsEvent`).
 */
import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-solid"
import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab } from "~/modules/shell/tab-store"
import { discussWithPersonalAgent } from "~/modules/threads/personal-dm-store"
import { Button } from "~/ui/Button"
import { ScrollFade } from "~/ui/ScrollFade"
import type { CollectionTreeNode } from "./knowledge-api"
import { knowledgeStore, loadCollectionsTree } from "./knowledge-store"

/** The route the tab store opens for Knowledge home (`knowledge-tabs.ts`'s
 *  `knowledge:home` registration). */
const KNOWLEDGE_HOME_LINK = "/knowledge"

/** The CTA's own label: there is no single knowledge source selected on this
 *  list view, so the discuss message names the action itself. */
const CREATE_FROM_LABEL = "Create knowledge from…"

interface RecentDoc {
  id: string
  title: string
  // Clean, user-facing title computed by the API (falls back to a humanized
  // filename when the stored title is a raw import filename). Prefer it over
  // the raw `title` so "11-presets.md" never leaks into the list.
  displayTitle?: string
  updatedAt?: string
  reviewStatus?: string
}

/** The label to show for a recent doc: the API's clean display title, else the raw title. */
function recentDocLabel(doc: RecentDoc): string {
  return doc.displayTitle?.trim() || doc.title
}

const KnowledgeHome: Component = () => {
  const api = useApi()
  const i18n = useI18n()
  const [filtered, setFiltered] = createSignal(false)
  const phone = () => shellTier() === "phone"

  // At phone width the collections tree has no sidebar column to live in, so
  // this screen carries it: the collections ARE the first thing a phone reader
  // navigates by, and the recent feed alone leaves them unreachable.
  onMount(() => {
    if (phone() && knowledgeStore.collectionsTree.length === 0) void loadCollectionsTree(api)
  })

  function openCreateKnowledge(): void {
    void discussWithPersonalAgent({ title: CREATE_FROM_LABEL, link: KNOWLEDGE_HOME_LINK }, api)
  }

  const recent = createMemo<RecentDoc[]>(
    () => (knowledgeStore.homeData?.recent ?? []) as RecentDoc[],
  )
  const needsReview = createMemo<RecentDoc[]>(
    () => (knowledgeStore.homeData?.needsReview ?? []) as RecentDoc[],
  )
  const reviewCount = createMemo(() => needsReview().length)

  const rows = createMemo<RecentDoc[]>(() => (filtered() ? needsReview() : recent()))

  function openDoc(doc: RecentDoc) {
    openTab({ type: "knowledge:document", entityId: doc.id, label: recentDocLabel(doc) })
  }

  const collections = createMemo(() => knowledgeStore.collectionsTree)

  return (
    <ScrollFade class="min-h-0 flex-1" fadeColor="var(--color-bg)">
      <div
        data-testid="knowledge-home"
        class={phone() ? "w-full px-4 py-4" : "mx-auto w-full max-w-2xl px-8 py-10"}
      >
        {/* Primary action */}
        {/* Wraps rather than squeezes: at phone width the 32px title and the
            CTA do not fit one line, and the button used to fold onto two
            lines against the title's edge. */}
        <div
          data-testid="knowledge-home-header"
          class="mb-6 flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
        >
          <Show
            when={phone()}
            fallback={
              <h1 class="text-[15px] font-medium text-text">{i18n.t("knowledge.knowledge")}</h1>
            }
          >
            <h1
              data-testid="knowledge-title"
              class="font-display text-[32px] font-semibold leading-tight text-text"
            >
              {i18n.t("kernel.knowledgeTitle")}
            </h1>
          </Show>
          <Button
            data-testid="knowledge-home-create-from-cta"
            size="sm"
            class="shrink-0 whitespace-nowrap"
            onClick={openCreateKnowledge}
          >
            {i18n.t("knowledge.createKnowledgeFrom")}
          </Button>
        </div>

        {/* Needs-review filter — only when there are items to review */}
        <Show when={reviewCount() > 0}>
          <button
            type="button"
            data-testid="knowledge-home-needs-review-filter"
            aria-pressed={filtered() ? "true" : "false"}
            onClick={() => setFiltered((v) => !v)}
            class={`mb-3 inline-flex items-center gap-2 rounded-md border border-border-subtle px-3 py-1.5 text-[12px] outline-none transition-colors ${
              filtered()
                ? "bg-surface-hover text-text"
                : "text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
            }`}
          >
            <span>{i18n.t("knowledge.needsReview")}</span>
            <span class="rounded-full bg-surface px-2 py-0.5 text-[11px]">{reviewCount()}</span>
            <Show when={filtered()}>
              <span class="text-text-tertiary">{i18n.t("knowledge.showing")}</span>
            </Show>
          </button>
        </Show>

        {/* Collections, phone only: the sidebar's tree as grouped rows. */}
        <Show when={phone() && collections().length > 0}>
          <section data-testid="knowledge-home-collections" class="mb-6">
            <h2 class="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
              {i18n.t("kernel.knowledgeCollections")}
            </h2>
            <For each={collections()}>{(node) => <CollectionRow node={node} />}</For>
          </section>
        </Show>

        {/* Recently touched */}
        <section data-testid="knowledge-home-recently-touched">
          <h2 class="mb-3 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
            {filtered() ? i18n.t("knowledge.needingReview") : i18n.t("knowledge.recentlyTouched")}
          </h2>
          <Show
            when={rows().length > 0}
            fallback={
              <p data-testid="knowledge-home-empty" class="text-[13px] text-text-tertiary">
                {i18n.t("knowledge.nothingHereYetClickCreateKnowledge")}
              </p>
            }
          >
            <ul class="flex flex-col gap-1">
              <For each={rows()}>
                {(doc) => (
                  <li>
                    <Show
                      when={phone()}
                      fallback={
                        <button
                          type="button"
                          data-testid={`knowledge-recent-${doc.id}`}
                          data-document-id={doc.id}
                          data-doc-title={doc.title}
                          class="flex w-full items-center justify-between rounded-md px-3 py-2 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
                          onClick={() => openDoc(doc)}
                          title={recentDocLabel(doc)}
                        >
                          <span class="truncate text-[13px] text-text">{recentDocLabel(doc)}</span>
                          <Show
                            when={
                              doc.reviewStatus === "needs_review" || doc.reviewStatus === "stale"
                            }
                          >
                            <span class="ml-2 text-[11px] text-text-tertiary">
                              {doc.reviewStatus}
                            </span>
                          </Show>
                        </button>
                      }
                    >
                      <button
                        type="button"
                        data-testid={`knowledge-recent-${doc.id}`}
                        data-document-id={doc.id}
                        data-doc-title={doc.title}
                        class="flex h-[52px] w-full items-center gap-3 text-left outline-none hover:bg-surface-hover"
                        onClick={() => openDoc(doc)}
                      >
                        <FileText size={16} class="shrink-0 text-text-tertiary" />
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-[16px] text-text">
                            {recentDocLabel(doc)}
                          </span>
                          <Show when={doc.updatedAt}>
                            <span class="block truncate text-[12px] text-text-secondary">
                              {formatUpdated(doc.updatedAt)}
                            </span>
                          </Show>
                        </span>
                        <ChevronRight size={16} class="shrink-0 text-text-tertiary" />
                      </button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </div>
    </ScrollFade>
  )
}

/** One collection at phone width: a row that opens in place and lists the
 *  documents it holds, because a collection has no tab of its own. */
const CollectionRow: Component<{ node: CollectionTreeNode }> = (props) => {
  const [open, setOpen] = createSignal(false)
  return (
    <>
      <button
        type="button"
        data-testid={`knowledge-collection-${props.node.id}`}
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen((v) => !v)}
        class="flex h-[46px] w-full items-center gap-3 text-left text-[16px] text-text hover:bg-surface-hover"
      >
        <Folder size={16} class="shrink-0 text-text-tertiary" />
        <span class="min-w-0 flex-1 truncate">{props.node.name}</span>
        <Show when={open()} fallback={<ChevronRight size={16} class="text-text-tertiary" />}>
          <ChevronDown size={16} class="text-text-tertiary" />
        </Show>
      </button>
      <Show when={open()}>
        <For each={props.node.documents}>
          {(doc) => (
            <button
              type="button"
              data-testid={`knowledge-collection-doc-${doc.id}`}
              onClick={() =>
                openTab({ type: "knowledge:document", entityId: doc.id, label: doc.title })
              }
              class="flex h-[46px] w-full items-center gap-3 pl-8 text-left text-[15px] text-text hover:bg-surface-hover"
            >
              <FileText size={15} class="shrink-0 text-text-tertiary" />
              <span class="min-w-0 flex-1 truncate">{doc.title}</span>
            </button>
          )}
        </For>
      </Show>
    </>
  )
}

/** The updated line on a phone document row. Absolute and short: a phone list
 *  is read at a glance, and "2 days ago" and a date cost the same space. */
export function formatUpdated(iso?: string): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
}

export default KnowledgeHome
