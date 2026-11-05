// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T15: the server address step, as the login card's first step.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import DesktopConnect, { WINDOWS_SHELL_NOTICE_KEY } from "./DesktopConnect"
import { installFakeBridge, uninstallFakeBridge } from "./fake-bridge"

function addressField(): HTMLInputElement {
  return screen.getByLabelText("Liaison org URL") as HTMLInputElement
}

describe("DesktopConnect", () => {
  afterEach(() => {
    localStorage.removeItem(WINDOWS_SHELL_NOTICE_KEY)
    uninstallFakeBridge()
  })

  it("a rejected address shows the normative error and clears it on the next keystroke", async () => {
    const fake = installFakeBridge()
    render(() => <DesktopConnect />)
    fireEvent.input(addressField(), { target: { value: "not a url" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    await waitFor(() =>
      expect(screen.getByText("That is not a valid Liaison URL.")).toBeInTheDocument(),
    )
    expect(fake.calls.serverAddresses).toEqual([])

    fireEvent.input(addressField(), { target: { value: "https://liaison.fabrikam.example" } })
    await waitFor(() => expect(screen.queryByText("That is not a valid Liaison URL.")).toBeNull())
  })

  it("a valid address is handed to the shell", async () => {
    const fake = installFakeBridge()
    render(() => <DesktopConnect />)
    fireEvent.input(addressField(), { target: { value: "https://liaison.fabrikam.example" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() =>
      expect(fake.calls.serverAddresses).toEqual(["https://liaison.fabrikam.example"]),
    )
  })

  it("a bare domain, as the placeholder shows it, is read as https", async () => {
    const fake = installFakeBridge()
    render(() => <DesktopConnect />)
    expect(addressField().placeholder).toBe("liaison.example.com")
    fireEvent.input(addressField(), { target: { value: " liaison.fabrikam.example " } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() =>
      expect(fake.calls.serverAddresses).toEqual(["https://liaison.fabrikam.example"]),
    )
    expect(screen.queryByText("That is not a valid Liaison URL.")).toBeNull()
  })

  it("a deep linked address prefills the field and is applied only on a click", async () => {
    const fake = installFakeBridge({ deepLinkAddress: "https://liaison.example.com" })
    render(() => <DesktopConnect />)
    expect(addressField().value).toBe("https://liaison.example.com")
    expect(fake.calls.serverAddresses).toEqual([])
    expect(screen.getByText("Connect to this Liaison org?")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() => expect(fake.calls.serverAddresses).toEqual(["https://liaison.example.com"]))
  })

  it("an address the shell refuses says so and leaves the step where it is", async () => {
    installFakeBridge({}, { rejectServerAddress: "scheme refused" })
    render(() => <DesktopConnect />)
    fireEvent.input(addressField(), { target: { value: "https://liaison.fabrikam.example" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() =>
      expect(screen.getByText("That is not a valid Liaison URL.")).toBeInTheDocument(),
    )
    expect(addressField()).toBeInTheDocument()
  })

  it("the Windows note shows only on Windows and only once", async () => {
    installFakeBridge({}, { platform: "macos" })
    const mac = render(() => <DesktopConnect />)
    expect(screen.queryByTestId("windows-shell-note")).toBeNull()
    mac.unmount()
    uninstallFakeBridge()

    installFakeBridge({}, { platform: "windows" })
    const windows = render(() => <DesktopConnect />)
    expect(screen.getByTestId("windows-shell-note")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Do not show again" }))
    await waitFor(() => expect(screen.queryByTestId("windows-shell-note")).toBeNull())
    windows.unmount()

    render(() => <DesktopConnect />)
    expect(screen.queryByTestId("windows-shell-note")).toBeNull()
  })

  it("the connect step carries no inline style attribute", () => {
    installFakeBridge()
    const { container } = render(() => <DesktopConnect />)
    expect(container.querySelectorAll("[style]").length).toBe(0)
  })
})
