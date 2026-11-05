// SPDX-License-Identifier: FSL-1.1-ALv2

import { Pencil, Smile } from "lucide-solid"
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { tNow, useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import {
  FAVORITE_EMOJI_MAX,
  favoriteEmoji,
  hydrateFavoriteEmoji,
  isFavoriteEmoji,
  toggleFavoriteEmoji,
} from "~/modules/threads/favorite-emoji"
import { FloatingPanel } from "~/ui/FloatingPanel"

interface EmojiEntry {
  emoji: string
  /** Lowercased CLDR name and slug, the search haystack. */
  search: string
}

interface EmojiGroup {
  slug: string
  emojis: EmojiEntry[]
}

interface DatasetGroup {
  slug: string
  emojis: Array<{ emoji: string; name: string; slug: string }>
}

// The full Unicode emoji list (unicode-emoji-json, MIT, ~420 KB of JSON,
// ~32 KB gzipped). A dynamic import keeps it in its own chunk, fetched the
// first time a picker opens, never in the main bundle.
let emojiGroups: Promise<EmojiGroup[]> | null = null
function loadEmojiGroups(): Promise<EmojiGroup[]> {
  emojiGroups ??= import("unicode-emoji-json/data-by-group.json")
    .then((mod) =>
      (mod.default as DatasetGroup[]).map((group) => ({
        slug: group.slug,
        emojis: group.emojis.map((e) => ({
          emoji: e.emoji,
          search: `${e.name} ${e.slug}`.toLowerCase(),
        })),
      })),
    )
    .catch((err) => {
      emojiGroups = null
      throw err
    })
  return emojiGroups
}

const MAX_NAMED_REACTORS = 5

/**
 * The hover text of a reaction chip (S15): "You, Alice, Bob and 3 others".
 * The viewer comes first as You/Vous, at most five names are shown, and the
 * rest are counted from `count` (the server's total).
 */
export function reactorsLabel(
  users: ReadonlyArray<{ id: string; name: string }>,
  count: number,
  currentUserId: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const names = [
    ...(users.some((u) => u.id === currentUserId) ? [t("kernel.threadsUi.reactorsYou")] : []),
    ...users.filter((u) => u.id !== currentUserId).map((u) => u.name),
  ]
  const shown = names.slice(0, MAX_NAMED_REACTORS)
  const rest = Math.max(count, names.length) - shown.length
  if (shown.length === 0) return ""
  if (rest <= 0) {
    if (shown.length === 1) return shown[0]
    return t("kernel.threadsUi.reactorsList", {
      list: shown.slice(0, -1).join(", "),
      last: shown[shown.length - 1],
    })
  }
  const list = shown.join(", ")
  return rest === 1
    ? t("kernel.threadsUi.reactorsOthersOne", { list })
    : t("kernel.threadsUi.reactorsOthersMany", { list, count: rest })
}

interface ReactionPickerProps {
  onSelect: (emoji: string) => void
}

const cellClass =
  "flex h-8 w-8 items-center justify-center rounded-md text-[18px] transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"

/**
 * The picker's body: the favourites (editable) and the searchable full list.
 * The hover toolbar shows it in a floating panel; a touch device, which has
 * no hover, shows it in the message's long-press sheet.
 */
export const ReactionPickerBody: Component<{ onReact: (emoji: string) => void }> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [query, setQuery] = createSignal("")
  // Edit mode: a click pins or unpins instead of reacting.
  const [editing, setEditing] = createSignal(false)
  const [groups] = createResource(loadEmojiGroups)
  void hydrateFavoriteEmoji(api)

  const filtered = createMemo(() => {
    const all = groups() ?? []
    const q = query().trim().toLowerCase()
    if (!q) return all
    return all
      .map((g) => ({
        slug: g.slug,
        emojis: g.emojis.filter((e) => e.search.includes(q) || e.emoji === q),
      }))
      .filter((g) => g.emojis.length > 0)
  })

  const full = () => favoriteEmoji().length >= FAVORITE_EMOJI_MAX

  return (
    <>
      <div class="mb-1 flex items-center justify-between px-1">
        <span class="text-[11px] font-medium text-text-secondary">
          {i18n.t("kernel.threadsUi.favoriteEmoji")}
        </span>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          aria-pressed={editing()}
          aria-label={i18n.t("kernel.threadsUi.editFavoriteEmoji")}
          title={i18n.t("kernel.threadsUi.editFavoriteEmoji")}
          class={`flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-surface-hover ${
            editing() ? "bg-accent/10 text-accent" : "text-text-secondary"
          }`}
        >
          <Pencil size={12} />
        </button>
      </div>
      <div data-testid="reaction-favorites" class="grid grid-cols-9 gap-0.5">
        <For each={favoriteEmoji()}>
          {(emoji) => (
            <button
              type="button"
              onClick={() => (editing() ? toggleFavoriteEmoji(api, emoji) : props.onReact(emoji))}
              class={`${cellClass} ${editing() ? "ring-1 ring-accent/40" : ""}`}
              aria-label={
                editing()
                  ? tNow("kernel.threadsUi.unpinEmoji", { emoji })
                  : tNow("kernel.threadsUi.reactWith", { emoji })
              }
            >
              {emoji}
            </button>
          )}
        </For>
      </div>
      <Show when={editing() && full()}>
        <p class="px-1 pt-1 text-[11px] text-text-secondary">
          {i18n.t("kernel.threadsUi.favoriteEmojiFull")}
        </p>
      </Show>

      <input
        type="search"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
        placeholder={i18n.t("kernel.threadsUi.searchEmoji")}
        aria-label={i18n.t("kernel.threadsUi.searchEmoji")}
        class="mt-1.5 w-full rounded-md border border-border-subtle bg-surface px-2 py-1 text-[13px] outline-none focus:border-accent"
      />

      <div class="mt-1 max-h-64 overflow-y-auto">
        <Show
          when={groups()}
          fallback={
            <p class="px-1 py-2 text-[12px] text-text-secondary">
              {i18n.t("kernel.threadsUi.loadingEmoji")}
            </p>
          }
        >
          <Show
            when={filtered().length > 0}
            fallback={
              <p class="px-1 py-2 text-[12px] text-text-secondary">
                {i18n.t("kernel.threadsUi.noEmojiFound")}
              </p>
            }
          >
            <For each={filtered()}>
              {(group) => (
                <section data-testid={`reaction-group-${group.slug}`}>
                  <h3 class="sticky top-0 bg-surface px-1 py-1 text-[11px] font-medium text-text-secondary">
                    {i18n.t(`kernel.threadsUi.emojiGroups.${group.slug}`)}
                  </h3>
                  <div class="grid grid-cols-9 gap-0.5">
                    <For each={group.emojis}>
                      {(entry) => {
                        const pinned = () => isFavoriteEmoji(entry.emoji)
                        return (
                          <button
                            type="button"
                            disabled={editing() && !pinned() && full()}
                            onClick={() =>
                              editing()
                                ? toggleFavoriteEmoji(api, entry.emoji)
                                : props.onReact(entry.emoji)
                            }
                            class={`${cellClass} ${editing() && pinned() ? "bg-accent/10" : ""}`}
                            aria-label={
                              !editing()
                                ? tNow("kernel.threadsUi.reactWith", { emoji: entry.emoji })
                                : pinned()
                                  ? tNow("kernel.threadsUi.unpinEmoji", { emoji: entry.emoji })
                                  : tNow("kernel.threadsUi.pinEmoji", { emoji: entry.emoji })
                            }
                          >
                            {entry.emoji}
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </section>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </>
  )
}

const ReactionPicker: Component<ReactionPickerProps> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)

  return (
    <FloatingPanel open={open()} onOpenChange={setOpen}>
      <FloatingPanel.Trigger
        class="flex h-6 w-6 items-center justify-center rounded bg-surface shadow-sm ring-1 ring-border-subtle hover:bg-surface-hover"
        aria-label={i18n.t("kernel.addReaction")}
      >
        <Smile size={14} class="text-text-secondary" />
      </FloatingPanel.Trigger>
      <FloatingPanel.Content class="w-[320px] max-w-[calc(100vw-32px)] p-1.5">
        <ReactionPickerBody
          onReact={(emoji) => {
            props.onSelect(emoji)
            setOpen(false)
          }}
        />
      </FloatingPanel.Content>
    </FloatingPanel>
  )
}

export default ReactionPicker
