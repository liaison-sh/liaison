// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every prep-row button state is a decidable function of the row, and the refetch rule is data.
// These are the oracles behind the rework's two headline claims: a row action patches ONE row, and
// no button ever promises something the row cannot do.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "bun:test"
import {
  CATEGORY_LABELS,
  CATEGORY_SHORT_LABELS,
  canShip,
  categoryFullLabel,
  categoryLockReason,
  createRunMutation,
  invoiceControlState,
  LABEL_LABELS,
  LABEL_WAIT_MS,
  labelState,
  keepUnchangedRows,
  mergeRows,
  mutationPlan,
  NO_INVOICE_TOOLTIP,
  pollPlan,
  pollTick,
  quoteButtonState,
  quotedPriceMajor,
  rowTintClass,
  shipDisabledReason,
  shipParams,
  STATUS_LABELS,
  type PollTickState,
  type PrepInvoiceState,
  type PrepOffer,
  type PrepRow,
} from "./prep-row-logic"

function offer(over: Partial<PrepOffer> = {}): PrepOffer {
  return {
    carrier: "Chronopost",
    service: "Chrono 13",
    offer_code: "CHRP-Chrono13",
    price_ht_minor: 820,
    price_ttc_minor: 990,
    currency: "EUR",
    delivery_date: null,
    eta_business_days: 2,
    is_pickup_point: false,
    ...over,
  }
}

/** A row that can ship. Every test below removes exactly one thing from it. */
function shippableRow(over: Partial<PrepRow> = {}): PrepRow {
  const o = offer()
  return {
    order_key: "so:5001",
    document_ref: "doc-1",
    anchor_kind: "invoice",
    invoice_ref: "INV-001",
    order_name: "#1001",
    order_created_at: "2026-07-01T00:00:00.000Z",
    customer: "Alice Example",
    destination: "FR",
    order_tags: [],
    products: "1xES",
    grand_total_minor: 69900,
    currency: "EUR",
    parcels: [{ length: 30, width: 20, height: 15, weight: 2.4 }],
    package_count: 1,
    category: "sale",
    status: "to_prepare",
    status_note: null,
    staff_note: null,
    quote: {
      cheapest: o,
      alternates: [],
      offers: [o],
      selected_offer_code: null,
      selected: null,
      quoted_at: "2026-07-02T00:00:00.000Z",
      stale: false,
    },
    state: "ready",
    excluded: false,
    validated: false,
    invoice: { state: "issued", document_id: "doc-1", number: "INV-001", approval_id: null, kind: "invoice" },
    shipment: null,
    recipient: {
      name: "Alice Example",
      email: "alice@example.com",
      phone: "+33612345678",
      street: "5 rue du Test",
      city: "Lyon",
      postalCode: "69001",
      countryIsoCode: "FR",
      complete: true,
    },
    ...over,
  }
}

describe("mutationPlan: a row action patches one row, it never re-lists the grid", () => {
  it("routes every ROW action to patch and only the three LIST actions to refetch", () => {
    const refetching = Object.entries(mutationPlan)
      .filter(([, plan]) => plan === "refetch")
      .map(([name]) => name)
      .sort()
    expect(refetching).toEqual(["pull_orders", "refresh_stale", "toggle_excluded"])
    for (const action of [
      "set_status",
      "set_note",
      "set_category",
      "set_package",
      "select_offer",
      "quote",
      "ship",
      "check_documents",
      "exclude",
      "restore",
      "add_shipment",
      "address_choice",
    ]) {
      expect(mutationPlan[action as keyof typeof mutationPlan]).toBe("patch")
    }
  })
})

