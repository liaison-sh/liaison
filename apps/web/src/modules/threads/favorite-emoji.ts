// SPDX-License-Identifier: FSL-1.1-ALv2
// The reaction picker's favourites row (S16).
//
// Server-persisted through the dedicated `PUT /user/preferences/favorite-emoji`
// partial endpoint, never the full-replace `PUT /user/preferences` (the trap
// home-card-layout.ts documents). Read once per session, lazily, the first
// time a picker opens. A null server value means "never customised": the row
// shows the nine emoji the picker always offered.

import { createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export const DEFAULT_FAVORITE_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "🙏", "🚀"]
/** Mirrors FAVORITE_EMOJI_MAX in @liaison/shared (the server refuses more). */
export const FAVORITE_EMOJI_MAX = 24

interface PreferencesApi {
  get: <T>(path: string) => Promise<T>
  put: (path: string, body: unknown) => Promise<unknown>
}

const [favorites, setFavorites] = createSignal<string[]>([...DEFAULT_FAVORITE_EMOJI])
let hydration: Promise<void> | null = null
let changedLocally = false

export function favoriteEmoji(): string[] {
  return favorites()
}

export function isFavoriteEmoji(emoji: string): boolean {
  return favorites().includes(emoji)
}

/** Fetch the user's favourites once per session. A local pin made while the
 *  GET is in flight wins over the (older) server answer. */
export function hydrateFavoriteEmoji(api: PreferencesApi | undefined): Promise<void> {
  if (!api) return Promise.resolve()
  if (hydration) return hydration
  hydration = api
    .get<{ favoriteEmoji?: string[] | null }>("/user/preferences")
    .then((prefs) => {
      if (changedLocally) return
      const list = prefs?.favoriteEmoji
      setFavorites(
        Array.isArray(list) ? list.slice(0, FAVORITE_EMOJI_MAX) : [...DEFAULT_FAVORITE_EMOJI],
      )
    })
    .catch(() => {
      // Non-critical: the defaults stay, the next session retries.
    })
  return hydration
}

/** Pin or unpin `emoji`. Optimistic; the PUT carries the whole ordered list.
 *  Returns false when pinning would exceed the cap. */
export function toggleFavoriteEmoji(api: PreferencesApi | undefined, emoji: string): boolean {
  const current = favorites()
  let next: string[]
  if (current.includes(emoji)) next = current.filter((e) => e !== emoji)
  else if (current.length >= FAVORITE_EMOJI_MAX) return false
  else next = [...current, emoji]
  changedLocally = true
  setFavorites(next)
  api?.put("/user/preferences/favorite-emoji", { favoriteEmoji: next }).catch(() => {
    // Non-critical: the local row is kept; the next change retries the PUT.
  })
  return true
}

/** Session teardown: the next login reads its own favourites. */
export function resetFavoriteEmoji(): void {
  hydration = null
  changedLocally = false
  setFavorites([...DEFAULT_FAVORITE_EMOJI])
}
onSessionTeardown(resetFavoriteEmoji)
