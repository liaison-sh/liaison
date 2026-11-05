// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SERVERS AND THE CLAUDE ACCOUNT, the window's half of the shell's two
// native questions, and what the page's own servers UI does.
//
// There is no Account menu on any OS (`src-tauri/src/account.rs`): the app's
// Servers switcher and Settings > Profile are the one place. The shell still
// asks two questions itself, because a page script must not be able to answer
// them: removing a server, and signing the computer out of Claude. This module
// does what only the page can do around them:
//
//   the words      both questions speak the user's language, from the i18n
//                  catalogue apps/web reads (`packages/shared/src/i18n`), in
//                  whichever language the page settled on (apps/web writes it
//                  on `<html lang>`), and again whenever that changes
//   the handlers   a switch or a confirmed removal releases the local
//                  session's claim, swaps the page's storage and starts the
//                  page again (`server-switch.ts`); "Add a server..." opens
//                  the connect step in the page; "Sign out" ends the current
//                  server's session and no other (`desktop-servers.ts` hands
//                  these to the page's servers UI)

import { deleteSessionCachesOf } from "@liaison/web/modules/sessions/session-cache-db"
import { endBridgeSession, releaseRuntimeLocation, setDesktopSessionState } from "../bridge"
import { en as enServers, fr as frServers } from "./account-copy"
import { noteSessionToken, WEB_SESSION_FLAG_KEY } from "./desktop-store"
import { switchServerWith } from "./server-switch"
import {
  type AccountDialogCopy,
  type AccountMenuAction,
  type ClaudeDialogCopy,
  onAccountMenu,
  removeServer,
  setAccountDialogCopy,
  signOutOfServer,
  switchServer,
} from "./sidecar-client"

/** The catalogue's `kernel.servers` keys the removal question needs. */
export interface ServersCopy {
  removeTitle: string
  removeMessage: string
  removeConfirm: string
  cancel: string
  /** The tray icon's two items (src-tauri/src/tray.rs), P1-T6. */
  trayOpen: string
  trayQuit: string
}

/** The catalogue's `kernel.servers` keys the "Sign out of Claude" question needs. */
export interface ServersClaudeCopy {
  claudeSignedIn: string
  claudeSignOutTitle: string
  claudeSignOutMessage: string
  claudeSignOutConfirm: string
}

/** The language the page settled on, reduced to one the catalogue ships. */
export function menuLocale(lang: string | null | undefined): "en" | "fr" {
  return (lang ?? "").trim().toLowerCase().startsWith("fr") ? "fr" : "en"
}

/**
 * The removal question's words in one language. The catalogue writes
 * `{{server}}` for the page's own interpolation; the shell fills `{server}`,
 * so the placeholder is translated here and nowhere else.
 */
export function accountDialogCopy(locale: "en" | "fr"): AccountDialogCopy {
  const copy: ServersCopy = locale === "fr" ? frServers : enServers
  return {
    removeTitle: copy.removeTitle,
    removeMessage: copy.removeMessage.replace("{{server}}", "{server}"),
    removeConfirm: copy.removeConfirm,
    cancel: copy.cancel,
    trayOpen: copy.trayOpen,
    trayQuit: copy.trayQuit,
  }
}

/**
 * The "Sign out of Claude" question's words in one language. The catalogue
 * writes `{{email}}`; the shell fills `{email}`.
 */
export function claudeDialogCopy(locale: "en" | "fr"): ClaudeDialogCopy {
  const copy: ServersClaudeCopy = locale === "fr" ? frServers : enServers
  return {
    signedIn: copy.claudeSignedIn,
    signOutTitle: copy.claudeSignOutTitle,
    signOutMessage: copy.claudeSignOutMessage.replace("{{email}}", "{email}"),
    signOutConfirm: copy.claudeSignOutConfirm,
  }
}

/** What each account action does, injected so every branch is drivable without a shell. */
export interface AccountMenuHandlers {
  switchTo: (address: string) => Promise<unknown>
  remove: (address: string) => Promise<unknown>
  add: () => void
  signOut: () => Promise<void>
}

/** Runs a removal the shell confirmed. Failures are swallowed: the servers UI is still there to retry. */
export async function handleAccountAction(
  action: AccountMenuAction,
  handlers: AccountMenuHandlers,
): Promise<void> {
  try {
    if (action.action === "remove" && action.address) await handlers.remove(action.address)
  } catch (error) {
    console.warn("liaison: the server removal did not complete", error)
  }
}

function pageStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function pageSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage
  } catch {
    return null
  }
}

/** Removes every key of a signed-in session ("liaison:"), the page's own rule. */
function forgetSessionKeys(storage: Storage | null): void {
  if (!storage) return
  try {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (key?.startsWith("liaison:")) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  } catch {
    // Storage that cannot be read holds nothing to forget.
  }
}

/** The handlers the real window runs. */
export function defaultAccountHandlers(reload?: () => void): AccountMenuHandlers {
  const deps = reload ? { reload } : {}
  return {
    switchTo: (address) => switchServerWith((outgoing) => switchServer(address, outgoing), deps),
    // The storage belongs to the server being removed: nothing is parked.
    // S58 (batch-5 F3): its cached session transcripts (IndexedDB, one
    // database per user of that server) go with it, before the page restarts.
    remove: (address) =>
      switchServerWith(async () => {
        const removed = await removeServer(address)
        await deleteSessionCachesOf(address)
        return removed
      }, deps),
    // The page draws the connect step; the shell has nothing to do until an
    // address has answered as a Liaison.
    add: () => setDesktopSessionState({ addingServer: true }),
    signOut: async () => {
      await endBridgeSession().catch(() => undefined)
      await signOutOfServer()
      noteSessionToken(null)
      releaseRuntimeLocation()
      try {
        pageStorage()?.removeItem(WEB_SESSION_FLAG_KEY)
      } catch {
        // The refresh the page makes next has no token, which ends it anyway.
      }
      // What the page kept for the account that left (open tabs, drafts,
      // preferences) goes with it, as the browser's own sign out does
      // (apps/web lib/storage.ts): the next person to sign in on this window
      // is not that person. The shell's own keys use another prefix and stay.
      forgetSessionKeys(pageStorage())
      forgetSessionKeys(pageSessionStorage())
      ;(reload ?? (() => globalThis.location?.reload()))()
    },
  }
}

/**
 * Hands the shell its questions' words now and whenever the page's language
 * changes. Returns the disconnect.
 */
export function followDialogLanguage(
  doc: Document,
  push: (copy: AccountDialogCopy, claude: ClaudeDialogCopy) => void = (copy, claude) =>
    void setAccountDialogCopy(copy, claude),
): () => void {
  let last: "en" | "fr" | null = null
  const sync = () => {
    const locale = menuLocale(doc.documentElement?.getAttribute("lang") ?? navigatorLanguage())
    if (locale === last) return
    last = locale
    push(accountDialogCopy(locale), claudeDialogCopy(locale))
  }
  sync()
  if (typeof MutationObserver === "undefined" || !doc.documentElement) return () => undefined
  const observer = new MutationObserver(sync)
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["lang"] })
  return () => observer.disconnect()
}

function navigatorLanguage(): string | null {
  try {
    return typeof navigator === "undefined" ? null : navigator.language
  } catch {
    return null
  }
}

/** Arms this window: the shell's questions' words, and its confirmed removals. */
export function armAccountDialogs(doc: Document, handlers = defaultAccountHandlers()): void {
  followDialogLanguage(doc)
  void onAccountMenu((action) => void handleAccountAction(action, handlers)).catch(() => undefined)
}
