// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The desktop's first screen: a Liaison Cloud workspace, with the address
// field one click away.

import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import DesktopServerStep from "./DesktopServerStep"
import { installFakeBridge, uninstallFakeBridge } from "./fake-bridge"

const workspace = () => screen.getByTestId("desktop-cloud-workspace") as HTMLInputElement
const continueButton = () => screen.getByRole("button", { name: "Continue" })

describe("DesktopServerStep", () => {
  afterEach(() => {
    cleanup()
    uninstallFakeBridge()
  })

  it("a first launch opens on Liaison Cloud and binds https://<name>.liaison.sh", async () => {
    const fake = installFakeBridge({}, { serverAddress: null })
    render(() => <DesktopServerStep />)
    expect(screen.getByLabelText("Your workspace")).toBe(workspace())
    expect(screen.getByTestId("desktop-cloud-suffix").textContent).toBe(".liaison.sh")
    expect(screen.queryByTestId("desktop-connect-address")).toBeNull()
    fireEvent.input(workspace(), { target: { value: " Acme " } })
    fireEvent.click(continueButton())
    await waitFor(() => expect(fake.calls.serverAddresses).toEqual(["https://acme.liaison.sh"]))
  })

  it("takes a pasted workspace URL and refuses what is not a workspace name", async () => {
    const fake = installFakeBridge({}, { serverAddress: null })
    render(() => <DesktopServerStep />)
    fireEvent.input(workspace(), { target: { value: "acme.example.com" } })
    fireEvent.click(continueButton())
    expect(await screen.findByText("That is not a valid workspace name.")).toBeInTheDocument()
    expect(fake.calls.serverAddresses).toEqual([])
    fireEvent.input(workspace(), { target: { value: "https://acme.liaison.sh/login" } })
    expect(screen.queryByText("That is not a valid workspace name.")).toBeNull()
    fireEvent.click(continueButton())
    await waitFor(() => expect(fake.calls.serverAddresses).toEqual(["https://acme.liaison.sh"]))
  })

  it("a workspace the shell finds no Liaison at is not found", async () => {
    installFakeBridge({}, { serverAddress: null, rejectServerAddress: "NotALiaisonServer" })
    render(() => <DesktopServerStep />)
    fireEvent.input(workspace(), { target: { value: "nobody" } })
    fireEvent.click(continueButton())
    expect(
      await screen.findByText("That workspace was not found. Check the name and try again."),
    ).toBeInTheDocument()
  })

  it("the cloud's pages open in the system browser, in French when the app is", async () => {
    const fake = installFakeBridge({}, { serverAddress: null })
    render(() => <DesktopServerStep />)
    fireEvent.click(screen.getByTestId("desktop-cloud-forgot"))
    fireEvent.click(screen.getByTestId("desktop-cloud-create"))
    await waitFor(() =>
      expect(fake.calls.openedExternalUrls).toEqual([
        "https://liaison.sh/login",
        "https://liaison.sh/signup",
      ]),
    )
    cleanup()
    fake.calls.openedExternalUrls.length = 0
    render(() => (
      <I18nProvider initialLocale="fr">
        <DesktopServerStep />
      </I18nProvider>
    ))
    expect(screen.getByLabelText("Votre espace de travail")).toBeInTheDocument()
    expect(screen.getByText("Créer un espace de travail")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("desktop-cloud-forgot"))
    fireEvent.click(screen.getByTestId("desktop-cloud-create"))
    await waitFor(() =>
      expect(fake.calls.openedExternalUrls).toEqual([
        "https://liaison.sh/fr/login",
        "https://liaison.sh/fr/signup",
      ]),
    )
  })

  it("the self-hosted link opens the address field, and there is a way back", async () => {
    const fake = installFakeBridge({}, { serverAddress: null })
    render(() => <DesktopServerStep />)
    fireEvent.click(screen.getByTestId("desktop-cloud-self-hosted"))
    expect(screen.getByLabelText("Liaison org URL")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("desktop-connect-use-cloud"))
    expect(workspace()).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("desktop-cloud-self-hosted"))
    fireEvent.input(screen.getByLabelText("Liaison org URL"), {
      target: { value: "liaison.example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() => expect(fake.calls.serverAddresses).toEqual(["https://liaison.example.com"]))
  })

  it("a connect link to a cloud workspace lands on the Cloud screen, prefilled, not applied", async () => {
    const fake = installFakeBridge(
      { deepLinkAddress: "https://acme.liaison.sh" },
      { serverAddress: null },
    )
    render(() => <DesktopServerStep />)
    expect(workspace().value).toBe("acme")
    expect(screen.getByText("Connect to this Liaison Cloud workspace?")).toBeInTheDocument()
    expect(fake.calls.serverAddresses).toEqual([])
    fireEvent.click(continueButton())
    await waitFor(() => expect(fake.calls.serverAddresses).toEqual(["https://acme.liaison.sh"]))
  })

  it("a connect link to another server keeps the address screen", () => {
    installFakeBridge({ deepLinkAddress: "https://liaison.example.com" }, { serverAddress: null })
    render(() => <DesktopServerStep />)
    expect((screen.getByLabelText("Liaison org URL") as HTMLInputElement).value).toBe(
      "https://liaison.example.com",
    )
    expect(screen.queryByTestId("desktop-cloud-workspace")).toBeNull()
  })

  it("adding a server to a bound install keeps the address screen, with the Cloud one beside it", () => {
    installFakeBridge({ addingServer: true }, { serverAddress: "https://liaison.example.com" })
    render(() => <DesktopServerStep />)
    expect(screen.getByLabelText("Liaison org URL")).toBeInTheDocument()
    expect(screen.getByTestId("desktop-connect-use-cloud")).toBeInTheDocument()
  })

  it("a build with no cloud opens on the address field, with no way to a cloud", () => {
    installFakeBridge({}, { serverAddress: null })
    render(() => <DesktopServerStep cloudDomain={null} />)
    expect(screen.getByLabelText("Liaison org URL")).toBeInTheDocument()
    expect(screen.queryByTestId("desktop-connect-use-cloud")).toBeNull()
    expect(screen.queryByTestId("desktop-cloud-workspace")).toBeNull()
  })

  it("a fork's own cloud domain is the suffix and the site", async () => {
    const fake = installFakeBridge({}, { serverAddress: null })
    render(() => <DesktopServerStep cloudDomain="cloud.example.com" />)
    expect(screen.getByTestId("desktop-cloud-suffix").textContent).toBe(".cloud.example.com")
    fireEvent.click(screen.getByTestId("desktop-cloud-create"))
    await waitFor(() =>
      expect(fake.calls.openedExternalUrls).toEqual(["https://cloud.example.com/signup"]),
    )
  })

  it("the Cloud screen carries no inline style attribute", () => {
    installFakeBridge({}, { serverAddress: null })
    const { container } = render(() => <DesktopServerStep />)
    expect(container.querySelectorAll("[style]").length).toBe(0)
  })
})