describe("createRunMutation: the refetch rule as a mechanism, driven directly rather than trusted", () => {
  // The oracle this replaces (`toContain("runMutation")` / `toContain("mutationPlan")` against
  // PrepGrid.tsx's own source) passed no matter what any handler did, because both strings appear
  // in the file's header comment. These tests instead call the REAL function PrepGrid.tsx builds
  // with `createRunMutation` and prove the two things the rework promises: a row action patches its
  // row and never touches refetch, and a list action refetches and never touches a row.
  function stub() {
    const calls = { refetch: 0, patched: [] as string[] }
    const runMutation = createRunMutation({
      refetch: async () => {
        calls.refetch++
      },
      patchRow: async (key) => {
        calls.patched.push(key)
      },
    })
    return { runMutation, calls }
  }

  it("patches the row and never refetches, for every row action in the plan", async () => {
    for (const action of ["set_status", "set_note", "set_category", "set_package", "select_offer", "quote", "ship", "check_documents", "exclude", "restore", "add_shipment"] as const) {
      const { runMutation, calls } = stub()
      await runMutation(action, "so:1", async () => {})
      expect(calls.refetch).toBe(0)
      expect(calls.patched).toEqual(["so:1"])
    }
  })

  it("refetches and never patches a row, for every list action in the plan", async () => {
    for (const action of ["pull_orders", "refresh_stale", "toggle_excluded"] as const) {
      const { runMutation, calls } = stub()
      await runMutation(action, null, async () => {})
      expect(calls.refetch).toBe(1)
      expect(calls.patched).toEqual([])
    }
  })

  it("reverts to the read on failure and never patches a failed row action", async () => {
    const { runMutation, calls } = stub()
    let sawError: unknown
    const runMutationErroring = createRunMutation({
      refetch: async () => {
        calls.refetch++
      },
      patchRow: async (key) => {
        calls.patched.push(key)
      },
      setRowError: (_key, message) => {
        sawError = message
      },
    })
    await runMutationErroring("set_status", "so:1", async () => {
      throw new Error("boom")
    })
    expect(calls.patched).toEqual([])
    expect(calls.refetch).toBe(0)
    expect(sawError).toBe("boom")
  })
})

