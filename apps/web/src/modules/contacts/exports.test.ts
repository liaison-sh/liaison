// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import { handleContactEvent } from "./exports"

const mocks = vi.hoisted(() => ({
  detailHandler: vi.fn(),
  invalidatePreview: vi.fn(),
  listHandler: vi.fn(),
}))

vi.mock("~/modules/contacts/contact-detail-store", () => ({
  contactDetailStore: { contacts: {} },
  handleContactEvent: mocks.detailHandler,
}))
vi.mock("~/modules/contacts/contact-list-store", () => ({
  handleContactEvent: mocks.listHandler,
}))
vi.mock("~/modules/shell/entity-preview/entity-preview-store", () => ({
  invalidatePreview: mocks.invalidatePreview,
}))
vi.mock("~/modules/contacts/entity-preview-renderers", () => ({
  registerEntityPreviews: vi.fn(),
}))
vi.mock("./entity-preview-renderers", () => ({
  registerEntityPreviews: vi.fn(),
}))

describe("contacts exports", () => {
  it("invalidates contact previews for update, delete, and merge events", () => {
    handleContactEvent("update", { id: "contact-1" })
    handleContactEvent("delete", { id: "contact-2" })
    handleContactEvent("merge", { id: "contact-3" })

    expect(mocks.invalidatePreview).toHaveBeenCalledWith("kernel", "contact", "contact-1")
    expect(mocks.invalidatePreview).toHaveBeenCalledWith("kernel", "contact", "contact-2")
    expect(mocks.invalidatePreview).toHaveBeenCalledWith("kernel", "contact", "contact-3")
  })
})
