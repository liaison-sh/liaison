// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const enable = vi.fn(async () => true)
const dismissBanner = vi.fn()
let isSupported = true
let permissionState: "default" | "granted" | "denied" | "unsupported" = "default"
let isBannerDismissed = false

vi.mock("~/modules/notifications/desktop", () => ({
  isSupported: () => isSupported,
  permissionState: () => permissionState,
  isBannerDismissed: () => isBannerDismissed,
  dismissBanner: () => dismissBanner(),
  enable: () => enable(),
}))

// THE SAME BANNER RUNS INSIDE THE DESKTOP APP. `isDesktop()` is the only
// thing that decides which half of the copy it uses, so the shell is a flag
// here rather than a whole fake bridge.
let desktop = false
vi.mock("~/modules/desktop/desktop-store", () => ({
  isDesktop: () => desktop,
}))

const toasts: unknown[] = []
vi.mock("~/modules/shell/toast-store", () => ({
  addToast: (t: unknown) => toasts.push(t),
}))

import NotificationBanner from "./NotificationBanner"

beforeEach(() => {
  isSupported = true
  permissionState = "default"
  isBannerDismissed = false
  desktop = false
  enable.mockReset().mockResolvedValue(true)
  dismissBanner.mockReset()
  toasts.length = 0
})

describe("NotificationBanner", () => {
  it("renders when supported, permission undecided, and not dismissed", () => {
    render(() => <NotificationBanner />)
    expect(screen.getByTestId("home-notification-banner")).toBeTruthy()
  })

  it("does not render when unsupported", () => {
    isSupported = false
    render(() => <NotificationBanner />)
    expect(screen.queryByTestId("home-notification-banner")).toBeNull()
  })

  it("does not render when permission is already granted", () => {
    permissionState = "granted"
    render(() => <NotificationBanner />)
    expect(screen.queryByTestId("home-notification-banner")).toBeNull()
  })

  it("does not render when permission is denied", () => {
    permissionState = "denied"
    render(() => <NotificationBanner />)
    expect(screen.queryByTestId("home-notification-banner")).toBeNull()
  })

  it("does not render when already dismissed", () => {
    isBannerDismissed = true
    render(() => <NotificationBanner />)
    expect(screen.queryByTestId("home-notification-banner")).toBeNull()
  })

  it("dismiss persists and hides the banner", async () => {
    render(() => <NotificationBanner />)
    fireEvent.click(screen.getByTestId("home-notification-banner-dismiss"))
    expect(dismissBanner).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("home-notification-banner")).toBeNull()
  })

  it("enable calls the Task 6 enable() flow and hides the banner on grant", async () => {
    render(() => <NotificationBanner />)
    fireEvent.click(screen.getByTestId("home-notification-banner-enable"))
    await Promise.resolve()
    await Promise.resolve()
    expect(enable).toHaveBeenCalledTimes(1)
    expect(dismissBanner).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("home-notification-banner")).toBeNull()
  })

  // The banner used to offer a "browser notification" for a tab that is not in
  // front, inside an app that has neither: the desktop window is Liaison, and
  // the permission it is asking for is the system's.
  it("the banner names Liaison and no browser inside the desktop app", () => {
    desktop = true
    render(() => <NotificationBanner />)
    const text = screen.getByTestId("home-notification-banner").textContent ?? ""
    expect(text).toContain("Liaison isn't in front")
    expect(text.toLowerCase()).not.toContain("browser")
    expect(text.toLowerCase()).not.toContain("tab")
  })

  it("the blocked toast names the system settings inside the desktop app", async () => {
    desktop = true
    enable.mockImplementation(async () => {
      permissionState = "denied"
      return false
    })
    render(() => <NotificationBanner />)
    fireEvent.click(screen.getByTestId("home-notification-banner-enable"))
    await waitFor(() => expect(toasts.length).toBe(1))
    const message = (toasts[0] as { message: string }).message
    expect(message).toBe("Notifications are blocked for Liaison in your system settings.")
  })

  it("a denied enable() keeps the banner and shows a blocked toast, without calling dismissBanner", async () => {
    // The real Notification.requestPermission() resolving IS what sets
    // Notification.permission, so by the time enable() (awaited) resolves,
    // permissionState() already reports "denied" — simulate that ordering.
    enable.mockImplementation(async () => {
      permissionState = "denied"
      return false
    })
    permissionState = "default"
    render(() => <NotificationBanner />)
    fireEvent.click(screen.getByTestId("home-notification-banner-enable"))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(dismissBanner).not.toHaveBeenCalled()
    expect(toasts.length).toBe(1)
  })
})
