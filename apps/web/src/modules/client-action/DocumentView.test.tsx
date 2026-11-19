// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A generated document's frozen blocks as the client reads them: a list of written items
// shows every item, a list over a record shows its line.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { DocumentBlocks } from "~/modules/client-action/DocumentView"
import { I18nProvider } from "~/modules/i18n/i18n-context"

afterEach(cleanup)

function show(blocks: unknown[]) {
  render(() => (
    <I18nProvider initialLocale="en">
      <DocumentBlocks blocks={blocks} />
    </I18nProvider>
  ))
}

describe("DocumentBlocks", () => {
  it("shows every written item of a list", () => {
    show([{ type: "list", items: ["Design", "Build", "Launch"] }])
    const items = screen.getAllByTestId("doc-list-item").map((el) => el.textContent)
    expect(items).toEqual(["Design", "Build", "Launch"])
    expect(screen.getByTestId("doc-list").tagName).toBe("UL")
  })

  it("shows the line of a list over a record", () => {
    show([{ type: "list", from: "lines", line: "One line per row" }])
    expect(screen.getByTestId("doc-list-item").textContent).toBe("One line per row")
  })
})
