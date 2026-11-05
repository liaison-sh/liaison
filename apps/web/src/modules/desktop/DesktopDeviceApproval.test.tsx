// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T15: the device grant, as the next step of the same card.

import { fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import DesktopDeviceApproval from "./DesktopDeviceApproval"
import { installFakeBridge, uninstallFakeBridge } from "./fake-bridge"

const URI = "https://liaison.fabrikam.example/auth/device?code=58KNBUY8"

describe("DesktopDeviceApproval", () => {
  afterEach(() => uninstallFakeBridge())

  it("the device code step renders the code and the approval link", () => {
    installFakeBridge({ deviceApproval: URI }, { withoutApprovalOpener: true })
    render(() => <DesktopDeviceApproval onUseDifferentServer={vi.fn()} />)
    expect(screen.getByTestId("device-approval-code").textContent).toBe("58KNBUY8")
    const link = screen.getByRole("link", { name: "Open the approval page" })
    expect(link.getAttribute("href")).toBe(URI)
    expect(screen.getByText("Waiting for you to approve this device")).toBeInTheDocument()
  })

  it("a verification link with no code still gets its link", () => {
    installFakeBridge(
      { deviceApproval: "https://liaison.fabrikam.example/auth/device" },
      { withoutApprovalOpener: true },
    )
    render(() => <DesktopDeviceApproval onUseDifferentServer={vi.fn()} />)
    expect(screen.queryByTestId("device-approval-code")).toBeNull()
    expect(screen.getByRole("link", { name: "Open the approval page" })).toBeInTheDocument()
  })

  // P6d-FX1 (SK-10): the URI comes from whatever server the user typed into
  // the connect step, and it was rendered raw.
  it("an unsafe verification URI gets no link at all", () => {
    installFakeBridge({ deviceApproval: "javascript:alert(1)" })
    const { container } = render(() => <DesktopDeviceApproval onUseDifferentServer={vi.fn()} />)
    expect(screen.queryByRole("link", { name: "Open the approval page" })).toBeNull()
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
    // The rest of the step still renders: a user who can read the code can
    // still finish in a browser they opened themselves.
    expect(screen.getByText("Waiting for you to approve this device")).toBeInTheDocument()
  })

  it("the step renders nothing while the shell is waiting on nothing", () => {
    installFakeBridge({ deviceApproval: null })
    const { container } = render(() => <DesktopDeviceApproval onUseDifferentServer={vi.fn()} />)
    expect(container.innerHTML).toBe("")
  })

  it("using a different server hands the flow back to the address step", () => {
    installFakeBridge({ deviceApproval: URI })
    const onUseDifferentServer = vi.fn()
    render(() => <DesktopDeviceApproval onUseDifferentServer={onUseDifferentServer} />)
    fireEvent.click(screen.getByRole("button", { name: "Use a different server" }))
    expect(onUseDifferentServer).toHaveBeenCalledTimes(1)
  })

  it("the device step carries no inline style attribute", () => {
    installFakeBridge({ deviceApproval: URI })
    const { container } = render(() => <DesktopDeviceApproval onUseDifferentServer={vi.fn()} />)
    expect(container.querySelectorAll("[style]").length).toBe(0)
  })
})
