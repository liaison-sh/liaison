// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { TextDiff } from "./TextDiff"

afterEach(cleanup)

const FILE = "0b9f0e7c-2d0f-4c1e-9a55-3d6c1c5e8a10"
const PAGE = "1b9f0e7c-2d0f-4c1e-9a55-3d6c1c5e8a11"

function show(before: string, after: string) {
  render(() => (
    <I18nProvider initialLocale="en">
      <TextDiff data-testid="diff" before={before} after={after} />
    </I18nProvider>
  ))
  return screen.getByTestId("diff")
}

describe("TextDiff", () => {
  it("draws each block as the page does, never its markdown or its file codes", () => {
    const diff = show(
      "# Returns\n\nThirty days.",
      `# Returns\n\n**Sixty** days, see [](knowledge:document:${PAGE}).\n\n![](liaison-file:${FILE})`,
    )
    const text = diff.textContent ?? ""
    expect(text).not.toContain("#")
    expect(text).not.toContain("**")
    expect(text).not.toContain("liaison-file")
    expect(text).not.toContain(FILE)
    expect(text).not.toContain(PAGE)
    expect(diff.querySelector("[data-diff='add'] strong")?.textContent).toBe("Sixty")
    expect(text).toContain("[Page link]")
    // The image is drawn by the page's file view (here its neutral label), in an added row.
    expect(diff.querySelector("[data-diff='add'] [data-page-file]")).toBeTruthy()
    expect(diff.querySelector("[data-diff='del']")?.textContent).toContain("Thirty days.")
    expect(diff.querySelector("[data-diff='same'] h1")?.textContent).toBe("Returns")
  })

  it("draws no row for a blank separator line, and says which rows were added or removed", () => {
    const diff = show("A\n\nB", "A\n\nC")
    expect(diff.querySelectorAll("[data-diff]").length).toBe(3)
    expect(diff.querySelector("[data-diff='add']")?.textContent).toContain("Added")
    expect(diff.querySelector("[data-diff='del']")?.textContent).toContain("Removed")
  })
})
