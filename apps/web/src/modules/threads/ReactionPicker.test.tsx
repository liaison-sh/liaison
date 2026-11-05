// SPDX-License-Identifier: FSL-1.1-ALv2
// S16: the reaction picker's favourites row, searchable grouped full list and
// pin/unpin persisted through PUT /user/preferences/favorite-emoji.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { DEFAULT_FAVORITE_EMOJI, resetFavoriteEmoji } from "~/modules/threads/favorite-emoji"
import ReactionPicker from "~/modules/threads/ReactionPicker"

function makeApi(favoriteEmoji: string[] | null) {
  return {
    get: vi.fn(async () => ({ favoriteEmoji })),
    put: vi.fn(async (_path: string, body: { favoriteEmoji: string[] }) => ({
      favoriteEmoji: body.favoriteEmoji,
    })),
  }
}

function renderPicker(api: ReturnType<typeof makeApi>, onSelect = vi.fn()) {
  render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api as never}>
        <ReactionPicker onSelect={onSelect} />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  fireEvent.click(screen.getByLabelText("Add reaction"))
  return onSelect
}

const favoritesRow = () => screen.getByTestId("reaction-favorites")
const favoriteEmoji = () =>
  Array.from(favoritesRow().querySelectorAll("button")).map((b) => b.textContent)

beforeEach(() => resetFavoriteEmoji())
afterEach(() => cleanup())

describe("ReactionPicker", () => {
  it("shows the 9 default favourites for a user who never pinned one", async () => {
    renderPicker(makeApi(null))
    await waitFor(() => expect(favoriteEmoji()).toEqual(DEFAULT_FAVORITE_EMOJI))
    expect(DEFAULT_FAVORITE_EMOJI).toEqual(["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "🙏", "🚀"])
  })

  it("shows the user's own favourites when they have some", async () => {
    renderPicker(makeApi(["🦄", "👍🏽"]))
    await waitFor(() => expect(favoriteEmoji()).toEqual(["🦄", "👍🏽"]))
  })

  it("lists the full emoji set grouped by category, and search filters it by name", async () => {
    renderPicker(makeApi(null))
    // Lazy-loaded: the grouped list appears once the dataset resolves.
    await waitFor(() => expect(screen.getByTestId("reaction-group-smileys_emotion")).toBeTruthy())
    expect(screen.getByTestId("reaction-group-flags")).toBeTruthy()
    expect(screen.getByLabelText("React with 🦒")).toBeTruthy()

    fireEvent.input(screen.getByPlaceholderText("Search emoji"), { target: { value: "giraffe" } })
    await waitFor(() => expect(screen.queryByLabelText("React with 😀")).toBeNull())
    expect(screen.getByLabelText("React with 🦒")).toBeTruthy()
  })

  it("reacts with an emoji picked from the full list", async () => {
    const onSelect = renderPicker(makeApi(null))
    await waitFor(() => expect(screen.getByLabelText("React with 🦒")).toBeTruthy())
    fireEvent.click(screen.getByLabelText("React with 🦒"))
    expect(onSelect).toHaveBeenCalledWith("🦒")
  })

  it("pins an emoji from the full list and unpins a favourite, persisting each change", async () => {
    const api = makeApi(null)
    const onSelect = renderPicker(api)
    await waitFor(() => expect(screen.getByLabelText("React with 🦒")).toBeTruthy())

    // Edit mode: a click pins or unpins instead of reacting.
    fireEvent.click(screen.getByLabelText("Edit favourites"))
    fireEvent.click(screen.getByLabelText("Pin 🦒 to favourites"))
    expect(favoriteEmoji()).toEqual([...DEFAULT_FAVORITE_EMOJI, "🦒"])
    expect(api.put).toHaveBeenLastCalledWith("/user/preferences/favorite-emoji", {
      favoriteEmoji: [...DEFAULT_FAVORITE_EMOJI, "🦒"],
    })

    fireEvent.click(within(favoritesRow()).getByLabelText("Unpin 👍 from favourites"))
    expect(favoriteEmoji()).toEqual([...DEFAULT_FAVORITE_EMOJI.slice(1), "🦒"])
    expect(api.put).toHaveBeenLastCalledWith("/user/preferences/favorite-emoji", {
      favoriteEmoji: [...DEFAULT_FAVORITE_EMOJI.slice(1), "🦒"],
    })
    // Pinning is not reacting.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("refuses a 25th favourite", async () => {
    const full = Array.from({ length: 24 }, (_, i) => String.fromCodePoint(0x1f600 + i))
    const api = makeApi(full)
    renderPicker(api)
    await waitFor(() => expect(favoriteEmoji()).toHaveLength(24))
    fireEvent.click(screen.getByLabelText("Edit favourites"))
    await waitFor(() => expect(screen.getByLabelText("Pin 🦒 to favourites")).toBeTruthy())
    const pin = screen.getByLabelText("Pin 🦒 to favourites") as HTMLButtonElement
    expect(pin.disabled).toBe(true)
    fireEvent.click(pin)
    expect(api.put).not.toHaveBeenCalled()
  })
})
