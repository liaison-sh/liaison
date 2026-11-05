// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Addresses section of the contact page: rows are "Not verified" until a
// person verifies them here (the kernel's own page, its own api client, so the
// verify call is allowed), editing a location field sends the row back to
// "Not verified", and a reader who may not edit sees the rows only.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ContactAddress } from "./contact-addresses-api"

const mocks = vi.hoisted(() => ({
  api: {
    getEnvelope: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))

const C = "c1"

function address(over: Partial<ContactAddress> = {}): ContactAddress {
  return {
    id: "a1",
    contactId: C,
    role: "delivery",
    label: null,
    name: null,
    company: "Petit Studio",
    street1: "3 quai Voltaire",
    street2: null,
    city: "Paris",
    postalCode: "75007",
    region: null,
    countryIso2: "FR",
    phone: null,
    email: null,
    origin: "manual",
    verified: false,
    verifiedAt: null,
    verifiedBy: null,
    verifiedByName: null,
    source: null,
    sourceNote: null,
    sourceFileId: null,
    staleAt: null,
    archivedAt: null,
    ...over,
  }
}

const VERIFIED = {
  verified: true,
  verifiedAt: "2026-11-02T10:00:00.000Z",
  verifiedBy: "u1",
  verifiedByName: "Ada Martin",
  source: "purchase_order" as const,
}

function list(rows: ContactAddress[], canEdit = true) {
  mocks.api.getEnvelope.mockResolvedValue({ data: rows, meta: { canEdit } })
}

async function mount() {
  const { ContactAddresses } = await import("./ContactAddresses")
  render(() => <ContactAddresses contactId={C} />)
  await screen.findByTestId("contact-address-a1")
}

describe("ContactAddresses", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.api.get.mockResolvedValue([{ id: "f1", filename: "po-1042.pdf" }])
  })

  it("shows an address as Not verified by default, with its role", async () => {
    list([address()])
    await mount()
    expect(mocks.api.getEnvelope).toHaveBeenCalledWith("/contacts/c1/addresses", expect.anything())
    const badge = screen.getByTestId("contact-address-a1-badge")
    expect(badge).toHaveAttribute("data-verified", "false")
    expect(badge).toHaveTextContent("Not verified")
    expect(screen.getByTestId("contact-address-a1-role")).toHaveTextContent("Delivery")
    expect(screen.getByTestId("contact-address-a1-line")).toHaveTextContent(
      "Petit Studio, 3 quai Voltaire, 75007 Paris, FR",
    )
  })

  it("verifies inline: submits the source, note and file, then shows who verified it and from what", async () => {
    list([address()])
    mocks.api.post.mockResolvedValue(address({ ...VERIFIED, sourceFileId: "f1" }))
    await mount()
    fireEvent.click(screen.getByTestId("contact-address-a1-verify"))
    const form = await screen.findByTestId("contact-address-a1-verify-form")
    expect(form.tagName).toBe("FORM")
    expect(screen.queryByRole("dialog")).toBeNull()
    fireEvent.change(screen.getByTestId("contact-address-a1-verify-source"), {
      target: { value: "purchase_order" },
    })
    fireEvent.input(screen.getByTestId("contact-address-a1-verify-note"), {
      target: { value: "PO 1042" },
    })
    await waitFor(() =>
      expect(screen.getByTestId("contact-address-a1-verify-file")).toHaveTextContent("po-1042.pdf"),
    )
    fireEvent.change(screen.getByTestId("contact-address-a1-verify-file"), {
      target: { value: "f1" },
    })
    fireEvent.click(screen.getByTestId("contact-address-a1-verify-submit"))
    await waitFor(() =>
      expect(mocks.api.post).toHaveBeenCalledWith(
        "/contacts/c1/addresses/a1/verify",
        { source: "purchase_order", note: "PO 1042", fileId: "f1" },
        expect.anything(),
      ),
    )
    const badge = await screen.findByTestId("contact-address-a1-badge")
    await waitFor(() => expect(badge).toHaveAttribute("data-verified", "true"))
    expect(badge.textContent).toMatch(/^Verified .+ by Ada Martin from a purchase order$/)
    expect(screen.queryByTestId("contact-address-a1-verify-form")).toBeNull()
  })

  it("editing the street sends a verified address back to Not verified", async () => {
    list([address(VERIFIED)])
    mocks.api.patch.mockResolvedValue(address({ street1: "5 rue du Bac" }))
    await mount()
    expect(screen.getByTestId("contact-address-a1-badge")).toHaveAttribute("data-verified", "true")
    fireEvent.click(screen.getByTestId("contact-address-a1-edit"))
    const street = await screen.findByTestId("contact-address-a1-field-street1")
    fireEvent.input(street, { target: { value: "5 rue du Bac" } })
    fireEvent.click(screen.getByTestId("contact-address-a1-save"))
    await waitFor(() =>
      expect(mocks.api.patch).toHaveBeenCalledWith(
        "/contacts/c1/addresses/a1",
        { street1: "5 rue du Bac" },
        expect.anything(),
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("contact-address-a1-badge")).toHaveAttribute(
        "data-verified",
        "false",
      ),
    )
    expect(screen.getByTestId("contact-address-a1-badge")).toHaveTextContent("Not verified")
    expect(screen.getByTestId("contact-address-a1-line")).toHaveTextContent("5 rue du Bac")
  })

  it("adds an address inline, saved unverified", async () => {
    list([address()])
    mocks.api.post.mockResolvedValue(address({ id: "a2", role: "billing", city: "Lyon" }))
    await mount()
    fireEvent.click(screen.getByTestId("contact-address-add"))
    fireEvent.change(screen.getByTestId("contact-address-new-field-role"), {
      target: { value: "billing" },
    })
    fireEvent.input(screen.getByTestId("contact-address-new-field-city"), {
      target: { value: "Lyon" },
    })
    fireEvent.click(screen.getByTestId("contact-address-new-save"))
    await waitFor(() =>
      expect(mocks.api.post).toHaveBeenCalledWith(
        "/contacts/c1/addresses",
        expect.objectContaining({ role: "billing", city: "Lyon" }),
        expect.anything(),
      ),
    )
    expect(await screen.findByTestId("contact-address-a2-badge")).toHaveTextContent("Not verified")
  })

  it("marks stale and archives", async () => {
    list([address()])
    mocks.api.post.mockImplementation(async (path: string) =>
      path.endsWith("/stale")
        ? address({ staleAt: "2026-11-03T00:00:00.000Z" })
        : address({ archivedAt: "2026-11-03T00:00:00.000Z" }),
    )
    await mount()
    fireEvent.click(screen.getByTestId("contact-address-a1-stale"))
    expect(await screen.findByTestId("contact-address-a1-stale-chip")).toHaveTextContent("Stale")
    expect(mocks.api.post).toHaveBeenCalledWith(
      "/contacts/c1/addresses/a1/stale",
      { stale: true },
      expect.anything(),
    )
    fireEvent.click(screen.getByTestId("contact-address-a1-archive"))
    await waitFor(() => expect(screen.queryByTestId("contact-address-a1")).toBeNull())
  })

  it("a reader who may not edit sees the rows, and no edit, verify, stale or archive control", async () => {
    list([address(VERIFIED)], false)
    await mount()
    expect(screen.getByTestId("contact-address-a1-badge")).toHaveAttribute("data-verified", "true")
    for (const id of ["edit", "verify", "stale", "archive"]) {
      expect(screen.queryByTestId(`contact-address-a1-${id}`)).toBeNull()
    }
    expect(screen.queryByTestId("contact-address-add")).toBeNull()
    expect(screen.getByTestId("contact-addresses-read-only")).toBeInTheDocument()
  })
})
