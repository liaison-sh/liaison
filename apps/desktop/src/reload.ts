// SPDX-License-Identifier: FSL-1.1-ALv2
//
// RELOAD AND FORCE RELOAD of the desktop window.
//
// The page can get stuck (a view that stopped painting, a stale bundle), and a
// wrapped web app has no browser chrome to reload it from. macOS reaches these
// from the View menu (`menu_bar.rs` calls `globalThis.__LIAISON_RELOAD__`);
// Windows and Linux have no menu bar, so this listener takes Ctrl+R / F5 and
// Ctrl+Shift+R / Ctrl+F5 itself.
//
// A RELOAD KEEPS THE SESSION. The sign-in lives in the shell's keychain-backed
// store (`store_refresh_token` / `load_refresh_token`) and the server list in
// the config folder, not in page memory, so the reloaded page signs itself
// back in. The server switch relies on the same property (session/server-switch.ts
// reloads the page after changing server). A force reload additionally drops the
// page's Cache API entries; it never touches local or session storage.

import {
  PAGE_RELOAD_GUARD_KEY,
  type PageReloadGuard,
} from "@liaison/web/lib/desktop-shell-contract"

/** The global the macOS menu calls. */
export const RELOAD_GLOBAL = "__LIAISON_RELOAD__"

export type ReloadKind = "reload" | "force"

interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** Which reload a key press asks for, or null. Ctrl only: Cmd+R is the macOS menu's. */
export function reloadKindForKey(e: KeyLike): ReloadKind | null {
  if (e.altKey || e.metaKey) return null
  const key = e.key.toLowerCase()
  if (e.ctrlKey && key === "r") return e.shiftKey ? "force" : "reload"
  if (key === "f5") return e.ctrlKey || e.shiftKey ? "force" : "reload"
  return null
}

/** What a reload needs of its window: `globalThis` and a `Window` both fit. */
export interface ReloadHost {
  location: Pick<Location, "reload">
  caches?: Pick<CacheStorage, "keys" | "delete">
  navigator?: { platform?: string }
  addEventListener(type: "keydown", listener: (e: KeyboardEvent) => void, capture?: boolean): void
  removeEventListener(
    type: "keydown",
    listener: (e: KeyboardEvent) => void,
    capture?: boolean,
  ): void
}

/**
 * Reloads the window, unless the page holds work a reload would lose (a draft,
 * a staged or uploading file, unsaved edits): then the page's own guard asks
 * the person first and runs the reload only on a confirm. Every path goes
 * through here: the macOS menu, Ctrl+R, F5 and their force variants.
 */
export async function reloadWindow(
  force: boolean,
  view: Pick<ReloadHost, "location" | "caches"> = window,
): Promise<void> {
  const guard: unknown = Reflect.get(view, PAGE_RELOAD_GUARD_KEY)
  if (typeof guard === "function") {
    let tookOver = false
    try {
      tookOver = (guard as PageReloadGuard)(() => void reloadNow(force, view)) === true
    } catch {
      // A page whose guard throws must still be reloadable: it is how a stuck page gets fixed.
      tookOver = false
    }
    if (tookOver) return
  }
  await reloadNow(force, view)
}

async function reloadNow(
  force: boolean,
  view: Pick<ReloadHost, "location" | "caches">,
): Promise<void> {
  if (force) {
    try {
      const store = view.caches
      if (store) await Promise.all((await store.keys()).map((name) => store.delete(name)))
    } catch {
      // No Cache API, or it refused: the reload below still happens.
    }
  }
  view.location.reload()
}

/**
 * Publishes the menu's entry point and, off macOS, listens for the shortcuts.
 * Returns the listener's remover.
 */
export function installReload(
  view: ReloadHost = window,
  isMac: boolean = /mac/i.test(view.navigator?.platform ?? ""),
): () => void {
  Reflect.set(view, RELOAD_GLOBAL, (force: boolean) => {
    void reloadWindow(force, view)
  })
  if (isMac) return () => undefined
  const onKeyDown = (e: KeyboardEvent) => {
    const kind = reloadKindForKey(e)
    if (!kind) return
    e.preventDefault()
    void reloadWindow(kind === "force", view)
  }
  view.addEventListener("keydown", onKeyDown, true)
  return () => view.removeEventListener("keydown", onKeyDown, true)
}
