// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The tour card keeps its less used actions (Take me there, Play whole
 * scenario, Pause, Skip) in its ⋯ menu: tests open it the way a keyboard
 * does, then press the item.
 */
import { fireEvent, screen, waitFor } from "@solidjs/testing-library"
import { expect } from "vitest"

/** Opens the card's ⋯ menu (a no-op when it is open already). */
export async function openTourMenu(): Promise<HTMLElement> {
  const open = screen.queryByTestId("tour-menu")
  if (open) return open
  const trigger = await screen.findByTestId("tour-more")
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "Enter" })
  return screen.findByTestId("tour-menu")
}

/** The menu item, after opening the menu; null when the card does not offer it now. */
export async function tourMenuItem(testid: string): Promise<HTMLElement | null> {
  await openTourMenu()
  return screen.queryByTestId(testid)
}

/** Waits until the card offers the menu item, and returns it (the menu left open). */
export async function findTourMenuItem(testid: string): Promise<HTMLElement> {
  return waitFor(async () => {
    const item = await tourMenuItem(testid)
    if (!item) throw new Error(`the tour menu does not offer ${testid}`)
    return item
  })
}

/**
 * Opens the ⋯ menu and presses one of its items (waits for it to be offered).
 * An action the card shows on itself instead (Skip this step when it is the
 * only way on) is pressed there.
 */
export async function pressTourMenuItem(testid: string): Promise<void> {
  const item = await findTourMenuItem(testid)
  if (!item.closest('[data-testid="tour-menu"]')) {
    await closeTourMenu()
    fireEvent.click(item)
    return
  }
  fireEvent.keyDown(item, { key: "Enter" })
  await waitFor(() => expect(screen.queryByTestId("tour-menu")).toBeNull())
}

/** Closes the menu (Escape), so the card reads as the person sees it. */
export async function closeTourMenu(): Promise<void> {
  const menu = screen.queryByTestId("tour-menu")
  if (!menu) return
  fireEvent.keyDown(menu, { key: "Escape" })
  await waitFor(() => expect(screen.queryByTestId("tour-menu")).toBeNull())
}
