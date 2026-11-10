// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { CompanyShareDialog } from "./CompanyShareDialog"

function makeApi(sharing: () => Promise<unknown>) {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/contacts/companies/co1/sharing") return sharing()
      if (path === "/sharing/members") {
        return [{ userId: "u-bob", name: "Bob Builder", email: "bob@corp.test" }]
      }
      if (path === "/sharing/roles") return []
      throw new Error(`Unexpected GET ${path}`)
    }),
    put: vi.fn(async (_path: string, body: unknown) => body),
  }
}

function renderDialog(api: ReturnType<typeof makeApi>) {
  render(() => (
    <ApiContext.Provider value={api as never}>
      <CompanyShareDialog companyId="co1" companyName="Studio Bleu" open onOpenChange={vi.fn()} />
    </ApiContext.Provider>
  ))
}

describe("CompanyShareDialog", () => {
  it("shows who sees the company and offers no Save, since nothing here can change it", async () => {
    renderDialog(
      makeApi(async () => ({
        orgAccess: "editor",
        canManage: true,
        users: [],
        roles: [],
        dimensions: [],
      })),
    )

    expect(await screen.findByTestId("company-share-read-only")).toBeInTheDocument()
    expect(screen.queryByTestId("company-share-save")).toBeNull()
    expect(screen.queryByTestId("company-share-add-person")).toBeNull()
    const view = screen.getByTestId("company-share-access-viewer")
    expect(view).toBeDisabled()
    fireEvent.click(view)
    expect(view.getAttribute("aria-pressed") ?? view.getAttribute("aria-checked")).not.toBe("true")
  })

  it("a sharing read that fails says so and never shows an editable form", async () => {
    renderDialog(
      makeApi(async () => {
        throw new Error("Company not found")
      }),
    )

    expect(await screen.findByTestId("company-share-load-error")).toBeInTheDocument()
    expect(screen.queryByTestId("company-share-save")).toBeNull()
    expect(screen.queryByTestId("company-share-add-person")).toBeNull()
  })
})
