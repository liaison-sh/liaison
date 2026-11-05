// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shared kit's DOM behaviour. Runs under vitest + jsdom (the `app-ui-ui`
// suite); the include pattern is `*.vitest.tsx` so the bun half of the
// workspace cannot discover a Solid component test it cannot transform.
//
// A gestalt walk of the Ads app at phone width read "Dashboard" twice down
// the screen: once in the kernel shell's phone header bar, once in the pane's
// own PageHeader right under it. Every first party app builds its header
// here, so this is where the phone rule is pinned.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { PageHeader } from "./kit"

/** The shell's phone tier is `max-sm` (below 640px) in the same Tailwind
 *  scale the kernel builds these classes from. */
const PHONE_HIDDEN = "max-sm:hidden"

describe("PageHeader at phone width", () => {
  afterEach(cleanup)

  it("hides the pane title the phone header already shows", () => {
    render(() => <PageHeader title="Dashboard" testid="ads-header" />)
    const titleGroup = screen.getByTestId("ads-header").querySelector("[data-page-title]")

    expect(titleGroup).not.toBeNull()
    expect(titleGroup?.className).toContain(PHONE_HIDDEN)
  })

  it("gets a title-only header out of the way instead of leaving an empty bar", () => {
    render(() => <PageHeader title="Dashboard" subtitle="Spend at a glance" testid="ads-header" />)
    const header = screen.getByTestId("ads-header")

    expect(header.getAttribute("data-phone-header")).toBe("hidden")
    expect(header.className).toContain(PHONE_HIDDEN)
  })

  it("keeps a header that carries actions, because those have nowhere else to go", () => {
    render(() => (
      <PageHeader
        title="Campaigns"
        testid="ads-header"
        actions={
          <button type="button" data-testid="ads-action">
            New
          </button>
        }
      />
    ))
    const header = screen.getByTestId("ads-header")

    expect(header.getAttribute("data-phone-header")).toBe("actions")
    expect(header.className).not.toContain(PHONE_HIDDEN)
    expect(screen.getByTestId("ads-action")).toBeTruthy()
    // The bar stays, the duplicated title still does not.
    expect(header.querySelector("[data-page-title]")?.className).toContain(PHONE_HIDDEN)
  })

  it("still renders the title for a desktop reader", () => {
    render(() => <PageHeader title="Dashboard" count={3} testid="ads-header" />)

    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeTruthy()
    expect(screen.getByText("3")).toBeTruthy()
  })
})
