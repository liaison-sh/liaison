// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Remote Auto on this computer's Settings tab: the switch shows what the shell
// answered, so a turn-on the shell's own dialog declined stays off.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { RemoteAutoRow } from "./RemoteAutoRow"

const switchOf = () => screen.getByTestId("computer-remote-auto-switch")
const isOn = () => switchOf().getAttribute("aria-checked") === "true"

describe("RemoteAutoRow", () => {
  it("is off by default and stays off when the shell's dialog declines", async () => {
    const setRemoteAuto = vi.fn(async () => false)
    render(() => <RemoteAutoRow shell={{ remoteAuto: async () => false, setRemoteAuto }} />)
    await waitFor(() => expect(switchOf()).not.toBeDisabled())
    expect(isOn()).toBe(false)
    fireEvent.click(switchOf())
    await waitFor(() => expect(setRemoteAuto).toHaveBeenCalledWith(true))
    await waitFor(() => expect(switchOf()).not.toBeDisabled())
    expect(isOn()).toBe(false)
  })

  it("shows on once the shell says so, and turns off on request", async () => {
    const setRemoteAuto = vi.fn(async (enabled: boolean) => enabled)
    render(() => <RemoteAutoRow shell={{ remoteAuto: async () => true, setRemoteAuto }} />)
    await waitFor(() => expect(isOn()).toBe(true))
    fireEvent.click(switchOf())
    await waitFor(() => expect(setRemoteAuto).toHaveBeenCalledWith(false))
    await waitFor(() => expect(isOn()).toBe(false))
  })
})
