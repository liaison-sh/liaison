// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The connect step over a SIGNED IN window: the servers UI's "Add a
// server..." and a `liaison://connect` link both need somewhere to ask, and a
// signed in window never shows the login card.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { englishT } from "~/modules/i18n/i18n-context"

const auth = vi.hoisted(() => ({ token: null as string | null }))
vi.mock("~/modules/auth/auth-store", () => ({
  accessToken: () => auth.token,
}))

import DesktopConnect from "./DesktopConnect"
import DesktopConnectDialog, { CONNECT_DIALOG_TITLE } from "./DesktopConnectDialog"
import { installFakeBridge, uninstallFakeBridge } from "./fake-bridge"

function addressField(): HTMLInputElement {
  return screen.getByLabelText("Liaison org URL") as HTMLInputElement
}

describe("DesktopConnectDialog", () => {
  beforeEach(() => {
    auth.token = "signed-in"
  })
  afterEach(() => uninstallFakeBridge())

  it("opens when the servers UI asks to add a server, and asks for the address", async () => {
    const fake = installFakeBridge({ addingServer: true })
    render(() => <DesktopConnectDialog />)
    expect(screen.getByText(englishT(CONNECT_DIALOG_TITLE))).toBeInTheDocument()
    expect(screen.getByText("Enter the URL of another Liaison org:")).toBeInTheDocument()
    fireEvent.input(addressField(), { target: { value: "https://liaison.fabrikam.example" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() =>
      expect(fake.calls.serverAddresses).toEqual(["https://liaison.fabrikam.example"]),
    )
  })

  // A connect link is attacker reachable: the address is shown and applied
  // only by the user's click, exactly as the login card's step does it.
  it("shows a linked address with the confirmation, and applies nothing until the click", async () => {
    const fake = installFakeBridge({ deepLinkAddress: "https://liaison.fabrikam.example" })
    render(() => <DesktopConnectDialog />)
    expect(addressField().value).toBe("https://liaison.fabrikam.example")
    expect(screen.getByText("Connect to this Liaison org?")).toBeInTheDocument()
    expect(fake.calls.serverAddresses).toEqual([])
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() =>
      expect(fake.calls.serverAddresses).toEqual(["https://liaison.fabrikam.example"]),
    )
  })

  it("cancel closes it with nothing applied", async () => {
    const fake = installFakeBridge({ addingServer: true })
    render(() => <DesktopConnectDialog />)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(fake.calls.dismissedConnects).toBe(1))
    expect(fake.calls.serverAddresses).toEqual([])
    await waitFor(() => expect(screen.queryByText(englishT(CONNECT_DIALOG_TITLE))).toBeNull())
  })

  it("stays away from a window nobody is signed in to, which has the login card", () => {
    auth.token = null
    installFakeBridge({ addingServer: true })
    render(() => <DesktopConnectDialog />)
    expect(screen.queryByText(englishT(CONNECT_DIALOG_TITLE))).toBeNull()
  })

  it("renders nothing in a browser", () => {
    render(() => <DesktopConnectDialog />)
    expect(screen.queryByText(englishT(CONNECT_DIALOG_TITLE))).toBeNull()
  })
})

describe("DesktopConnect refusals", () => {
  afterEach(() => uninstallFakeBridge())

  it("says when the address does not answer as a Liaison", async () => {
    installFakeBridge({}, { rejectServerAddress: "NotALiaisonServer" })
    render(() => <DesktopConnect />)
    fireEvent.input(addressField(), { target: { value: "https://example.com" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() =>
      expect(screen.getByText("That URL is not a Liaison org.")).toBeInTheDocument(),
    )
  })

  it("says when the address could not be reached", async () => {
    installFakeBridge({}, { rejectServerAddress: "ServerUnreachable" })
    render(() => <DesktopConnect />)
    fireEvent.input(addressField(), { target: { value: "https://gone.example" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() =>
      expect(
        screen.getByText("Cannot reach this Liaison. Check the URL and try again."),
      ).toBeInTheDocument(),
    )
  })
})
