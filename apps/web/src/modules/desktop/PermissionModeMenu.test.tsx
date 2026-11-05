// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T09: the permission mode, where the model already is.

import { within as domWithin, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { englishT } from "~/modules/i18n/i18n-context"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import { NOTICE_MODE_NOT_CHANGED } from "./desktop-notices"
import { installFakeBridge, liveSession, uninstallFakeBridge } from "./fake-bridge"
import PermissionModeMenu from "./PermissionModeMenu"

async function openMenu(): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name: "How this session asks before it acts" })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  return await screen.findByRole("menu")
}

describe("PermissionModeMenu", () => {
  afterEach(() => {
    resetToastStore()
    uninstallFakeBridge()
  })

  // THE SAME TERMS CLAUDE USES, because a person meets this question there
  // first. Five rows, each a name and a one line description of what it does,
  // under a "Modes" heading, with a tick on the mode this session is running.
  // Auto comes first and is the default; there is no effort dial.
  it("permission mode menu lists Auto first, then the four other modes, with descriptions", async () => {
    installFakeBridge(liveSession("t1", "a1"))
    render(() => <PermissionModeMenu threadId="t1" />)
    const menu = await openMenu()
    const items = Array.from(menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'))
    const names = items.map((item) => (item.querySelector("span span")?.textContent ?? "").trim())
    expect(names).toEqual(["Auto", "Manual", "Edit automatically", "Plan", "Bypass permissions"])

    const text = (menu.textContent ?? "").replace(/\s+/g, " ")
    expect(text).toContain("Modes")
    expect(text).toContain("Runs Liaison tools and everyday commands without asking")
    expect(text).toContain("Asks for approval before every edit")
    expect(text).toContain("Edits files without asking; other actions still ask")
    expect(text).toContain("Explores and presents a plan before editing")
    expect(text).toContain("Never asks; runs potentially dangerous commands")
    expect(text).not.toContain("Effort")

    // Every row carries an icon, the other half of how the mode is recognised.
    for (const item of items) {
      expect(item.querySelector("svg")).not.toBeNull()
    }
  })

  it("a session nobody chose a mode for is in Auto: the chip says so and Auto is ticked", async () => {
    installFakeBridge(liveSession("t1", "a1"))
    render(() => <PermissionModeMenu threadId="t1" />)
    expect(screen.getByTestId("permission-mode-chip").textContent).toContain("Auto")
    const menu = await openMenu()
    const ticked = Array.from(
      menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'),
    ).filter((item) => item.querySelector(".text-accent") !== null)
    expect(ticked.map((item) => item.querySelector("span span")?.textContent)).toEqual(["Auto"])
  })

  it("ticks the mode this session is running in, and only that one", async () => {
    installFakeBridge(liveSession("t1", "a1", { permissionMode: "plan" }))
    render(() => <PermissionModeMenu threadId="t1" />)
    const menu = await openMenu()
    const ticked = Array.from(
      menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'),
    ).filter((item) => item.querySelector(".text-accent") !== null)
    expect(ticked.length).toBe(1)
    expect(ticked[0].textContent).toContain("Plan")
  })

  it("the chip says the whole mode name, with its icon", async () => {
    installFakeBridge(liveSession("t1", "a1", { permissionMode: "bypass" }))
    render(() => <PermissionModeMenu threadId="t1" />)
    const chip = screen.getByTestId("permission-mode-chip")
    expect(chip.textContent).toContain("Bypass permissions")
    expect(chip.querySelector("svg")).not.toBeNull()
  })

  // P6d-FX1 (SK-2): the confirmation is the SHELL's now. A dialog this page
  // draws is not a gate on a method that lives on the window.
  it("choosing Bypass asks the shell, which is the half that can confirm it", async () => {
    const fake = installFakeBridge(liveSession("t1", "a1"))
    render(() => <PermissionModeMenu threadId="t1" />)
    const menu = await openMenu()
    const bypass = domWithin(menu).getByText("Bypass permissions").closest('[role="menuitem"]')
    expect(bypass).not.toBeNull()
    fireEvent.keyDown(bypass as HTMLElement, { key: "Enter" })
    await waitFor(() => expect(fake.calls.modes).toEqual(["bypass"]))
    // No second question drawn by the page: one dialog, and it is native.
    expect(screen.queryByRole("dialog")).toBeNull()
    await waitFor(() => expect(fake.state().permissionMode).toBe("bypass"))
  })

  it("a shell that refused the change leaves the pill on the mode still running", async () => {
    const fake = installFakeBridge(liveSession("t1", "a1", { permissionMode: "manual" }), {
      refusePermissionMode: true,
    })
    render(() => <PermissionModeMenu threadId="t1" />)
    const menu = await openMenu()
    fireEvent.keyDown(
      domWithin(menu).getByText("Bypass permissions").closest('[role="menuitem"]') as HTMLElement,
      { key: "Enter" },
    )
    await waitFor(() => expect(fake.calls.modes).toEqual(["bypass"]))
    expect(fake.state().permissionMode).toBe("manual")
    expect(
      screen.getByRole("button", { name: "How this session asks before it acts" }).textContent,
    ).toContain("Manual")
  })

  // P6d-FX2 (SK-3): a refusal that shows up as nothing at all reads as a
  // control that does not work. The pill is right; something has to say why.
  it("a refused change says so", async () => {
    const refusing = installFakeBridge(liveSession("t1", "a1", { permissionMode: "manual" }), {
      refusePermissionMode: true,
    })
    render(() => <PermissionModeMenu threadId="t1" />)
    const menu = await openMenu()
    fireEvent.keyDown(
      domWithin(menu).getByText("Bypass permissions").closest('[role="menuitem"]') as HTMLElement,
      { key: "Enter" },
    )
    await waitFor(() => expect(refusing.calls.modes).toEqual(["bypass"]))
    await waitFor(() =>
      expect(toasts().map((toast) => toast.message)).toContain(englishT(NOTICE_MODE_NOT_CHANGED)),
    )
    expect(
      toasts().find((toast) => toast.message === englishT(NOTICE_MODE_NOT_CHANGED))?.type,
    ).toBe("warning")
  })

  it("an accepted change says nothing, because the pill already did", async () => {
    const accepting = installFakeBridge(liveSession("t1", "a1", { permissionMode: "manual" }))
    render(() => <PermissionModeMenu threadId="t1" />)
    const menu = await openMenu()
    fireEvent.keyDown(
      domWithin(menu).getByText("Plan").closest('[role="menuitem"]') as HTMLElement,
      { key: "Enter" },
    )
    await waitFor(() => expect(accepting.calls.modes).toEqual(["plan"]))
    expect(toasts().map((toast) => toast.message)).not.toContain(englishT(NOTICE_MODE_NOT_CHANGED))
  })

  it("choosing Plan changes the mode with no confirmation", async () => {
    const fake = installFakeBridge(liveSession("t1", "a1"))
    render(() => <PermissionModeMenu threadId="t1" />)
    const menu = await openMenu()
    fireEvent.keyDown(
      domWithin(menu).getByText("Plan").closest('[role="menuitem"]') as HTMLElement,
      {
        key: "Enter",
      },
    )
    await waitFor(() => expect(fake.calls.modes).toEqual(["plan"]))
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("permission mode menu renders nothing without a desktop bridge", () => {
    uninstallFakeBridge()
    const { container } = render(() => <PermissionModeMenu threadId="t1" />)
    expect(container.innerHTML).toBe("")
  })

  it("permission mode menu renders nothing for another conversation's session", () => {
    installFakeBridge(liveSession("other-thread", "a1"))
    const { container } = render(() => <PermissionModeMenu threadId="t1" />)
    expect(container.innerHTML).toBe("")
  })

  it("permission mode menu carries no inline style attribute", async () => {
    installFakeBridge(liveSession("t1", "a1"))
    const { container } = render(() => <PermissionModeMenu threadId="t1" />)
    const menu = await openMenu()
    expect(container.querySelectorAll("[style]").length).toBe(0)
    expect(menu.querySelectorAll("[style]").length).toBe(0)
  })
})
