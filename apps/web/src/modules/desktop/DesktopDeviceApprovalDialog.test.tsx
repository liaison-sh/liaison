// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-FX5 (W5): the device grant a SIGNED IN window raises had nowhere to go.
//
// Every case here fails without the component: before it, a `deviceApproval`
// on the state while the user is signed in rendered nothing anywhere in the
// document, the shell polled a code nobody could read, and the session sat in
// `starting` until the grant expired.

import { render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { englishT } from "~/modules/i18n/i18n-context"

/** The wrapped app's own session, under this test's control. */
const auth = vi.hoisted(() => ({ token: null as string | null }))
vi.mock("~/modules/auth/auth-store", () => ({
  accessToken: () => auth.token,
}))

import DesktopDeviceApproval from "./DesktopDeviceApproval"
import DesktopDeviceApprovalDialog, {
  DEVICE_APPROVAL_CANCEL_ACTION,
  DEVICE_APPROVAL_DIALOG_TITLE,
} from "./DesktopDeviceApprovalDialog"
import { installFakeBridge, uninstallFakeBridge } from "./fake-bridge"

const URI = "https://liaison.fabrikam.example/auth/device?code=QKVZMC5G"

describe("DesktopDeviceApprovalDialog", () => {
  beforeEach(() => {
    auth.token = "signed-in"
  })
  afterEach(() => uninstallFakeBridge())

  it("a grant raised while the user is signed in is rendered, with its code and its link", () => {
    installFakeBridge(
      { deviceApproval: URI, sessionStatus: "starting" },
      { withoutApprovalOpener: true },
    )
    render(() => <DesktopDeviceApprovalDialog />)

    expect(screen.getByText(englishT(DEVICE_APPROVAL_DIALOG_TITLE))).toBeInTheDocument()
    expect(screen.getByTestId("device-approval-code").textContent).toBe("QKVZMC5G")
    const link = screen.getByRole("link", { name: "Open the approval page" })
    expect(link.getAttribute("href")).toBe(URI)
    expect(screen.getByText("Waiting for you to approve this device")).toBeInTheDocument()
  })

  // A `target=_blank` link does nothing inside the desktop webview: the button
  // that was the only way to the approval page opened nothing. The shell opens
  // it in the system browser instead.
  it("the approval page is opened through the shell, in the system browser", () => {
    const fake = installFakeBridge({ deviceApproval: URI, sessionStatus: "starting" })
    render(() => <DesktopDeviceApprovalDialog />)
    expect(screen.queryByRole("link", { name: "Open the approval page" })).toBeNull()
    screen.getByRole("button", { name: "Open the approval page" }).click()
    expect(fake.calls.openedApprovalUrls).toEqual([URI])
    // The dialog says what the approval is for: the conversation waiting on it.
    expect(screen.getByText(/so the conversation can run on this machine/)).toBeInTheDocument()
  })

  it("the code is in the mono face, which is what makes it readable back", () => {
    installFakeBridge({ deviceApproval: URI })
    render(() => <DesktopDeviceApprovalDialog />)
    expect(screen.getByTestId("device-approval-code").className).toContain("font-mono")
  })

  // P6d-FX1 (SK-10): the URI comes from whatever server the user typed into
  // the connect step, so it goes through the same sanitizer the agent's own
  // markdown links go through.
  it("an unsafe verification URI gets no link in the dialog either", () => {
    installFakeBridge({ deviceApproval: "javascript:alert(1)" })
    const { baseElement } = render(() => <DesktopDeviceApprovalDialog />)
    expect(screen.queryByRole("link", { name: "Open the approval page" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Open the approval page" })).toBeNull()
    expect(baseElement.querySelector('a[href^="javascript:"]')).toBeNull()
    // The rest still renders: a user who can read the code can finish in a
    // browser they opened themselves.
    expect(screen.getByText("Waiting for you to approve this device")).toBeInTheDocument()
  })

  it("cancelling clears the code through the shell and returns the control to idle", async () => {
    const fake = installFakeBridge({ deviceApproval: URI, sessionStatus: "starting" })
    render(() => <DesktopDeviceApprovalDialog />)

    screen.getByRole("button", { name: englishT(DEVICE_APPROVAL_CANCEL_ACTION) }).click()

    expect(fake.calls.clearedDeviceApprovals).toBe(1)
    expect(fake.state().deviceApproval).toBeNull()
    expect(fake.state().sessionStatus).toBe("idle")
    // AND RELEASES NOTHING: no claim is taken before the grant is answered, so
    // there is nothing to hand back.
    expect(fake.calls.stopped).toBe(0)
  })

  it("a grant that has been answered takes the dialog with it", async () => {
    const fake = installFakeBridge({ deviceApproval: URI })
    render(() => <DesktopDeviceApprovalDialog />)
    expect(screen.getByTestId("device-approval-code")).toBeInTheDocument()

    // The shell drops the code itself on `ready` and on the reconnect event.
    fake.push({ deviceApproval: null })

    expect(screen.queryByTestId("device-approval-code")).toBeNull()
    expect(screen.queryByText(englishT(DEVICE_APPROVAL_DIALOG_TITLE))).toBeNull()
  })

  it("a window with no session renders nothing: that grant belongs to the login card", () => {
    auth.token = null
    installFakeBridge({ deviceApproval: URI })
    render(() => <DesktopDeviceApprovalDialog />)
    expect(screen.queryByTestId("device-approval-code")).toBeNull()
  })

  it("a browser renders nothing at all", () => {
    auth.token = "signed-in"
    const { baseElement } = render(() => <DesktopDeviceApprovalDialog />)
    expect(baseElement.textContent).toBe("")
  })

  // The login card's own path is unchanged: the same step, in the card, with
  // the way back to the address step it has always had.
  it("the login card still draws the step, with its own way back to the server", () => {
    installFakeBridge({ deviceApproval: URI })
    const onUseDifferentServer = vi.fn()
    render(() => <DesktopDeviceApproval onUseDifferentServer={onUseDifferentServer} />)
    expect(screen.getByTestId("device-approval-code").textContent).toBe("QKVZMC5G")
    screen.getByRole("button", { name: "Use a different server" }).click()
    expect(onUseDifferentServer).toHaveBeenCalledTimes(1)
    // And it is NOT a dialog: the card is the whole window at that point.
    expect(screen.queryByText(englishT(DEVICE_APPROVAL_DIALOG_TITLE))).toBeNull()
  })
})
