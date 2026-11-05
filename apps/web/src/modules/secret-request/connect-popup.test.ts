// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"
import { openConnectPopup, takeConnectReturn } from "./connect-popup"

describe("connect popup", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, "", "/")
  })

  it("cuts the popup's opener before it goes anywhere (no reverse tabnabbing)", () => {
    // A window-shaped stand-in whose opener starts set, as a real popup's does.
    const popup: Window = Object.assign(Object.create(Window.prototype), { opener: window })
    const open = vi.spyOn(window, "open").mockReturnValue(popup)
    expect(openConnectPopup("r1")).toBe(popup)
    expect(open).toHaveBeenCalledWith("about:blank", "liaison-connect-r1", expect.any(String))
    expect(popup.opener).toBeNull()
  })

  it("reads a same-tab failure for its own card once, as a known reason, and cleans the address", () => {
    window.history.replaceState(
      null,
      "",
      "/threads/t1?connect_request=r1&oauth_error=%3Cb%3E&keep=1#m",
    )
    expect(takeConnectReturn("r2")).toBeNull()
    expect(takeConnectReturn("r1")).toBe("failed")
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/threads/t1?keep=1#m",
    )
    expect(takeConnectReturn("r1")).toBeNull()
    window.history.replaceState(
      null,
      "",
      "/threads/t1?connect_request=r1&oauth_error=access_denied",
    )
    expect(takeConnectReturn("r1")).toBe("access_denied")
  })
})
