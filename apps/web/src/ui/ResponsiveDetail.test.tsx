// SPDX-License-Identifier: FSL-1.1-ALv2
import { render } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { ResponsiveDetail } from "~/ui/ResponsiveDetail"

function renderDetail() {
  return render(() => (
    <ResponsiveDetail
      content={<article>Conversation stream</article>}
      metadata={<aside>Ticket metadata</aside>}
    />
  ))
}

describe("ResponsiveDetail", () => {
  it("content renders before metadata in DOM order", () => {
    const { container } = renderDetail()
    const content = container.querySelector('[data-responsive="content"]')!
    const metadata = container.querySelector('[data-responsive="metadata"]')!
    expect(content).not.toBeNull()
    expect(metadata).not.toBeNull()
    const position = content.compareDocumentPosition(metadata)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("container carries flex-col by default and md:flex-row for wide viewports", () => {
    const { container } = renderDetail()
    const root = container.querySelector('[data-responsive="detail"]')!
    expect(root.className).toContain("flex-col")
    expect(root.className).toContain("md:flex-row")
  })
})