describe("createRunMutation: the busy flag lives exactly as long as the write", () => {
  /** A stub whose confirmation read is a promise the test resolves by hand. */
  function deferredStub(over: { patchRow?: () => Promise<void> } = {}) {
    const busy: boolean[] = []
    let settlePatch: (() => void) | null = null
    const patched = new Promise<void>((resolve) => {
      settlePatch = resolve
    })
    const runMutation = createRunMutation({
      refetch: async () => {},
      patchRow: over.patchRow ?? (() => patched),
      setRowBusy: (_key, isBusy) => {
        busy.push(isBusy)
      },
      setRowError: () => {},
    })
    return { runMutation, busy, settlePatch: () => settlePatch?.() }
  }

  it("clears busy when the write settles, WITHOUT waiting for the confirmation read", async () => {
    const { runMutation, busy, settlePatch } = deferredStub()
    const run = runMutation("set_status", "so:1", async () => {})
    // One microtask turn is all the write needs; the read is still outstanding.
    await Promise.resolve()
    await Promise.resolve()
    expect(busy, "the row is still marked busy while only the confirmation read is in flight").toEqual([
      true,
      false,
    ])
    settlePatch()
    await run
    expect(busy).toEqual([true, false])
  })

  it("clears busy when the write fails", async () => {
    const { runMutation, busy } = deferredStub()
    await runMutation("set_status", "so:1", async () => {
      throw new Error("boom")
    })
    expect(busy).toEqual([true, false])
  })

  it("clears busy even when the confirmation read NEVER settles", async () => {
    // A control unmounted mid-flight, or a read that simply never comes back. The row must not be
    // left reading "Working" with no way out, so this asserts the release without ever awaiting
    // runMutation itself (which by construction cannot settle here).
    const { runMutation, busy } = deferredStub({ patchRow: () => new Promise<void>(() => {}) })
    void runMutation("set_status", "so:1", async () => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(busy).toEqual([true, false])
  })

  it("clears busy even when the busy setter itself throws on the way in", async () => {
    // `setRowBusy` is a Solid signal write, so it renders synchronously and a render error surfaces
    // from the setter. That must not strand the flag it just set.
    const busy: boolean[] = []
    const runMutation = createRunMutation({
      refetch: async () => {},
      patchRow: async () => {},
      setRowBusy: (_key, isBusy) => {
        busy.push(isBusy)
        if (isBusy) throw new Error("render failed")
      },
      setRowError: () => {},
    })
    await runMutation("set_status", "so:1", async () => {})
    expect(busy).toEqual([true, false])
  })
})

// PrepGrid.tsx no longer calls `refetch()` itself: it hands the function to `createRunMutation`,
// which is the ONLY place that ever invokes it, guarded by the plan. That moves the regression this
// test exists to catch (a stray `await refetch()` slipped into a row handler) to an even sharper
// signal in PrepGrid.tsx: a direct `refetch()` CALL there at all, rather than the reference being
// passed, is itself the bug. And every row-mutating tool call must sit lexically inside the
// `runMutation(<action>, ...)` call that owns it.
describe("PrepGrid.tsx wiring: refetch() is invoked from exactly one place, the plan-guarded line", () => {
  const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")

  it("never calls refetch() directly: it only hands the reference to createRunMutation", () => {
    expect([...src.matchAll(/\brefetch\(\)/g)]).toHaveLength(0)
    expect(src).toContain("createRunMutation({ setRowBusy, setRowError, refetch, patchRow })")
  })

  it("the mechanism's one refetch() call, in createRunMutation, is guarded by mutationPlan[name] === \"refetch\"", () => {
    const modSrc = readFileSync(new URL("./prep-row-logic.ts", import.meta.url), "utf8")
    // `deps.refetch()`, not the bare word: the module's own header comment mentions `refetch()`
    // in prose while explaining the OLD bug, which is not a call site.
    const refetchCalls = [...modSrc.matchAll(/\bdeps\.refetch\(\)/g)]
    expect(refetchCalls).toHaveLength(1)
    const call = refetchCalls[0]!
    const lineStart = modSrc.lastIndexOf("\n", call.index) + 1
    const lineEnd = modSrc.indexOf("\n", call.index)
    const line = modSrc.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    expect(line).toContain('mutationPlan[name] === "refetch"')
  })

  it("routes every row-mutating tool call through the runMutation( call that names its action", () => {
    const rowActions: Array<[string, string]> = [
      ["set_status", "prep_set_status"],
      ["set_category", "prep_set_category"],
      ["set_package", "shipment_draft_set_package"],
      ["select_offer", "prep_select_offer"],
      ["quote", "prep_sync"],
      ["exclude", "prep_exclude"],
      ["restore", "prep_restore"],
      ["ship", "create_shipment"],
      ["check_documents", "get_documents"],
    ]
    for (const [action, tool] of rowActions) {
      const marker = `runMutation("${action}"`
      const idx = src.indexOf(marker)
      expect(idx, `no runMutation("${action}" call site found`).toBeGreaterThan(-1)
      // The handler body sits within a bounded window after its runMutation( call, comfortably
      // inside the next declaration; the tool it invokes must be found there, not merely somewhere
      // else in the file.
      const block = src.slice(idx, idx + 700)
      expect(block, `runMutation("${action}" does not appear to call ${tool}`).toContain(tool)
    }
  })
})

describe("shipDisabledReason: an address a person must pick holds the row", () => {
  const differs = (): NonNullable<PrepRow["address_check"]> => ({
    state: "differs",
    used: { source: "order" },
    order_address: { street: "Werkstr. 6", postalCode: "53424", countryIsoCode: "DE" },
    verified_address: { id: "addr-1", street: "Industriepark 3", postalCode: "53424", countryIsoCode: "DE" },
  })
  it("holds Ship while the order and the verified address differ and nobody picked", () => {
    expect(shipDisabledReason(shippableRow({ address_check: differs() }))).toContain("Pick which one to use")
  })
  it("a pick releases it; no verified address never holds", () => {
    expect(
      shipDisabledReason(shippableRow({ address_check: { ...differs(), choice: { pick: "verified", chosen_at: null } } })),
    ).toBeNull()
    expect(shipDisabledReason(shippableRow({ address_check: { ...differs(), state: "match" } }))).toBeNull()
    expect(shipDisabledReason(shippableRow())).toBeNull()
  })
})

describe("shipDisabledReason: the first thing the operator has to fix, named", () => {
  it("enables Ship on a complete row", () => {
    expect(shipDisabledReason(shippableRow())).toBeNull()
    expect(canShip(shippableRow())).toBe(true)
  })

  const cases: Array<[string, Partial<PrepRow>, string]> = [
    ["on hold wins over everything", { status: "on_hold" }, "on hold"],
    [
      "already shipped",
      { shipment: { id: "s1", order_status: "CONFIRMED", tracking_number: null, has_label: true, created_at: "2026-07-03T00:00:00.000Z" } },
      "already been bought",
    ],
    ["invoicing not installed", { invoice: { state: "not_available", document_id: null, number: null, approval_id: null, kind: null } }, "not installed"],
    ["no document", { document_ref: null, state: "needs_document", reason: "No invoice issued for this order yet" }, "No invoice issued for this order yet"],
    ["document not issued", { invoice: { state: "pending_approval", document_id: null, number: null, approval_id: "a1", kind: "proforma" } }, "not issued yet"],
    ["not synced", { state: "not_synced" }, "not been synced"],
    ["needs fix", { state: "needs_fix", reason: "Missing HS code" }, "Missing HS code"],
    ["no offers", { quote: { ...shippableRow().quote, offers: [], cheapest: null } }, "No carrier offer"],
    ["stale quote", { quote: { ...shippableRow().quote, stale: true } }, "out of date"],
    ["incomplete address", { recipient: { ...shippableRow().recipient!, complete: false } }, "incomplete"],
  ]
  for (const [name, patch, needle] of cases) {
    it(`names the blocker: ${name}`, () => {
      const reason = shipDisabledReason(shippableRow(patch))
      expect(reason).not.toBeNull()
      expect(reason!).toContain(needle)
      expect(canShip(shippableRow(patch))).toBe(false)
    })
  }

  it("reports the hold before any other blocker, so the row says the truth an operator can act on", () => {
    const row = shippableRow({ status: "on_hold", state: "not_synced", quote: { ...shippableRow().quote, offers: [] } })
    expect(shipDisabledReason(row)).toContain("on hold")
  })

  it("names the missing field instead of a generic incomplete message", () => {
    // ticket 10419 follow-up: this used to say "the recipient address is incomplete" with no
    // hint which field to fix, contradicting missingRecipientFields' own purpose.
    const missingEmail = shippableRow({
      recipient: { ...shippableRow().recipient!, email: null, complete: false, missing_fields: ["email"] },
    })
    expect(shipDisabledReason(missingEmail)).toBe(
      "The recipient is missing its email, so the carrier would refuse the label.",
    )

    const missingBoth = shippableRow({
      recipient: {
        ...shippableRow().recipient!,
        email: null,
        phone: null,
        complete: false,
        missing_fields: ["email", "phone"],
      },
    })
    expect(shipDisabledReason(missingBoth)).toBe(
      "The recipient is missing its email, phone, so the carrier would refuse the label.",
    )
  })
})

describe("quotedPriceMajor + shipParams: the price handed to create_shipment is in MAJOR units", () => {
  it("converts a 990-minor EUR offer to 9.9, never 990", () => {
    expect(quotedPriceMajor({ price_ttc_minor: 990, currency: "EUR" })).toBe(9.9)
  })

  it("is exponent aware: a zero-decimal currency is not divided by 100", () => {
    expect(quotedPriceMajor({ price_ttc_minor: 1200, currency: "JPY" })).toBe(1200)
  })

  it("sends no recipient address when nobody edited it: the server resolves the address", () => {
    const params = shipParams(shippableRow())!
    expect(params.recipient_address).toBeUndefined()
    expect(params.draft_id).toBe("doc-1")
  })

  it("builds the create_shipment body from the row, with the recipient a person edited", () => {
    const params = shipParams(shippableRow({ recipient_edited: true }))!
    expect(params).toMatchObject({
      draft_id: "doc-1",
      offer_code: "CHRP-Chrono13",
      quoted_price_ttc: 9.9,
      quoted_currency: "EUR",
      recipient_phone: "+33612345678",
    })
    expect(params.recipient_address).toMatchObject({ city: "Lyon", postalCode: "69001", countryIsoCode: "FR" })
  })

  it("buys the operator's chosen offer, not the cheapest, when one is chosen", () => {
    const chosen = offer({ offer_code: "UPSE-Express", carrier: "UPS", price_ttc_minor: 2160 })
    const row = shippableRow()
    row.quote = { ...row.quote, offers: [row.quote.cheapest!, chosen], selected: chosen, selected_offer_code: chosen.offer_code }
    const params = shipParams(row)!
    expect(params.offer_code).toBe("UPSE-Express")
    expect(params.quoted_price_ttc).toBe(21.6)
  })
})

describe("labelState: Label is enabled only once the label PDF exists", () => {
  const t0 = Date.parse("2026-07-03T10:00:00.000Z")
  const shipped = (over: Record<string, unknown> = {}) =>
    shippableRow({
      shipment: {
        id: "s1",
        order_status: "CONFIRMED",
        tracking_number: "TRK1",
        has_label: false,
        created_at: "2026-07-03T10:00:00.000Z",
        ...over,
      },
    })

  it("is disabled with no shipment at all", () => {
    expect(labelState(shippableRow(), t0)).toBe("disabled")
  })

  it("waits while the shipment exists without a LABEL document", () => {
    expect(labelState(shipped(), t0 + 60_000)).toBe("waiting")
    expect(LABEL_LABELS.waiting).toBe("Label on its way")
  })

  it("flips to check_documents at five minutes, never sooner", () => {
    expect(labelState(shipped(), t0 + LABEL_WAIT_MS - 1)).toBe("waiting")
    expect(labelState(shipped(), t0 + LABEL_WAIT_MS)).toBe("check_documents")
  })

  it("is ready the moment the label document lands", () => {
    expect(labelState(shipped({ has_label: true }), t0 + 1000)).toBe("ready")
  })

  it("polls the waiting row every 5s and stops at the five minute mark", () => {
    expect(pollPlan(shipped(), t0 + 1000)).toMatchObject({ intervalMs: 5000, reason: "label", timeoutMs: LABEL_WAIT_MS })
    expect(pollPlan(shipped({ has_label: true }), t0 + 1000).intervalMs).toBeNull()
    expect(pollPlan(shippableRow(), t0).intervalMs).toBeNull()
  })

  it("polls a generating PDF every 3s for at most a minute", () => {
    const row = shippableRow({
      invoice: { state: "generating", document_id: "doc-1", number: "INV-001", approval_id: null, kind: "invoice" },
    })
    expect(pollPlan(row, t0)).toMatchObject({ intervalMs: 3000, timeoutMs: 60_000, reason: "invoice_pdf" })
  })
})

describe("pollTick: which rows are due on a single 1s tick", () => {
  const t0 = Date.parse("2026-07-03T10:00:00.000Z")
  const waitingRow = (key: string) =>
    shippableRow({
      order_key: key,
      shipment: {
        id: `s-${key}`,
        order_status: "CONFIRMED",
        tracking_number: `TRK-${key}`,
        has_label: false,
        created_at: "2026-07-03T10:00:00.000Z",
      },
    })
  const notBusy = () => false

  // This is the case the batching fix targets: a bulk ship arms several rows for a label poll at
  // once, so the FIRST tick that actually re-reads them (the second one; the first only arms the
  // state) must ask for all of them in one shot, not one prep_list call per row.
  it("reads all due label rows in one batched call, not one per row", () => {
    const rows = [waitingRow("so:1"), waitingRow("so:2"), waitingRow("so:3")]
    const pollStarted = new Map<string, PollTickState>()

    // Tick 1 only arms the poll window for each row (matches the inline loop's original behaviour).
    const armed = pollTick(rows, pollStarted, t0, notBusy)
    expect(armed.dueLabelKeys).toEqual([])

    // Tick 2, 5s later, is when all three come due together.
    const due = pollTick(rows, pollStarted, t0 + 5000, notBusy)
    expect(due.dueLabelKeys).toEqual(["so:1", "so:2", "so:3"])
    expect(due.dueInvoicePdfKeys).toEqual([])
    expect(due.timedOutKeys).toEqual([])
  })

  it("skips a row that is busy", () => {
    const rows = [waitingRow("so:1"), waitingRow("so:2")]
    const pollStarted = new Map<string, PollTickState>()
    pollTick(rows, pollStarted, t0, notBusy)
    const due = pollTick(rows, pollStarted, t0 + 5000, (key) => key === "so:2")
    expect(due.dueLabelKeys).toEqual(["so:1"])
  })

  it("reports a timeout once the plan's own timeoutMs is exceeded, and drops the row", () => {
    // A label row cannot exercise this branch: labelState() itself flips the row out of
    // "waiting" at the five minute mark, so pollPlan already returns NO_POLL and the row just
    // drops as no-longer-live. A generating invoice_pdf never changes its own state, so ITS
    // timeout is enforced entirely by the tick, which is the branch under test here.
    const pdfRow = shippableRow({
      order_key: "so:1",
      invoice: { state: "generating", document_id: "doc-1", number: "INV-001", approval_id: null, kind: "invoice" },
    })
    const rows = [pdfRow]
    const pollStarted = new Map<string, PollTickState>()
    pollTick(rows, pollStarted, t0, notBusy)
    const timedOut = pollTick(rows, pollStarted, t0 + 60_001, notBusy)
    expect(timedOut.timedOutKeys).toEqual([{ key: "so:1", reason: "invoice_pdf" }])
    expect(timedOut.dueInvoicePdfKeys).toEqual([])
    expect(pollStarted.has("so:1")).toBe(false)
  })

  it("keeps invoice_pdf rows out of the batched label list", () => {
    const pdfRow = shippableRow({
      order_key: "so:9",
      invoice: { state: "generating", document_id: "doc-9", number: "INV-9", approval_id: null, kind: "invoice" },
    })
    const pollStarted = new Map<string, PollTickState>()
    pollTick([pdfRow], pollStarted, t0, notBusy)
    const due = pollTick([pdfRow], pollStarted, t0 + 3000, notBusy)
    expect(due.dueInvoicePdfKeys).toEqual(["so:9"])
    expect(due.dueLabelKeys).toEqual([])
  })
})

describe("invoiceControlState + quoteButtonState + categoryLockReason", () => {
  it("shows the issued number and offers a download", () => {
    const c = invoiceControlState(shippableRow())
    expect(c).toMatchObject({ state: "issued", label: "INV-001", canDownload: true })
    // The state word moved to the tooltip; the number is what the cell renders.
    expect(c.tooltip).toBe("Issued INV-001")
  })

  it("names a proforma anchor as a proforma, not as an invoice", () => {
    const row = shippableRow({
      anchor_kind: "proforma",
      invoice: { state: "issued", document_id: "prof-1", number: "PF-1", approval_id: null, kind: "proforma" },
    })
    const c = invoiceControlState(row)
    expect(c.label).toBe("PF-1")
    expect(c.tooltip).toBe("Proforma PF-1")
  })

  it("falls back to the kind word when an issued anchor has no number yet", () => {
    for (const [kind, word] of [["invoice", "Issued"], ["proforma", "Proforma"]] as const) {
      const row = shippableRow({
        invoice: { state: "issued", document_id: "d-1", number: null, approval_id: null, kind },
      })
      const c = invoiceControlState(row)
      expect(c.label).toBe(word)
      expect(c.tooltip).toBe(word)
    }
  })

  it("explains the auto-issue flow rather than offering a button that does nothing", () => {
    const row = shippableRow({
      invoice: { state: "missing", document_id: null, number: null, approval_id: null, kind: null },
    })
    const c = invoiceControlState(row)
    expect(c).toMatchObject({ label: "No invoice", canDownload: false, showApprovalsLink: true })
    expect(c.tooltip).toBe(`No invoice yet. ${NO_INVOICE_TOOLTIP}`)
  })

  // The Document column renders under the opaque sticky Actions cell at 1440x900
  // with the agent panel open, and what an operator actually read in prod on
  // 2026-09-04 was the fragment "Iss 20:" where the number should be. So the
  // pill's label is now SHORT and the full wording rides on the `title`. This
  // pins both halves for EVERY invoice state at once: nothing renders longer
  // than the document number itself, nothing loses its wording, and an issued
  // row never loses the number (the one thing that is cross-checked).
  it("keeps every document label short with the full wording on the tooltip", () => {
    const inv = (over: Partial<PrepRow["invoice"]>): PrepRow["invoice"] => ({
      state: "missing",
      document_id: null,
      number: null,
      approval_id: null,
      kind: null,
      ...over,
    })
    const cases: Array<{ state: PrepInvoiceState; invoice: PrepRow["invoice"]; label: string; full: string }> = [
      {
        state: "issued",
        invoice: inv({ state: "issued", document_id: "d", number: "INV-2026-3493", kind: "invoice" }),
        label: "INV-2026-3493",
        full: "Issued",
      },
      {
        state: "issued",
        invoice: inv({ state: "issued", document_id: "d", number: "PRO-2026-0007", kind: "proforma" }),
        label: "PRO-2026-0007",
        full: "Proforma",
      },
      {
        state: "pending_approval",
        invoice: inv({ state: "pending_approval", approval_id: "a-1", kind: "proforma" }),
        label: "Pending",
        full: "Pending approval",
      },
      {
        state: "generating",
        invoice: inv({ state: "generating", document_id: "d", number: "INV-2", kind: "invoice" }),
        label: "Generating",
        full: "rendering",
      },
      { state: "missing", invoice: inv({}), label: "No invoice", full: "No invoice yet" },
      {
        state: "not_available",
        invoice: inv({ state: "not_available" }),
        label: "Not available",
        full: "invoicing app is not installed",
      },
    ]
    // Every state is covered, so a new one cannot slip in unmeasured.
    const covered = new Set(cases.map((c) => c.state))
    const allStates: PrepInvoiceState[] = [
      "generating",
      "issued",
      "missing",
      "not_available",
      "pending_approval",
    ]
    expect([...covered].sort()).toEqual(allStates.sort())
    for (const c of cases) {
      const got = invoiceControlState(shippableRow({ invoice: c.invoice }))
      expect(got.state, `state for ${c.label}`).toBe(c.state)
      expect(got.label, `label for ${c.state}`).toBe(c.label)
      // Short: no label may exceed the width of a document number, which is the
      // one string the column cannot shorten.
      expect(got.label.length, `label length for ${c.state}`).toBeLessThanOrEqual("INV-2026-3493".length)
      // And nothing is lost: the wording the label dropped is on the tooltip.
      expect(got.tooltip, `tooltip for ${c.state}`).toContain(c.full)
      expect(got.tooltip, `tooltip for ${c.state}`).not.toContain("--")
      expect(got.tooltip, `tooltip for ${c.state}`).not.toMatch(/[\u2013\u2014]/)
    }
    // The number itself is NEVER dropped.
    const issued = invoiceControlState(
      shippableRow({ invoice: inv({ state: "issued", document_id: "d", number: "INV-2026-3493", kind: "invoice" }) }),
    )
    expect(issued.label).toContain("INV-2026-3493")
    expect(issued.tooltip).toContain("INV-2026-3493")
  })

  it("says the quote button's word: Sync, Re-quote, No offers", () => {
    expect(quoteButtonState(shippableRow({ state: "not_synced" })).label).toBe("Sync")
    expect(quoteButtonState(shippableRow({ quote: { ...shippableRow().quote, stale: true } })).label).toBe("Re-quote")
    expect(quoteButtonState(shippableRow({ quote: { ...shippableRow().quote, offers: [], cheapest: null } })).label).toBe("No offers")
    expect(quoteButtonState(shippableRow({ state: "needs_document", document_ref: null })).disabled).toBe(true)
    expect(quoteButtonState(shippableRow()).label).toBe("Quote")
  })

  it("locks the category while a proforma is pending or a label is bought, and only then", () => {
    expect(categoryLockReason(shippableRow())).toBeNull()
    expect(
      categoryLockReason(
        shippableRow({ invoice: { state: "pending_approval", document_id: null, number: null, approval_id: "a1", kind: "proforma" } }),
      ),
    ).toContain("waiting for approval")
    expect(
      categoryLockReason(
        shippableRow({ shipment: { id: "s1", order_status: "CONFIRMED", tracking_number: null, has_label: true, created_at: null } }),
      ),
    ).toContain("already been bought")
  })
})

describe("rowTintClass: the WHOLE row carries the status, not one cell", () => {
  it("dims and tints an on-hold row, tints a validated one, leaves the default plain", () => {
    // Red, not a quiet grey: the held row is the one that must NOT be packed (ticket-10505).
    expect(rowTintClass("on_hold")).toContain("bg-error-glow/40")
    expect(rowTintClass("on_hold")).toContain("border-l-error")
    expect(rowTintClass("on_hold")).not.toContain("opacity-60")
    expect(rowTintClass("validated")).toContain("bg-success/5")
    expect(rowTintClass("to_prepare")).not.toContain("opacity")
  })

  // ticket-10507 / ticket-10522: the packer needs the rows still to do to stand out from the ones
  // already boxed, so a packed row greys out whole.
  it("greys a packed row: light grey ground plus muted text", () => {
    const tint = rowTintClass("to_prepare", true)
    expect(tint).toContain("bg-surface-hover/60")
    expect(tint).toContain("text-text-tertiary")
    // Not the validated green: packed is a different fact, told in a different colour.
    expect(tint).not.toContain("bg-success/5")
  })

  it("keeps ON HOLD red even when the row is packed: a held parcel must never look done", () => {
    const tint = rowTintClass("on_hold", true)
    expect(tint).toContain("bg-error-glow/40")
    expect(tint).toContain("border-l-error")
    expect(tint).not.toContain("bg-surface-hover/60")
    expect(tint).not.toContain("text-text-tertiary")
  })

  it("separates validated from packed: validated stays green, packed greys it", () => {
    expect(rowTintClass("validated", false)).toContain("bg-success/5")
    expect(rowTintClass("validated", true)).toContain("bg-surface-hover/60")
    expect(rowTintClass("validated", true)).not.toContain("bg-success/5")
    // The packed argument is optional: every pre-existing caller keeps its old answer.
    expect(rowTintClass("validated")).toBe(rowTintClass("validated", false))
  })
})

describe("keepUnchangedRows: a background refresh keeps unchanged rows by identity", () => {
  it("reuses the previous object for a row whose data did not change, takes the fresh one otherwise", () => {
    const a = shippableRow({ order_key: "so:1" })
    const b = shippableRow({ order_key: "so:2" })
    // A refresh returns NEW objects for every row, one of them changed.
    const freshA = structuredClone(a)
    const freshB = { ...structuredClone(b), status: "on_hold" as const }
    const freshC = shippableRow({ order_key: "so:3" })
    const out = keepUnchangedRows([a, b], [freshC, freshA, freshB], (r) => r.order_key)
    expect(out.map((r) => r.order_key)).toEqual(["so:3", "so:1", "so:2"])
    expect(out[1]).toBe(a)
    expect(out[2]).toBe(freshB)
    expect(out[0]).toBe(freshC)
  })

  it("a row re-read with nothing changed keeps its object through mergeRows too", () => {
    const a = shippableRow({ order_key: "so:1" })
    const out = mergeRows([a], [structuredClone(a)], ["so:1"])
    expect(out[0]).toBe(a)
  })
})

describe("mergeRows: a patch leaves every other row referentially identical", () => {
  it("swaps only the patched row object and keeps the others by identity", () => {
    const a = shippableRow({ order_key: "so:1" })
    const b = shippableRow({ order_key: "so:2" })
    const c = shippableRow({ order_key: "so:3" })
    const patched = { ...b, status: "validated" as const }
    const out = mergeRows([a, b, c], [patched], ["so:2"])
    expect(out).toHaveLength(3)
    expect(out[0]).toBe(a)
    expect(out[2]).toBe(c)
    expect(out[1]).toBe(patched)
    expect(out[1]!.status).toBe("validated")
  })

  it("drops a row that was asked for and came back gone (excluded, fulfilled)", () => {
    const a = shippableRow({ order_key: "so:1" })
    const b = shippableRow({ order_key: "so:2" })
    const out = mergeRows([a, b], [], ["so:2"])
    expect(out.map((r) => r.order_key)).toEqual(["so:1"])
    expect(out[0]).toBe(a)
  })

  it("adds a row the list did not have yet (Add shipment) without touching the rest", () => {
    const a = shippableRow({ order_key: "so:1" })
    const fresh = shippableRow({ order_key: "doc:prof-9" })
    const out = mergeRows([a], [fresh], ["doc:prof-9"])
    expect(out.map((r) => r.order_key)).toEqual(["doc:prof-9", "so:1"])
    expect(out[1]).toBe(a)
  })
})

describe("copy discipline", () => {
  it("uses no dash punctuation in any operator-facing string in this module", () => {
    const src = readFileSync(new URL("./prep-row-logic.ts", import.meta.url), "utf8")
    const strings = src.match(/"[^"\n]*"/g) ?? []
    const offenders = strings.filter((s) => /—|–|\s--\s/.test(s))
    expect(offenders).toEqual([])
  })

  it("labels every status and category in the operator's words", () => {
    expect(STATUS_LABELS).toEqual({ to_prepare: "To prepare", validated: "Validated", on_hold: "On hold" })
    expect(CATEGORY_LABELS).toEqual({ sale: "Sale", repair: "Return after repair", gift: "Sample" })
    // The prep grid's select renders the SHORT forms (its column is paid for by the
    // Document column beside it) with the full wording on the control's title. Every
    // short form must be no longer than "Sample", and categoryFullLabel must recover
    // the long one for the tooltip, including for the legacy "return" value.
    expect(CATEGORY_SHORT_LABELS).toEqual({ sale: "Sale", repair: "Repair", gift: "Sample" })
    for (const [k, v] of Object.entries(CATEGORY_SHORT_LABELS)) {
      expect(v.length, `short label for ${k}`).toBeLessThanOrEqual("Sample".length)
    }
    expect(categoryFullLabel("repair")).toBe("Return after repair")
    expect(categoryFullLabel("sale")).toBe("Sale")
    expect(categoryFullLabel("gift")).toBe("Sample")
    expect(categoryFullLabel("return")).toBe("Return")
  })
})
