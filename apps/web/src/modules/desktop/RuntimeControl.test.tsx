// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T06: the one control that says where this agent's turns run and in
// which folder, built from apps/web's own primitives.

import { within as domWithin, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DESKTOP_BRIDGE_KEY,
  DESKTOP_BRIDGE_VERSION,
  type DesktopBridge,
  type DesktopSessionState,
  type DesktopStartSessionInput,
  emptyDesktopSessionState,
} from "~/lib/desktop-shell-contract"
import { attachDesktopBridge, resetDesktopStore } from "./desktop-store"
import { installFakeBridge, uninstallFakeBridge } from "./fake-bridge"
import RuntimeControl from "./RuntimeControl"

const LONG_PATH = "/Users/someone/Documents/work/clients/fabrikam/tessera-monorepo"

interface Installed {
  started: DesktopStartSessionInput[]
}

function installBridge(initial: Partial<DesktopSessionState>): Installed {
  const started: DesktopStartSessionInput[] = []
  const snapshot: DesktopSessionState = { ...emptyDesktopSessionState(), ...initial }
  const bridge = {
    version: DESKTOP_BRIDGE_VERSION,
    platform: "macos",
    pickFolder: async () => null,
    getServerAddress: () => null,
    setServerAddress: async () => {},
    startSession: async (input: DesktopStartSessionInput) => {
      started.push(input)
      return true
    },
    stopSession: async () => {},
    sendTurn: async () => {},
    interruptTurn: async () => {},
    respondToPermission: async () => {},
    readLocalFile: async () => null,
    setPermissionMode: () => {},
    setRuntimeLocation: () => {},
    getState: () => snapshot,
    subscribe: () => () => {},
  } as unknown as DesktopBridge
  vi.stubGlobal(DESKTOP_BRIDGE_KEY, bridge)
  attachDesktopBridge()
  return { started }
}

async function openMenu(): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name: "Where the turns of this conversation run" })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  return await screen.findByRole("menu")
}

