// SPDX-License-Identifier: FSL-1.1-ALv2
// The project page links its client company by name, and opens that company's page.
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ openTab: vi.fn() }))
vi.mock("~/modules/shell/tab-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/tab-store")>()),
  openTab: mocks.openTab,
}))

import { ProjectClientLink } from "./ProjectClientLink"

describe("the project page's client", () => {
  it("the project page links its company by name and opens it", async () => {
    const api = {
      get: vi.fn(async (path: string) => {
        expect(path).toBe("/contacts/companies/c-verdier")
        return { data: { id: "c-verdier", name: "Example Client" } }
      }),
    }
    const view = render(() => <ProjectClientLink api={api as never} companyId="c-verdier" />)
    const link = await waitFor(() => view.getByTestId("project-client-link"))
    expect(link.textContent).toBe("Example Client")
    fireEvent.click(link)
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "company-detail", entityId: "c-verdier" }),
    )
  })

  it("a company the reader cannot see is named so, with no link", async () => {
    const api = { get: vi.fn(async () => Promise.reject(new Error("404"))) }
    const view = render(() => <ProjectClientLink api={api as never} companyId="c-hidden" />)
    await waitFor(() =>
      expect(view.getByTestId("project-client").textContent).toContain("A company you cannot see"),
    )
    expect(view.queryByTestId("project-client-link")).toBeNull()
  })
})
