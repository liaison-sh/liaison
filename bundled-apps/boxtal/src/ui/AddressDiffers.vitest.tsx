// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The prep row's "Address differs" chip, rendered: it opens an inline fold with the order's
// address and the verified one side by side, and each button picks one.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal, Show } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@liaison/host", () => ({ hostLocale: () => "en" }))

const { AddressDiffersChip, AddressDiffersFold } = await import("./AddressDiffers")
const { addressDiffers } = await import("./prep-row-logic")
type Row = import("./prep-row-logic").PrepRow

function row(extra: Partial<Row> = {}): Row {
  return {
    order_key: "so:42",
    document_ref: "doc-42",
    anchor_kind: "invoice",
    invoice_ref: "INV-42",
    order_name: "#42",
    order_created_at: null,
    customer: "Werkton",
    destination: "DE",
    order_tags: [],
    products: "1xES",
    grand_total_minor: null,
    currency: "EUR",
    parcels: [],
    package_count: 0,
    category: "sale",
    status: "to_prepare",
    status_note: null,
    staff_note: null,
    quote: { cheapest: null, alternates: [], offers: [], selected_offer_code: null, selected: null, quoted_at: null, stale: false },
    state: "ready",
    excluded: false,
    validated: false,
    invoice: { state: "issued", document_id: "doc-42", number: "INV-42", approval_id: null, kind: "invoice" },
    shipment: null,
    recipient: null,
    address_check: {
      state: "differs",
      used: { source: "order" },
      order_address: { name: "Lena Brandt", street: "Werkstr. 6", city: "Remagen", postalCode: "53424", countryIsoCode: "DE" },
      verified_address: {
        id: "addr-1",
        street: "Industriepark 3",
        city: "Remagen",
        postalCode: "53424",
        countryIsoCode: "DE",
        verified_at: "2026-10-20T09:00:00.000Z",
        verified_by_name: "Sam Operator",
      },
    },
    ...extra,
  }
}

function Harness(props: { row: Row; onPick: (p: string) => void }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div>
      <AddressDiffersChip row={props.row} open={open()} onToggle={() => setOpen(!open())} />
      <Show when={open()}>
        <AddressDiffersFold row={props.row} busy={false} onPick={props.onPick} />
      </Show>
    </div>
  )
}

afterEach(cleanup)

describe("Address differs chip", () => {
  it("opens a fold with both addresses side by side and picks one", async () => {
    const picks: string[] = []
    render(() => <Harness row={row()} onPick={(p) => picks.push(p)} />)
    const chip = screen.getByTestId("boxtal-prep-address-differs-so:42")
    expect(chip.textContent).toContain("Address differs")
    expect(screen.queryByTestId("boxtal-prep-address-fold-so:42")).toBeNull()
    fireEvent.click(chip)
    expect(screen.getByTestId("boxtal-prep-address-order-so:42").textContent).toContain("Werkstr. 6")
    const verified = screen.getByTestId("boxtal-prep-address-verified-so:42").textContent ?? ""
    expect(verified).toContain("Industriepark 3")
    expect(verified).toContain("Verified 2026-10-20 by Sam Operator")
    fireEvent.click(screen.getByTestId("boxtal-prep-address-use-verified-so:42"))
    fireEvent.click(screen.getByTestId("boxtal-prep-address-use-order-so:42"))
    expect(picks).toEqual(["verified", "order"])
  })

  it("a row with a pick says which one, and that button is the current one", () => {
    const r = row()
    r.address_check!.choice = { pick: "order", chosen_at: "2026-11-01T10:00:00.000Z" }
    render(() => <Harness row={r} onPick={() => {}} />)
    const chip = screen.getByTestId("boxtal-prep-address-differs-so:42")
    expect(chip.textContent).toContain("order's")
    fireEvent.click(chip)
    expect((screen.getByTestId("boxtal-prep-address-use-order-so:42") as HTMLButtonElement).disabled).toBe(true)
  })

  it("is shown only when both addresses are known and differ", () => {
    expect(addressDiffers(row())).toBe(true)
    expect(addressDiffers(row({ address_check: undefined }))).toBe(false)
    const match = row()
    match.address_check!.state = "match"
    expect(addressDiffers(match)).toBe(false)
    const unknownOrder = row()
    unknownOrder.address_check!.order_address = null
    expect(addressDiffers(unknownOrder)).toBe(false)
  })
})
