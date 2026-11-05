// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The window's half of the shell's two native questions (removing a server,
// signing out of Claude): their words, and what a confirmed removal does. There
// is no Account menu on any OS.

import { afterEach, describe, expect, it, vi } from "vitest"

const { invoke, handlers } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined as unknown),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}))

vi.mock("../tauri", () => ({
  invoke,
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler)
    return () => handlers.delete(name)
  },
}))

import { publishDesktopBridge, resetDesktopBridge } from "../bridge"
import {
  accountDialogCopy,
  armAccountDialogs,
  claudeDialogCopy,
  followDialogLanguage,
  handleAccountAction,
  menuLocale,
} from "./account-menu"
import { ACCOUNT_MENU_EVENT, type AccountDialogCopy } from "./sidecar-client"

describe("the native questions' words", () => {
  it("come from the catalogue, in French for a French page", () => {
    expect(accountDialogCopy("fr")).toEqual({
      removeTitle: "Retirer ce serveur",
      removeMessage: "Retirer {server} ? Vous en serez déconnecté, et l'application l'oubliera.",
      removeConfirm: "Retirer",
      cancel: "Annuler",
      // P1-T6: the tray icon's items, in the page's language.
      trayOpen: "Ouvrir Liaison",
      trayQuit: "Quitter Liaison",
    })
    expect(accountDialogCopy("en").removeTitle).toBe("Remove this server")
    expect(accountDialogCopy("en").trayQuit).toBe("Quit Liaison")
    // No menu labels: the shell draws no Account menu any more.
    expect(Object.keys(accountDialogCopy("en"))).not.toContain("account")
    expect(Object.keys(claudeDialogCopy("en")).sort()).toEqual([
      "signOutConfirm",
      "signOutMessage",
      "signOutTitle",
      "signedIn",
    ])
    expect(claudeDialogCopy("en").signOutMessage).toContain("{email}")
  })

  it("follow the language the page settled on", () => {
    expect(menuLocale("fr-FR")).toBe("fr")
    expect(menuLocale("fr")).toBe("fr")
    expect(menuLocale("en-GB")).toBe("en")
    expect(menuLocale("pl")).toBe("en")
    expect(menuLocale(null)).toBe("en")
  })

  it("are handed over again when the page changes language, and only then", async () => {
    document.documentElement.setAttribute("lang", "en")
    const pushed: AccountDialogCopy[] = []
    const stop = followDialogLanguage(document, (copy) => pushed.push(copy))
    expect(pushed.map((copy) => copy.cancel)).toEqual(["Cancel"])
    document.documentElement.setAttribute("lang", "fr")
    await vi.waitFor(() => expect(pushed.map((copy) => copy.cancel)).toEqual(["Cancel", "Annuler"]))
    document.documentElement.setAttribute("lang", "fr-FR")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pushed).toHaveLength(2)
    stop()
    document.documentElement.setAttribute("lang", "en")
  })
})

