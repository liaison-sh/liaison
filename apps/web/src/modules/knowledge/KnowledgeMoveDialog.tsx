// SPDX-License-Identifier: FSL-1.1-ALv2

import { Folder, Search } from "lucide-solid"
import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Dialog } from "~/ui/Dialog"
import type { MoveRequest } from "./KnowledgeCollectionTree"
import type { CollectionTreeNode } from "./knowledge-api"

/** Where an item can go. `collectionId` null: Unfiled (a page) or a section's top (a folder). */
export interface MoveTarget {
  collectionId: string | null
  /** The section it lands in: a folder of mine is Personal, any other Shared. */
  section: "personal" | "shared"
}

interface Option {
  key: string
  target: MoveTarget
  name: string
  path: string
}

/** Every real folder a page or folder may be filed into, with its path. */
function folderOptions(
  tree: readonly CollectionTreeNode[],
  me: string | null,
  exclude: string | null,
): Option[] {
  const out: Option[] = []
  const walk = (nodes: readonly CollectionTreeNode[], trail: string[]) => {
    for (const n of nodes) {
      if (n.virtual) continue
      // Nobody files into a synced tree, and a folder never goes into itself.
      if (n.syncedSourceId || n.id === exclude) continue
      out.push({
        key: n.id,
        target: {
          collectionId: n.id,
          section: me && n.ownerUserId === me ? "personal" : "shared",
        },
        name: n.name,
        path: trail.join(" / "),
      })
      walk(n.children, [...trail, n.name])
    }
  }
  walk(tree, [])
  return out
}

/**
 * The searchable "Move to…" list. Crossing between Personal and Shared asks
 * once more and says who will see the item (a folder does not change who sees
 * a page: the page keeps its own sharing).
 */
const KnowledgeMoveDialog: Component<{
  item: MoveRequest | null
  tree: readonly CollectionTreeNode[]
  me: string | null
  /** The item's place now. */
  current: MoveTarget
  onMove: (target: MoveTarget) => void
  onClose: () => void
}> = (props) => {
  const i18n = useI18n()
  const [query, setQuery] = createSignal("")
  const [confirming, setConfirming] = createSignal<Option | null>(null)

  const options = createMemo<Option[]>(() => {
    const item = props.item
    if (!item) return []
    // A page in Personal notes is in no folder already: "Unfiled" would
    // move it nowhere, so it is not offered.
    const inNotes =
      item.kind === "doc" &&
      props.current.collectionId === null &&
      props.current.section === "personal"
    const tops: Option[] =
      item.kind === "doc"
        ? inNotes
          ? []
          : [
              {
                key: "root",
                target: { collectionId: null, section: "shared" },
                name: i18n.t("knowledge.unfiled"),
                path: "",
              },
            ]
        : [
            {
              key: "personal-root",
              target: { collectionId: null, section: "personal" },
              name: i18n.t("knowledge.personalTopLevel"),
              path: "",
            },
            {
              key: "shared-root",
              target: { collectionId: null, section: "shared" },
              name: i18n.t("knowledge.sharedTopLevel"),
              path: "",
            },
          ]
    const q = query().trim().toLowerCase()
    return [
      ...tops,
      ...folderOptions(props.tree, props.me, item.kind === "folder" ? item.id : null),
    ].filter((o) => !q || `${o.path} ${o.name}`.toLowerCase().includes(q))
  })

  const isHere = (o: Option) =>
    o.target.collectionId === props.current.collectionId &&
    (o.target.collectionId !== null ||
      props.item?.kind === "doc" ||
      o.target.section === props.current.section)

  function pick(o: Option) {
    if (isHere(o)) return
    if (o.target.section !== props.current.section) setConfirming(o)
    else props.onMove(o.target)
  }

  const audienceText = (o: Option) =>
    props.item?.kind === "doc"
      ? i18n.t("knowledge.moveKeepsPageSharing")
      : o.target.section === "personal"
        ? i18n.t("knowledge.moveFolderToPersonal")
        : i18n.t("knowledge.moveFolderToShared")

  return (
    <Dialog
      open={props.item !== null}
      onOpenChange={(open) => {
        if (!open) {
          setQuery("")
          setConfirming(null)
          props.onClose()
        }
      }}
    >
      <Dialog.Content>
        <div data-testid="knowledge-move-dialog">
          <Dialog.Title>
            {i18n.t("knowledge.moveItem", { name: props.item?.title ?? "" })}
          </Dialog.Title>
          <Show
            when={confirming()}
            fallback={
              <>
                <div class="mt-4 flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5">
                  <Search size={13} class="shrink-0 text-text-tertiary" />
                  <input
                    type="text"
                    data-testid="knowledge-move-search"
                    aria-label={i18n.t("knowledge.findAFolder")}
                    placeholder={i18n.t("knowledge.findAFolder")}
                    autofocus
                    value={query()}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                    class="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
                  />
                </div>
                <div class="mt-2 max-h-64 overflow-y-auto">
                  <For
                    each={options()}
                    fallback={
                      <p class="px-3 py-2 text-[13px] text-text-tertiary">
                        {i18n.t("knowledge.noFolderWithThatName")}
                      </p>
                    }
                  >
                    {(o) => (
                      <button
                        type="button"
                        data-testid={`knowledge-move-to-${o.key}`}
                        disabled={isHere(o)}
                        onClick={() => pick(o)}
                        class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left outline-none hover:bg-surface-hover focus-visible:bg-surface-hover disabled:opacity-50"
                      >
                        <Folder size={13} class="shrink-0 text-text-tertiary" />
                        <span class="min-w-0 flex-1 truncate text-[13px] text-text">{o.name}</span>
                        <span class="truncate text-[12px] text-text-tertiary">
                          {isHere(o) ? i18n.t("knowledge.hereNow") : o.path}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
                <div class="mt-4 flex justify-end">
                  <button
                    type="button"
                    data-testid="knowledge-move-cancel"
                    onClick={() => props.onClose()}
                    class="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-surface-hover"
                  >
                    {i18n.t("kernel.common.cancel")}
                  </button>
                </div>
              </>
            }
          >
            {(o) => (
              <>
                <Dialog.Description>
                  <span data-testid="knowledge-move-audience">{audienceText(o())}</span>
                </Dialog.Description>
                <div class="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    data-testid="knowledge-move-back"
                    onClick={() => setConfirming(null)}
                    class="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-surface-hover"
                  >
                    {i18n.t("knowledge.back")}
                  </button>
                  <button
                    type="button"
                    data-testid="knowledge-move-confirm"
                    onClick={() => props.onMove(o().target)}
                    class="rounded-md bg-accent px-3 py-1.5 text-[12px] text-white transition-colors hover:opacity-90"
                  >
                    {i18n.t("knowledge.move")}
                  </button>
                </div>
              </>
            )}
          </Show>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

export default KnowledgeMoveDialog
