// SPDX-License-Identifier: FSL-1.1-ALv2
// "?" opens the docs on an ordinary deployment; only a demo deployment shows a menu,
// Documentation first, then the guided tours.
import type { TourListItem } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
const openHelp = vi.fn()
vi.mock("./help-store", () => ({ openHelp: (...args: unknown[]) => openHelp(...args) }))

const { _resetBranding, ensureBrandingLoaded } = await import("~/modules/shell/branding-store")
const { resetTourStore, setTourApi } = await import("~/modules/tours/tour-store")
const { HelpButton } = await import("./HelpButton")

const TOUR: TourListItem = {
  tourId: "kernel.sample",
  app: "kernel",
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beatCount: 2,
  progress: null,
}

async function brand(demo: boolean): Promise<void> {
  const body = { data: { orgName: "Acme", flags: { demo } } }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body))),
  )
  try {
    await ensureBrandingLoaded()
  } finally {
    vi.unstubAllGlobals()
  }
}

const renderButton = () => render(() => <HelpButton buttonClass={(x) => x ?? ""} />)

beforeEach(() => {
  _resetBranding()
  resetTourStore()
  openHelp.mockReset()
})
afterEach(() => cleanup())

describe("HelpButton", () => {
  it("opens the Help tab at once on an ordinary deployment, and lists no tours", async () => {
    const list = vi.fn(async () => [TOUR])
    setTourApi({ list, start: vi.fn(), update: vi.fn(), progress: vi.fn() } as never)
    await brand(false)
    renderButton()
    fireEvent.click(screen.getByTestId("help-button"))
    expect(openHelp).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("help-menu")).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it("on a demo deployment shows Documentation, then the tours", async () => {
    const list = vi.fn(async () => [TOUR])
    setTourApi({ list, start: vi.fn(), update: vi.fn(), progress: vi.fn() } as never)
    await brand(true)
    renderButton()
    fireEvent.pointerDown(screen.getByTestId("help-button"), { button: 0, pointerType: "mouse" })
    expect(await screen.findByTestId("help-menu")).toBeTruthy()
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(await screen.findByTestId("tours-menu-item")).toBeTruthy()
    fireEvent.keyDown(screen.getByTestId("help-menu-docs"), { key: "Enter" })
    await waitFor(() => expect(openHelp).toHaveBeenCalledTimes(1))
  })
})
