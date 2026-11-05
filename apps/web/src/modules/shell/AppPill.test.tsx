// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { AppPill, appIdOfTool } from "~/modules/shell/AppPill"
import { appHue } from "~/modules/shell/app-color"

afterEach(cleanup)

describe("AppPill", () => {
  it("takes the app's hue for both themes", () => {
    render(() => (
      <AppPill appId="shopify" testid="pill">
        Shopify: create discount
      </AppPill>
    ))
    const pill = screen.getByTestId("pill")
    const hue = appHue("shopify")
    expect(pill).toHaveAttribute("data-app", "shopify")
    expect(pill).toHaveAttribute("data-app-tone", "app")
    expect(pill.className).toContain("app-pill")
    expect(pill.style.getPropertyValue("--app-pill-bg-light")).toBe(`hsl(${hue} 60% 94%)`)
    expect(pill.style.getPropertyValue("--app-pill-fg-light")).toBe(`hsl(${hue} 55% 28%)`)
    expect(pill.style.getPropertyValue("--app-pill-fg-dark")).toBe(`hsl(${hue} 60% 78%)`)
  })

  it("is neutral for a kernel action and for no app at all", () => {
    render(() => (
      <>
        <AppPill appId="kernel" testid="kernel">
          Kernel: update skill
        </AppPill>
        <AppPill appId={null} testid="none">
          Unknown
        </AppPill>
      </>
    ))
    for (const id of ["kernel", "none"]) {
      const pill = screen.getByTestId(id)
      expect(pill).toHaveAttribute("data-app-tone", "system")
      expect(pill.className).not.toContain("app-pill")
      expect(pill.className).toContain("text-text-secondary")
      expect(pill.style.getPropertyValue("--app-pill-bg-light")).toBe("")
    }
  })

  it("keeps the surface's own size classes", () => {
    render(() => (
      <AppPill appId="tickets" testid="pill" class="px-1.5 py-px text-[11px] font-semibold">
        Tickets: reply
      </AppPill>
    ))
    const pill = screen.getByTestId("pill")
    expect(pill.className).toContain("rounded-full")
    expect(pill.className).toContain("text-[11px]")
    expect(pill.className).toContain("px-1.5")
  })

  it("renders as a pressed button when it is a filter control", () => {
    render(() => (
      <AppPill as="button" type="button" appId="tickets" pressed testid="chip">
        Tickets: reply
      </AppPill>
    ))
    const chip = screen.getByTestId("chip")
    expect(chip.tagName).toBe("BUTTON")
    expect(chip).toHaveAttribute("aria-pressed", "true")
  })

  it("reads the app from a gated tool id", () => {
    expect(appIdOfTool("invoicing:create_quote_and_issue")).toBe("invoicing")
    expect(appIdOfTool("kernel:update_skill")).toBe("kernel")
    expect(appIdOfTool(null)).toBeNull()
  })
})