describe("the account actions", () => {
  afterEach(() => {
    handlers.clear()
    invoke.mockReset()
    resetDesktopBridge()
  })

  function spies() {
    return {
      switchTo: vi.fn(async (_address: string) => undefined),
      remove: vi.fn(async (_address: string) => undefined),
      add: vi.fn(),
      signOut: vi.fn(async () => {}),
    }
  }

  it("runs a removal the shell confirmed, and nothing else the shell could send", async () => {
    const handlers = spies()
    await handleAccountAction({ action: "remove", address: "https://a.example" }, handlers)
    expect(handlers.remove).toHaveBeenCalledWith("https://a.example")
    expect(handlers.switchTo).not.toHaveBeenCalled()
    expect(handlers.add).not.toHaveBeenCalled()
    expect(handlers.signOut).not.toHaveBeenCalled()
  })

  it("hears only a confirmed removal from the shell, and a malformed event does nothing", async () => {
    const handlers$ = spies()
    armAccountDialogs(document, handlers$)
    await vi.waitFor(() => expect(handlers.has(ACCOUNT_MENU_EVENT)).toBe(true))
    const emit = handlers.get(ACCOUNT_MENU_EVENT)
    // The menu actions the shell no longer sends are ignored.
    emit?.({ payload: { action: "switch", address: "https://b.example" } })
    emit?.({ payload: { action: "add" } })
    emit?.({ payload: { action: "signOut" } })
    emit?.({ payload: { action: "remove" } })
    emit?.({ payload: { action: "format-the-disk" } })
    emit?.({ payload: "remove" })
    emit?.({ payload: { action: "remove", address: "https://a.example" } })
    await vi.waitFor(() => expect(handlers$.remove).toHaveBeenCalledTimes(1))
    expect(handlers$.remove).toHaveBeenCalledWith("https://a.example")
    expect(handlers$.switchTo).not.toHaveBeenCalled()
    expect(handlers$.add).not.toHaveBeenCalled()
    expect(handlers$.signOut).not.toHaveBeenCalled()
    // The questions' words went to the shell as it was armed.
    expect(invoke).toHaveBeenCalledWith(
      "set_account_dialog_copy",
      expect.objectContaining({
        copy: expect.objectContaining({ removeTitle: expect.any(String) }),
        claude: expect.objectContaining({ signOutTitle: expect.any(String) }),
      }),
    )
    expect(invoke).not.toHaveBeenCalledWith("set_account_menu_copy", expect.anything())
  })

  // "Add a server..." opens the page's connect step, which is where the
  // address is typed and checked.
  it("opens the page's connect step for Add a server", async () => {
    const target: Record<string, unknown> = {}
    const bridge = publishDesktopBridge(target)
    const { defaultAccountHandlers } = await import("./account-menu")
    defaultAccountHandlers(() => undefined).add()
    expect(bridge.getState().addingServer).toBe(true)
    bridge.dismissConnect?.()
    expect(bridge.getState().addingServer).toBe(false)
  })

  // Sign out ends the CURRENT server's session through the shell, which
  // revokes it there and forgets it here, and the page starts again on that
  // server's sign in. The local session goes first.
  it("signs out through the shell and starts the page again", async () => {
    const reload = vi.fn()
    localStorage.setItem("liaison:session", "1")
    localStorage.setItem("liaison:tabs", "[1]")
    sessionStorage.setItem("liaison:draft", "x")
    localStorage.setItem("liaison-desktop:server-address", "https://a.example")
    const { defaultAccountHandlers } = await import("./account-menu")
    await defaultAccountHandlers(reload).signOut()
    expect(invoke).toHaveBeenCalledWith("sign_out")
    expect(localStorage.getItem("liaison:session")).toBeNull()
    // The account's own page state goes with it; the shell's keys stay.
    expect(localStorage.getItem("liaison:tabs")).toBeNull()
    expect(sessionStorage.getItem("liaison:draft")).toBeNull()
    expect(localStorage.getItem("liaison-desktop:server-address")).toBe("https://a.example")
    localStorage.clear()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  // A switch goes through the shell's switch command, handing it
  // the page's storage for the server being left.
  it("switches through the shell's switch command", async () => {
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "switch_server") {
        return { address: args?.address, storage: {} }
      }
      return undefined
    })
    const reload = vi.fn()
    localStorage.setItem("liaison-desktop:storage-owner", "https://a.example")
    localStorage.setItem("liaison:tabs", "[1]")
    const { defaultAccountHandlers } = await import("./account-menu")
    await defaultAccountHandlers(reload).switchTo("https://b.example")
    expect(invoke).toHaveBeenCalledWith("switch_server", {
      address: "https://b.example",
      outgoing: { owner: "https://a.example", storage: { "liaison:tabs": "[1]" } },
    })
    expect(reload).toHaveBeenCalledTimes(1)
    localStorage.clear()
  })

  // S58 (batch-5 F3): a removed server's cached session transcripts go with it.
  it("a confirmed removal deletes every cached session events database of that server, and no other", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "remove_server") return { address: "https://b.example", storage: {} }
      return undefined
    })
    const { sessionCacheDbName } = await import("@liaison/web/modules/sessions/session-cache-db")
    const deleted: string[] = []
    const factory = {
      databases: async () => [
        { name: sessionCacheDbName("https://a.example", "u1") },
        { name: sessionCacheDbName("https://a.example", "u2") },
        { name: sessionCacheDbName("https://b.example", "u1") },
        { name: "liaison-mailbox-keys" },
      ],
      deleteDatabase: (name: string) => {
        deleted.push(name)
        const req: { onsuccess?: () => void } = {}
        queueMicrotask(() => req.onsuccess?.())
        return req
      },
    }
    const g = globalThis as Record<string, unknown>
    const had = g.indexedDB
    g.indexedDB = factory
    try {
      const reload = vi.fn()
      const { defaultAccountHandlers } = await import("./account-menu")
      await defaultAccountHandlers(reload).remove("https://a.example")
      expect(invoke).toHaveBeenCalledWith("remove_server", { address: "https://a.example" })
      expect(deleted.sort()).toEqual([
        sessionCacheDbName("https://a.example", "u1"),
        sessionCacheDbName("https://a.example", "u2"),
      ])
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      g.indexedDB = had
      localStorage.clear()
    }
  })
})