describe("RuntimeControl", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetDesktopStore()
  })

  it("RuntimeControl renders nothing without a desktop bridge", () => {
    resetDesktopStore()
    const { container } = render(() => (
      <RuntimeControl agentId="a1" agentName="Liaison" threadId="t1" />
    ))
    expect(container.innerHTML).toBe("")
  })

  it("RuntimeControl shows the folder basename and not the full path", async () => {
    installBridge({ runtimeLocation: "local", folderPath: LONG_PATH })
    const { container } = render(() => (
      <RuntimeControl agentId="a1" agentName="Liaison" threadId="t1" />
    ))
    const trigger = screen.getByRole("button", {
      name: "Where the turns of this conversation run",
    })
    expect(trigger.textContent).toContain("tessera-monorepo")
    expect(container.textContent ?? "").not.toContain(LONG_PATH)
  })

  it("RuntimeControl starts a session for the thread it was given", async () => {
    const installed = installBridge({ runtimeLocation: "local", folderPath: LONG_PATH })
    render(() => <RuntimeControl agentId="a1" agentName="Liaison" threadId="t1" />)
    const menu = await openMenu()
    const start = domWithin(menu).getByText("Start a session here").closest('[role="menuitem"]')
    expect(start).not.toBeNull()
    fireEvent.keyDown(start as HTMLElement, { key: "Enter" })
    await waitFor(() =>
      expect(installed.started).toEqual([{ agentId: "a1", threadId: "t1", folderId: undefined }]),
    )
  })

  // P6d-FX2 (SK-1): the page never names a folder with a path. A recent row
  // starts the session by the HANDLE the shell issued for it, so the folder a
  // session is rooted in (and therefore the bound on readLocalFile) is one the
  // shell chose and not one the page composed.
  it("RuntimeControl starts a recent folder by its handle and never by its path", async () => {
    const installed = installBridge({
      runtimeLocation: "local",
      folderPath: LONG_PATH,
      recentFolders: [{ id: "folder-1", path: LONG_PATH, name: "tessera-monorepo" }],
    })
    render(() => <RuntimeControl agentId="a1" agentName="Liaison" threadId="t1" />)
    const menu = await openMenu()
    const row = domWithin(menu).getByText("tessera-monorepo").closest('[role="menuitem"]')
    fireEvent.keyDown(row as HTMLElement, { key: "Enter" })
    await waitFor(() => expect(installed.started).toHaveLength(1))
    expect(installed.started[0]).toEqual({ agentId: "a1", threadId: "t1", folderId: "folder-1" })
    expect(JSON.stringify(installed.started)).not.toContain(LONG_PATH)
  })

  // P6d-FX3 (W3). THE RECENT FOLDERS ARE THE SHELL'S, in an owner-only file
  // that outlives the window, and nothing ever read them back: the state's
  // list was written by a pick and by a start, so a freshly launched app
  // offered an agent none of the folders it had run in and the only route to a
  // session was the native picker again. The control asks when it opens.
  it("RuntimeControl asks the shell for this agent's folders when the menu opens", async () => {
    const fake = installFakeBridge(
      { runtimeLocation: "local" },
      {
        storedRecentFolders: {
          a1: [{ id: "folder-1", path: LONG_PATH, name: "tessera-monorepo" }],
        },
      },
    )
    render(() => <RuntimeControl agentId="a1" agentName="Liaison" threadId="t1" />)
    expect(fake.calls.recentFolderReads).toEqual([])

    const menu = await openMenu()

    await waitFor(() => expect(fake.calls.recentFolderReads).toEqual(["a1"]))
    await waitFor(() => expect(domWithin(menu).queryByText("tessera-monorepo")).not.toBeNull())
    uninstallFakeBridge()
  })

  // The other half of W3: the shell files a pick in the named agent's list and,
  // with no session running, the shell knows no agent. A pick made from an idle
  // menu was therefore filed under nobody and no list could ever fill.
  it("RuntimeControl names its agent when it opens the picker", async () => {
    const fake = installFakeBridge({ runtimeLocation: "local" }, { pickFolderResult: "folder-9" })
    render(() => <RuntimeControl agentId="a1" agentName="Liaison" threadId="t1" />)
    const menu = await openMenu()
    const choose = domWithin(menu).getByText("Choose a folder").closest('[role="menuitem"]')
    fireEvent.keyDown(choose as HTMLElement, { key: "Enter" })

    await waitFor(() => expect(fake.calls.pickedFolder).toBe(1))
    expect(fake.calls.pickedFolderAgents).toEqual(["a1"])
    uninstallFakeBridge()
  })

  it("RuntimeControl carries no inline style attribute", async () => {
    installBridge({
      runtimeLocation: "local",
      folderPath: LONG_PATH,
      recentFolders: [{ id: "folder-1", path: LONG_PATH, name: "tessera-monorepo" }],
    })
    const { container } = render(() => (
      <RuntimeControl agentId="a1" agentName="Liaison" threadId="t1" />
    ))
    const menu = await openMenu()
    expect(container.querySelectorAll("[style]").length).toBe(0)
    expect(menu.querySelectorAll("[style]").length).toBe(0)
  })

  // P3-T3 (S18): each mode says, in one plain sentence, what it can do.
  it("RuntimeControl describes each mode in one sentence", async () => {
    for (const runtimeLocation of ["local", "liaison"] as const) {
      installBridge({ runtimeLocation })
      const { unmount } = render(() => (
        <RuntimeControl agentId="a1" agentName="Liaison" threadId="t1" />
      ))
      const menu = await openMenu()
      const local = domWithin(menu).getByText(
        "Works in a folder on this computer with your Claude account: it can read and write your files, run scripts and make PDFs.",
      )
      const cloud = domWithin(menu).getByText(
        "Works on the Liaison server, from any device, with the same memory and conversations, but cannot touch your files or run scripts.",
      )
      // Each sentence sits in its own mode's row.
      expect(local.closest('[role="menuitem"]')?.textContent).toContain("This machine")
      expect(cloud.closest('[role="menuitem"]')?.textContent).toContain("Liaison")
      expect(local.closest('[role="menuitem"]')).not.toBe(cloud.closest('[role="menuitem"]'))
      unmount()
      vi.unstubAllGlobals()
      resetDesktopStore()
    }
  })
})
